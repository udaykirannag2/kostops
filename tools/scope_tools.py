"""
Scope tools
-----------
Read-only tools for the Budget specialist to discover Organizations structure
and resolve scope membership.

All tools run inside the Bedrock AgentCore Runtime. Organizations calls go
through `payer_role.get_payer_session()` (cross-account role the agent role is
trusted to assume). DynamoDB reads go through the agent's default boto3 session
(which has read-only grants for kostops-scopes in agent-stack.ts).

Write operations are intentionally NOT here. Admin-gated writes (create_scope,
update_scope, delete_scope, set_budget, etc.) go through the KostOps API so the
Cognito authorizer can re-validate the role and every mutation produces a
`source=CHAT` audit row. Those tools land in Slice B.2.
"""

from __future__ import annotations

import os
import json
import logging
from typing import Optional

import boto3
from boto3.dynamodb.conditions import Attr

try:
    from payer_role import get_payer_session
except ImportError:
    # Local dev fallback — tests that mock boto3 directly.
    def get_payer_session():  # type: ignore[misc]
        return boto3.Session()

logger = logging.getLogger(__name__)

SCOPES_TABLE = os.environ.get('SCOPES_TABLE', 'kostops-scopes')
AWS_REGION   = os.environ.get('AWS_REGION',   'us-east-1')

_ddb    = boto3.resource('dynamodb', region_name=AWS_REGION)
_scopes = _ddb.Table(SCOPES_TABLE)


def _orgs_client():
    return get_payer_session().client('organizations')


def list_ous(parent_id: Optional[str] = None) -> list:
    """
    List Organizational Units. If parent_id is omitted, walks from the org Root
    and returns every OU in the organization with parent/name metadata.

    Returns: list of {id, name, parentId}
    """
    logger.info(f"list_ous parent={parent_id}")
    orgs = _orgs_client()
    out: list[dict] = []
    if parent_id:
        paginator = orgs.get_paginator('list_organizational_units_for_parent')
        for page in paginator.paginate(ParentId=parent_id):
            for ou in page.get('OrganizationalUnits', []):
                out.append({'id': ou['Id'], 'name': ou['Name'], 'parentId': parent_id})
        return out

    roots = orgs.list_roots().get('Roots', [])
    stack = [r['Id'] for r in roots]
    while stack:
        pid = stack.pop()
        paginator = orgs.get_paginator('list_organizational_units_for_parent')
        for page in paginator.paginate(ParentId=pid):
            for ou in page.get('OrganizationalUnits', []):
                out.append({'id': ou['Id'], 'name': ou['Name'], 'parentId': pid})
                stack.append(ou['Id'])
    out.sort(key=lambda o: o['name'].lower())
    return out


def list_accounts_in_ou(ou_id: str) -> list:
    """
    List direct child AWS accounts of a single OU.

    Args:
        ou_id: Organizations OU id (e.g. "ou-xxxx-yyyy").

    Returns: list of {id, name, email, status}
    """
    logger.info(f"list_accounts_in_ou {ou_id}")
    orgs = _orgs_client()
    out: list[dict] = []
    paginator = orgs.get_paginator('list_accounts_for_parent')
    for page in paginator.paginate(ParentId=ou_id):
        for acct in page.get('Accounts', []):
            out.append({
                'id':     acct['Id'],
                'name':   acct.get('Name', acct['Id']),
                'email':  acct.get('Email', ''),
                'status': acct.get('Status', ''),
            })
    out.sort(key=lambda a: a['name'].lower())
    return out


def list_scopes(status: str = 'active') -> list:
    """
    List KostOps scopes (teams / OU groups / custom account bags).

    Args:
        status: 'active' (default) or 'archived'.

    Returns: list of scope records.
    """
    logger.info(f"list_scopes status={status}")
    resp = _scopes.scan(
        FilterExpression=Attr('status').eq(status),
        Limit=200,
    )
    items = resp.get('Items', [])
    items.sort(key=lambda s: (s.get('name') or '').lower())
    return items


def get_scope(scope_id: str) -> dict:
    """
    Fetch one scope by id. Returns {} if not found.

    Args:
        scope_id: KostOps scope id (e.g. "sc_abc123").
    """
    logger.info(f"get_scope {scope_id}")
    resp = _scopes.get_item(Key={'scopeId': scope_id})
    return resp.get('Item') or {}


def resolve_scope_accounts(scope_id: str) -> dict:
    """
    Expand a scope into its effective AWS account ID list.

    Hybrid resolver semantics:
      ACCOUNT — includeAccountIds verbatim
      OU/TEAM — (⋃ accounts under ouIds) ∪ includeAccountIds \\ excludeAccountIds
      CUSTOM  — includeAccountIds \\ excludeAccountIds

    Returns: {scopeId, accountIds: [...], count}
    """
    logger.info(f"resolve_scope_accounts {scope_id}")
    scope = get_scope(scope_id)
    if not scope:
        return {'scopeId': scope_id, 'accountIds': [], 'count': 0, 'error': 'not found'}

    include  = set(scope.get('includeAccountIds') or [])
    exclude  = set(scope.get('excludeAccountIds') or [])
    ou_ids   = set(scope.get('ouIds') or [])
    stype    = (scope.get('scopeType') or '').upper()

    if stype == 'ACCOUNT':
        accounts = sorted(include - exclude)
    else:
        if ou_ids:
            orgs = _orgs_client()
            for ou_id in ou_ids:
                try:
                    paginator = orgs.get_paginator('list_accounts_for_parent')
                    for page in paginator.paginate(ParentId=ou_id):
                        for a in page.get('Accounts', []):
                            if a.get('Status') == 'ACTIVE':
                                include.add(a['Id'])
                except Exception as e:
                    logger.warning(f"OU expand failed for {ou_id}: {e}")
        accounts = sorted(include - exclude)

    return {'scopeId': scope_id, 'accountIds': accounts, 'count': len(accounts)}
