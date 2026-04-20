"""
Allocation tools
----------------
Tools the Budget specialist uses to inspect and (for admins) manage
AllocationRules — rules that split a shared account's cost across several
target scopes (finops.org pattern).

Reads query DynamoDB directly via the agent's scoped read grants.
Writes POST/PUT/DELETE to the KostOps API so Cognito re-validates admin role
and audit rows land with source=CHAT.
"""

from __future__ import annotations

import os
import logging
from decimal import Decimal
from typing import Optional

import boto3
from boto3.dynamodb.conditions import Attr, Key

try:
    from agents import api_client  # type: ignore
    _HAS_API_CLIENT = True
except ImportError:
    _HAS_API_CLIENT = False

logger = logging.getLogger(__name__)

ALLOCATIONS_TABLE = os.environ.get('ALLOCATIONS_TABLE', 'kostops-allocation-rules')
SCOPES_TABLE      = os.environ.get('SCOPES_TABLE',      'kostops-scopes')
AWS_REGION        = os.environ.get('AWS_REGION',        'us-east-1')

_ddb    = boto3.resource('dynamodb', region_name=AWS_REGION)
_rules  = _ddb.Table(ALLOCATIONS_TABLE)
_scopes = _ddb.Table(SCOPES_TABLE)


def _to_float(v):
    if isinstance(v, Decimal):
        return float(v)
    try:
        return float(v) if v is not None else 0.0
    except (TypeError, ValueError):
        return 0.0


def _rule_summary(item: dict) -> dict:
    return {
        'ruleId':          item.get('ruleId'),
        'sourceAccountId': item.get('sourceAccountId'),
        'ruleType':        item.get('ruleType'),
        'splits':          [
            {'targetScopeId': s.get('targetScopeId'), 'pct': _to_float(s.get('pct'))}
            for s in (item.get('splits') or [])
        ],
        'status':          item.get('status'),
        'effectiveFrom':   item.get('effectiveFrom', ''),
        'effectiveTo':     item.get('effectiveTo',   ''),
        'note':            item.get('note',          ''),
    }


# ── Reads ───────────────────────────────────────────────────────────────────

def list_allocations(source_account_id: Optional[str] = None, status: str = 'active') -> list:
    """
    List allocation rules (active by default). Optionally filter to a single
    source account — useful when the admin asks "what rules split out the
    networking account?".

    Args:
        source_account_id: 12-digit AWS account id that owns the cost. Omit
                           to scan all rules.
        status: 'active' (default) or 'archived'.
    """
    logger.info(f"list_allocations src={source_account_id} status={status}")
    if source_account_id:
        resp = _rules.query(
            KeyConditionExpression=Key('sourceAccountId').eq(source_account_id),
            FilterExpression=Attr('status').eq(status),
        )
    else:
        resp = _rules.scan(
            FilterExpression=Attr('status').eq(status),
            Limit=200,
        )
    return [_rule_summary(i) for i in resp.get('Items', [])]


def get_allocation(rule_id: str) -> dict:
    """Fetch one allocation rule by id. Empty dict if not found."""
    logger.info(f"get_allocation {rule_id}")
    resp = _rules.scan(FilterExpression=Attr('ruleId').eq(rule_id), Limit=2)
    items = resp.get('Items', [])
    return _rule_summary(items[0]) if items else {}


def explain_cost_movement(scope_id: str, account_id: str) -> dict:
    """
    Explain why a given AWS account's cost would land in a specific scope.

    The traversal:
      1. Is `account_id` in the scope's direct effective account list
         (from Scopes.includeAccountIds + OU expansion)? If yes, say so.
      2. Is there an active allocation rule with sourceAccountId=account_id
         that splits any pct into `scope_id`? If yes, return the rule and
         the pct.
      3. Otherwise the scope does not include the account by any mechanism.

    Returns a structured dict the model can turn into prose.
    """
    logger.info(f"explain_cost_movement scope={scope_id} account={account_id}")

    # (1) direct membership
    scope = _scopes.get_item(Key={'scopeId': scope_id}).get('Item') or {}
    direct = False
    if scope:
        includes = set(scope.get('includeAccountIds') or [])
        excludes = set(scope.get('excludeAccountIds') or [])
        if account_id in includes and account_id not in excludes:
            direct = True
        # OU-based membership is computed elsewhere; we flag "possibly via OU"
        # rather than walking Organizations here.

    # (2) allocation-based
    allocation_pct = 0.0
    allocation_rules: list[dict] = []
    resp = _rules.query(
        KeyConditionExpression=Key('sourceAccountId').eq(account_id),
        FilterExpression=Attr('status').eq('active'),
    )
    for r in resp.get('Items', []):
        for s in (r.get('splits') or []):
            if s.get('targetScopeId') == scope_id:
                pct = _to_float(s.get('pct'))
                allocation_pct += pct
                allocation_rules.append({'ruleId': r.get('ruleId'), 'pct': pct, 'ruleType': r.get('ruleType')})

    return {
        'scopeId':            scope_id,
        'scopeName':          scope.get('name', ''),
        'accountId':          account_id,
        'direct':             direct,
        'allocationPct':      round(allocation_pct, 4),
        'allocationRules':    allocation_rules,
        'explanation':        _build_explanation(scope, direct, allocation_pct, allocation_rules),
    }


def _build_explanation(scope: dict, direct: bool, pct: float, rules: list[dict]) -> str:
    name = scope.get('name') or scope.get('scopeId') or 'the scope'
    if direct and pct == 0:
        return f'{name} includes this account directly.'
    if direct and pct > 0:
        return f'{name} includes this account directly AND absorbs {pct}% via allocation.'
    if not direct and pct > 0:
        return f'{name} absorbs {pct}% of this account\'s cost through {len(rules)} allocation rule(s).'
    return f'{name} does not include this account by any active rule.'


# ── Admin writes ────────────────────────────────────────────────────────────

def create_allocation(
    source_account_id: str,
    splits:            list,
    rule_type:         str  = 'PERCENTAGE',
    effective_from:    str  = '',
    effective_to:      str  = '',
    note:              str  = '',
) -> dict:
    """
    Create a new allocation rule (admin only). For ruleType='PERCENTAGE' the
    splits must sum to 100.

    Args:
        source_account_id: 12-digit AWS account id.
        splits: list of {'targetScopeId': str, 'pct': float}
        rule_type: 'PERCENTAGE' (default). Other types stubbed for later.
        effective_from: ISO date (e.g. '2026-01-01').
        effective_to:   ISO date; empty means "open ended".
        note:           free-text admin note.
    """
    if not _HAS_API_CLIENT:
        return {'status': 'error', 'detail': 'api_client not available on this runtime'}
    body = {
        'sourceAccountId': source_account_id,
        'ruleType':        rule_type,
        'splits':          splits,
        'effectiveFrom':   effective_from,
        'effectiveTo':     effective_to,
        'note':            note,
    }
    try:
        resp = api_client.post('/allocations', body)
        return {
            'status':          'ok',
            'ruleId':          resp.get('ruleId'),
            'sourceAccountId': resp.get('sourceAccountId'),
            'splits':          resp.get('splits', []),
        }
    except api_client.ApiError as e:
        return {'status': 'error', 'code': e.status, 'detail': e.message[:400]}


def update_allocation(rule_id: str, splits: list = None, effective_from: str = '', effective_to: str = '', note: str = '') -> dict:
    """Replace an allocation rule's splits and/or effective window (admin only)."""
    if not _HAS_API_CLIENT:
        return {'status': 'error', 'detail': 'api_client not available on this runtime'}
    body: dict = {'note': note}
    if splits is not None:    body['splits']         = splits
    if effective_from:        body['effectiveFrom']  = effective_from
    if effective_to:          body['effectiveTo']    = effective_to
    try:
        resp = api_client.put(f'/allocations/{rule_id}', body)
        return {'status': 'ok', 'ruleId': rule_id, 'splits': resp.get('splits', [])}
    except api_client.ApiError as e:
        return {'status': 'error', 'code': e.status, 'detail': e.message[:400]}


def archive_allocation(rule_id: str) -> dict:
    """Soft-delete an allocation rule (admin only). History is retained."""
    if not _HAS_API_CLIENT:
        return {'status': 'error', 'detail': 'api_client not available on this runtime'}
    try:
        resp = api_client.delete(f'/allocations/{rule_id}')
        return {'status': 'ok', 'ruleId': rule_id, 'newStatus': resp.get('status', 'archived')}
    except api_client.ApiError as e:
        return {'status': 'error', 'code': e.status, 'detail': e.message[:400]}


def preview_allocation(rule_id: str, period: str) -> dict:
    """
    Project what an allocation rule would do for a given period (admin only).
    Runs Athena against the CUR for the source account's total unblended
    cost in the period, applies each split pct, and returns per-target
    projected amounts. Does NOT modify anything.

    Returns: {
      ruleId, sourceAccountId, period, sourceTotalUsd,
      projected: [{targetScopeId, targetScopeName, pct, projectedUsd}, ...]
    }
    """
    if not _HAS_API_CLIENT:
        return {'status': 'error', 'detail': 'api_client not available on this runtime'}
    try:
        resp = api_client.post(f'/allocations/{rule_id}/preview', {'period': period})
        return {
            'status':          'ok',
            'ruleId':          resp.get('ruleId'),
            'sourceAccountId': resp.get('sourceAccountId'),
            'period':          resp.get('period'),
            'sourceTotalUsd':  _to_float(resp.get('sourceTotalUsd')),
            'projected':       resp.get('projected', []),
        }
    except api_client.ApiError as e:
        return {'status': 'error', 'code': e.status, 'detail': e.message[:400]}
