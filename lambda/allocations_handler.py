"""
Allocations Handler
-------------------
Shared-account cost allocation rules for the Budget Agent (Phase 3).

Why this exists:
  Platform / networking / data-lake accounts are "shared" — their cost doesn't
  belong to one team. FinOps.org's allocation patterns let admins split that
  cost across consuming teams by explicit rule so variance dashboards show
  each team's full economic picture, not just what shows up under its OU.

Schema (kostops-allocation-rules, defined in stacks/data-stack.ts):
  pk: sourceAccountId        12-digit AWS account id that OWNS the cost
  sk: ruleId                 "r_<uuid12>"
  ruleType:                  PERCENTAGE (MVP) | DIRECT | FIXED_SPLIT |
                             USAGE_BASED | MANUAL  (others stubbed)
  splits: [                  list of targets, summing to 100 for PERCENTAGE
    {targetScopeId, pct, tagFilter?}
  ]
  effectiveFrom, effectiveTo ISO dates; rule applies inside the window.
  status:                    active | archived
  note, createdBy, createdAt, updatedBy, updatedAt

Routes:
  GET    /allocations                             list (viewer)
  POST   /allocations                             create (admin)
  GET    /allocations/{ruleId}                    fetch one (viewer)
  PUT    /allocations/{ruleId}                    update (admin)
  DELETE /allocations/{ruleId}                    soft-delete (admin)
  POST   /allocations/{ruleId}/preview            preview impact (admin)

All mutations emit AuditEvents entityType="AllocationRule".
"""

from __future__ import annotations

import os
import json
import time
import uuid
import logging
from decimal import Decimal
from datetime import datetime, timezone

import boto3
from boto3.dynamodb.conditions import Attr, Key

from common.roles import require_admin, PermissionDenied, forbidden_response
from common.audit import write_audit

logger = logging.getLogger()
logger.setLevel(os.environ.get('LOG_LEVEL', 'INFO'))

ALLOCATIONS_TABLE = os.environ.get('ALLOCATIONS_TABLE', 'kostops-allocation-rules')
SCOPES_TABLE      = os.environ.get('SCOPES_TABLE',      'kostops-scopes')
ATHENA_WORKGROUP  = os.environ.get('ATHENA_WORKGROUP',  'kostops-workgroup')
GLUE_DATABASE     = os.environ.get('GLUE_DATABASE',     'kostops_cur')
CUR_TABLE         = os.environ.get('CUR_TABLE',         'data')
AWS_REGION        = os.environ.get('AWS_REGION',        'us-east-1')

_ddb     = boto3.resource('dynamodb', region_name=AWS_REGION)
_table   = _ddb.Table(ALLOCATIONS_TABLE)
_scopes  = _ddb.Table(SCOPES_TABLE)
_athena  = boto3.client('athena', region_name=AWS_REGION)

VALID_RULE_TYPES = {'PERCENTAGE', 'DIRECT', 'FIXED_SPLIT', 'USAGE_BASED', 'MANUAL'}
VALID_STATUS     = {'active', 'archived'}


# ── Helpers ───────────────────────────────────────────────────────────────────

def _cors(status: int, body) -> dict:
    return {
        'statusCode': status,
        'headers': {
            'Content-Type':                'application/json',
            'Access-Control-Allow-Origin': '*',
        },
        'body': json.dumps(body, default=_json_default),
    }


def _json_default(v):
    if isinstance(v, Decimal):
        return float(v)
    if isinstance(v, datetime):
        return v.isoformat()
    raise TypeError(repr(v))


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _actor_sub(event: dict) -> str:
    return (
        event.get('requestContext', {})
             .get('authorizer', {})
             .get('claims', {})
             .get('sub', 'anonymous')
    )


def _to_ddb(value):
    if isinstance(value, float):
        return Decimal(str(value))
    if isinstance(value, dict):
        return {k: _to_ddb(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_to_ddb(v) for v in value]
    return value


# ── Validation ───────────────────────────────────────────────────────────────

def _validate(body: dict, *, creating: bool) -> tuple[dict, str]:
    source_account_id = (body.get('sourceAccountId') or '').strip()
    rule_type         = (body.get('ruleType') or 'PERCENTAGE').upper()
    splits_in         = body.get('splits') or []
    effective_from    = (body.get('effectiveFrom') or '').strip()
    effective_to      = (body.get('effectiveTo') or '').strip() or None
    note              = (body.get('note') or '').strip()[:512]

    if creating and not source_account_id.isdigit():
        return {}, 'sourceAccountId must be a 12-digit AWS account id'
    if rule_type not in VALID_RULE_TYPES:
        return {}, f'ruleType must be one of {sorted(VALID_RULE_TYPES)}'
    if rule_type in {'DIRECT', 'FIXED_SPLIT', 'USAGE_BASED'}:
        # Not implemented yet — surface clearly so the admin/agent knows why.
        return {}, f'ruleType {rule_type} is not yet supported (Phase 3 ships PERCENTAGE + MANUAL)'

    cleaned_splits: list[dict] = []
    pct_sum = 0.0
    for i, s in enumerate(splits_in):
        tid = (s.get('targetScopeId') or '').strip()
        try:
            pct = float(s.get('pct'))
        except (TypeError, ValueError):
            return {}, f'split[{i}].pct must be a number'
        if not tid:
            return {}, f'split[{i}].targetScopeId is required'
        if pct < 0 or pct > 100:
            return {}, f'split[{i}].pct must be between 0 and 100'
        cleaned_splits.append({'targetScopeId': tid, 'pct': round(pct, 4)})
        pct_sum += pct

    if rule_type == 'PERCENTAGE':
        if abs(pct_sum - 100.0) > 0.01:
            return {}, f'PERCENTAGE splits must sum to 100 (got {pct_sum:.2f})'

    return {
        'sourceAccountId': source_account_id,
        'ruleType':        rule_type,
        'splits':          cleaned_splits,
        'effectiveFrom':   effective_from,
        'effectiveTo':     effective_to,
        'note':            note,
    }, ''


# ── Reads ─────────────────────────────────────────────────────────────────────

def _list(query: dict) -> dict:
    status = (query.get('status') or 'active').lower()
    source_account_id = (query.get('sourceAccountId') or '').strip()

    if source_account_id:
        resp = _table.query(
            KeyConditionExpression=Key('sourceAccountId').eq(source_account_id),
            FilterExpression=Attr('status').eq(status),
        )
    else:
        resp = _table.scan(
            FilterExpression=Attr('status').eq(status),
            Limit=500,
        )
    items = resp.get('Items', [])
    items.sort(key=lambda r: (r.get('sourceAccountId', ''), r.get('createdAt', '')))
    return _cors(200, {'rules': items, 'count': len(items)})


def _get(rule_id: str, source_account_id: str) -> dict:
    if not source_account_id:
        # Scan by sk=ruleId; small table so this is fine for MVP.
        resp = _table.scan(
            FilterExpression=Attr('ruleId').eq(rule_id),
            Limit=2,
        )
        items = resp.get('Items', [])
        if not items:
            return _cors(404, {'error': f'Rule not found: {rule_id}'})
        return _cors(200, items[0])
    resp = _table.get_item(Key={'sourceAccountId': source_account_id, 'ruleId': rule_id})
    item = resp.get('Item')
    if not item:
        return _cors(404, {'error': f'Rule not found: {rule_id}'})
    return _cors(200, item)


# ── Writes ────────────────────────────────────────────────────────────────────

def _create(event: dict, body: dict) -> dict:
    cleaned, err = _validate(body, creating=True)
    if err:
        return _cors(400, {'error': err})

    rule_id = f'r_{uuid.uuid4().hex[:12]}'
    now     = _now()
    item = _to_ddb({
        **cleaned,
        'ruleId':     rule_id,
        'status':     'active',
        'createdBy':  _actor_sub(event),
        'createdAt':  now,
        'updatedBy':  _actor_sub(event),
        'updatedAt':  now,
    })
    _table.put_item(Item=item, ConditionExpression='attribute_not_exists(ruleId)')

    write_audit(
        event,
        action='CREATE',
        entity_type='AllocationRule',
        entity_id=rule_id,
        before=None,
        after={'sourceAccountId': cleaned['sourceAccountId'],
               'ruleType':        cleaned['ruleType'],
               'splits':          cleaned['splits']},
        source='UI',
    )
    return _cors(201, _json_ready(item))


def _update(event: dict, rule_id: str, body: dict) -> dict:
    # Find source account for the composite key.
    scan = _table.scan(FilterExpression=Attr('ruleId').eq(rule_id), Limit=2)
    items = scan.get('Items', [])
    if not items:
        return _cors(404, {'error': f'Rule not found: {rule_id}'})
    prior = items[0]
    source_account_id = prior['sourceAccountId']

    cleaned, err = _validate({**body, 'sourceAccountId': source_account_id}, creating=False)
    if err:
        return _cors(400, {'error': err})

    now = _now()
    updates = {
        'ruleType':       cleaned['ruleType'],
        'splits':         cleaned['splits'],
        'effectiveFrom':  cleaned['effectiveFrom'],
        'effectiveTo':    cleaned['effectiveTo'],
        'note':           cleaned['note'],
        'updatedAt':      now,
        'updatedBy':      _actor_sub(event),
    }
    expr_names:  dict[str, str]    = {}
    expr_values: dict[str, object] = {}
    sets: list[str] = []
    for k, v in updates.items():
        if v is None:
            continue
        nk, vk = f'#{k}', f':{k}'
        expr_names[nk]  = k
        expr_values[vk] = _to_ddb(v)
        sets.append(f'{nk} = {vk}')

    resp = _table.update_item(
        Key={'sourceAccountId': source_account_id, 'ruleId': rule_id},
        UpdateExpression='SET ' + ', '.join(sets),
        ExpressionAttributeNames=expr_names,
        ExpressionAttributeValues=expr_values,
        ConditionExpression='attribute_exists(ruleId)',
        ReturnValues='ALL_NEW',
    )
    after = resp.get('Attributes', {})

    write_audit(
        event,
        action='UPDATE',
        entity_type='AllocationRule',
        entity_id=rule_id,
        before={k: prior.get(k) for k in ('ruleType', 'splits', 'effectiveFrom', 'effectiveTo')},
        after={k: after.get(k)  for k in ('ruleType', 'splits', 'effectiveFrom', 'effectiveTo')},
        source='UI',
    )
    return _cors(200, _json_ready(after))


def _archive(event: dict, rule_id: str) -> dict:
    scan = _table.scan(FilterExpression=Attr('ruleId').eq(rule_id), Limit=2)
    items = scan.get('Items', [])
    if not items:
        return _cors(404, {'error': f'Rule not found: {rule_id}'})
    prior = items[0]

    now = _now()
    _table.update_item(
        Key={'sourceAccountId': prior['sourceAccountId'], 'ruleId': rule_id},
        UpdateExpression='SET #s = :archived, updatedAt = :updatedAt, updatedBy = :updatedBy',
        ExpressionAttributeNames={'#s': 'status'},
        ExpressionAttributeValues={
            ':archived':  'archived',
            ':updatedAt': now,
            ':updatedBy': _actor_sub(event),
        },
        ConditionExpression='attribute_exists(ruleId)',
    )
    write_audit(
        event,
        action='ARCHIVE',
        entity_type='AllocationRule',
        entity_id=rule_id,
        before={'status': prior.get('status', 'active')},
        after={'status': 'archived'},
        source='UI',
    )
    return _cors(200, {'ruleId': rule_id, 'status': 'archived'})


# ── Preview ──────────────────────────────────────────────────────────────────

def _source_account_cost(source_account_id: str, period: str) -> float:
    """Run Athena for total unblended cost on (account, period). 0 on failure."""
    sql = f"""
        SELECT ROUND(SUM(line_item_unblended_cost), 2) AS total
        FROM {CUR_TABLE}
        WHERE line_item_usage_account_id = '{source_account_id}'
          AND billing_period = '{period}'
          AND line_item_line_item_type NOT IN ('Credit','Refund','Tax')
    """
    try:
        resp = _athena.start_query_execution(
            QueryString=sql,
            QueryExecutionContext={'Database': GLUE_DATABASE},
            WorkGroup=ATHENA_WORKGROUP,
        )
        exec_id = resp['QueryExecutionId']
        for _ in range(40):
            st = _athena.get_query_execution(QueryExecutionId=exec_id)
            state = st['QueryExecution']['Status']['State']
            if state == 'SUCCEEDED':
                break
            if state in ('FAILED', 'CANCELLED'):
                reason = st['QueryExecution']['Status'].get('StateChangeReason', '')
                logger.warning(f'athena preview: {state} {reason}')
                return 0.0
            time.sleep(1.2)
        pages = _athena.get_paginator('get_query_results').paginate(QueryExecutionId=exec_id)
        for page in pages:
            rows = page['ResultSet']['Rows']
            if len(rows) > 1:
                val = rows[1]['Data'][0].get('VarCharValue', '0') or '0'
                return float(val)
        return 0.0
    except Exception as e:
        logger.warning(f'athena preview failed: {e}')
        return 0.0


def _scope_names(ids: list[str]) -> dict[str, str]:
    names: dict[str, str] = {}
    for sid in set(ids):
        try:
            r = _scopes.get_item(Key={'scopeId': sid}).get('Item') or {}
            names[sid] = r.get('name', '')
        except Exception:
            names[sid] = ''
    return names


def _preview(event: dict, rule_id: str, body: dict) -> dict:
    period = (body.get('period') or '').strip()
    if not period:
        return _cors(400, {'error': 'period is required (YYYY-MM or YYYY-Qn)'})

    scan = _table.scan(FilterExpression=Attr('ruleId').eq(rule_id), Limit=2)
    items = scan.get('Items', [])
    if not items:
        return _cors(404, {'error': f'Rule not found: {rule_id}'})
    rule = items[0]

    source_account_id = rule['sourceAccountId']
    splits = rule.get('splits') or []

    # Only PERCENTAGE supported for now — validator blocks creating others.
    total = _source_account_cost(source_account_id, period)

    name_by_scope = _scope_names([s['targetScopeId'] for s in splits])
    projected = []
    for s in splits:
        pct = float(s.get('pct', 0))
        amt = round(total * pct / 100.0, 2)
        projected.append({
            'targetScopeId':   s['targetScopeId'],
            'targetScopeName': name_by_scope.get(s['targetScopeId'], ''),
            'pct':             pct,
            'projectedUsd':    amt,
        })

    return _cors(200, {
        'ruleId':            rule_id,
        'sourceAccountId':   source_account_id,
        'period':            period,
        'sourceTotalUsd':    total,
        'ruleType':          rule.get('ruleType'),
        'projected':         projected,
    })


def _json_ready(item):
    """Decimal -> float so json.dumps works without custom default."""
    if isinstance(item, Decimal):
        return float(item)
    if isinstance(item, dict):
        return {k: _json_ready(v) for k, v in item.items()}
    if isinstance(item, (list, tuple)):
        return [_json_ready(v) for v in item]
    return item


# ── Dispatch ─────────────────────────────────────────────────────────────────

def handler(event: dict, context) -> dict:
    method  = event.get('httpMethod', 'GET')
    path    = event.get('path', '')
    path_sp = event.get('pathParameters') or {}
    query   = event.get('queryStringParameters') or {}
    rule_id = path_sp.get('ruleId', '')

    try:
        body = json.loads(event.get('body') or '{}')
    except json.JSONDecodeError:
        return _cors(400, {'error': 'Invalid JSON body'})

    logger.info(f'allocations | {method} {path} | ruleId={rule_id}')

    # Reads — viewers
    if method == 'GET' and not rule_id:
        return _list(query)
    if method == 'GET' and rule_id:
        return _get(rule_id, (query.get('sourceAccountId') or ''))

    # Writes + preview — admin only
    try:
        require_admin(event)
    except PermissionDenied:
        return forbidden_response()

    if method == 'POST'   and not rule_id:                    return _create(event, body)
    if method == 'PUT'    and rule_id:                        return _update(event, rule_id, body)
    if method == 'DELETE' and rule_id:                        return _archive(event, rule_id)
    if method == 'POST'   and rule_id and path.endswith('/preview'):
        return _preview(event, rule_id, body)

    return _cors(405, {'error': f'Method {method} not supported on this path'})
