"""
Scopes Handler
--------------
CRUD + resolver for Scope records (Budget Agent).

Routes:
  GET    /scopes                             list (viewer)
  POST   /scopes                             create (admin)
  GET    /scopes/{scopeId}                   fetch one (viewer)
  PUT    /scopes/{scopeId}                   update (admin)
  DELETE /scopes/{scopeId}                   soft-delete (admin)
  GET    /scopes/{scopeId}/effective-accounts  expand OU + include/exclude (viewer)

Scope types (hybrid model):
  ACCOUNT — includeAccountIds[] verbatim
  OU      — ouIds[] + optional include/exclude overrides (expand via Organizations)
  TEAM    — same resolver as OU but named (hybrid: OU default + overrides)
  CUSTOM  — arbitrary include/exclude bag

All mutations write an AuditEvents row (entityType="Scope").
"""

from __future__ import annotations

import os
import json
import uuid
import logging
from datetime import datetime, timezone

import boto3
from boto3.dynamodb.conditions import Attr

from common.roles import require_admin, PermissionDenied, forbidden_response
from common.audit import write_audit
from common.orgs  import expand_accounts_for_scope

logger = logging.getLogger()
logger.setLevel(os.environ.get('LOG_LEVEL', 'INFO'))

SCOPES_TABLE = os.environ.get('SCOPES_TABLE', 'kostops-scopes')
AWS_REGION   = os.environ.get('AWS_REGION',   'us-east-1')

_ddb   = boto3.resource('dynamodb', region_name=AWS_REGION)
_table = _ddb.Table(SCOPES_TABLE)

VALID_TYPES  = {'ACCOUNT', 'OU', 'TEAM', 'CUSTOM'}
VALID_STATUS = {'active', 'archived'}


def _cors(status: int, body) -> dict:
    return {
        'statusCode': status,
        'headers': {
            'Content-Type':                'application/json',
            'Access-Control-Allow-Origin': '*',
        },
        'body': json.dumps(body, default=str),
    }


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _actor_sub(event: dict) -> str:
    return (
        event.get('requestContext', {})
             .get('authorizer', {})
             .get('claims', {})
             .get('sub', 'anonymous')
    )


def _validate(body: dict, *, creating: bool) -> tuple[dict, str]:
    """Returns (cleaned, error). error == '' means valid."""
    name       = (body.get('name') or '').strip()
    scope_type = (body.get('scopeType') or 'TEAM').upper()
    if creating and not name:
        return {}, 'name is required'
    if scope_type not in VALID_TYPES:
        return {}, f'scopeType must be one of {sorted(VALID_TYPES)}'

    ou_ids                 = [s.strip() for s in body.get('ouIds', []) or [] if isinstance(s, str) and s.strip()]
    include_account_ids    = [s.strip() for s in body.get('includeAccountIds', []) or [] if isinstance(s, str) and s.strip()]
    exclude_account_ids    = [s.strip() for s in body.get('excludeAccountIds', []) or [] if isinstance(s, str) and s.strip()]
    parent_scope_id        = (body.get('parentScopeId') or '').strip() or None

    if scope_type == 'ACCOUNT' and not include_account_ids:
        return {}, 'ACCOUNT scopes must have at least one includeAccountIds entry'
    if scope_type in {'OU', 'TEAM'} and not (ou_ids or include_account_ids):
        return {}, f'{scope_type} scopes require ouIds or includeAccountIds'

    return {
        'name':                name,
        'scopeType':           scope_type,
        'ouIds':               ou_ids,
        'includeAccountIds':   include_account_ids,
        'excludeAccountIds':   exclude_account_ids,
        'parentScopeId':       parent_scope_id,
    }, ''


def _list_scopes(query: dict) -> dict:
    status = (query.get('status') or 'active').lower()
    resp = _table.scan(
        FilterExpression=Attr('status').eq(status) if status in VALID_STATUS else Attr('status').exists(),
        Limit=500,
    )
    items = resp.get('Items', [])
    items.sort(key=lambda s: (s.get('name') or '').lower())
    return _cors(200, {'scopes': items, 'count': len(items)})


def _get_scope(scope_id: str, include_effective: bool = False) -> dict:
    resp = _table.get_item(Key={'scopeId': scope_id})
    item = resp.get('Item')
    if not item:
        return _cors(404, {'error': f'Scope not found: {scope_id}'})
    if include_effective:
        item['effectiveAccountIds'] = expand_accounts_for_scope(item)
    return _cors(200, item)


def _effective_accounts(scope_id: str) -> dict:
    resp = _table.get_item(Key={'scopeId': scope_id})
    item = resp.get('Item')
    if not item:
        return _cors(404, {'error': f'Scope not found: {scope_id}'})
    accounts = expand_accounts_for_scope(item)
    return _cors(200, {'scopeId': scope_id, 'accountIds': accounts, 'count': len(accounts)})


def _create_scope(event: dict, body: dict) -> dict:
    cleaned, err = _validate(body, creating=True)
    if err:
        return _cors(400, {'error': err})

    scope_id = f"sc_{uuid.uuid4().hex[:12]}"
    now = _now()
    item = {
        **cleaned,
        'scopeId':   scope_id,
        'status':    'active',
        'ownerSub':  _actor_sub(event),
        'createdAt': now,
        'updatedAt': now,
        'updatedBy': _actor_sub(event),
    }
    _table.put_item(Item=item, ConditionExpression='attribute_not_exists(scopeId)')

    write_audit(
        event,
        action='CREATE',
        entity_type='Scope',
        entity_id=scope_id,
        before=None,
        after=item,
        source='UI',
    )
    return _cors(201, item)


def _update_scope(event: dict, scope_id: str, body: dict) -> dict:
    prior_resp = _table.get_item(Key={'scopeId': scope_id})
    prior = prior_resp.get('Item')
    if not prior:
        return _cors(404, {'error': f'Scope not found: {scope_id}'})

    cleaned, err = _validate(body, creating=False)
    if err:
        return _cors(400, {'error': err})

    updates = {}
    if body.get('name'):
        updates['name'] = cleaned['name']
    # scopeType may change; always honour cleaned value as it passed validation
    updates['scopeType']         = cleaned['scopeType']
    updates['ouIds']             = cleaned['ouIds']
    updates['includeAccountIds'] = cleaned['includeAccountIds']
    updates['excludeAccountIds'] = cleaned['excludeAccountIds']
    if cleaned['parentScopeId']:
        updates['parentScopeId'] = cleaned['parentScopeId']

    now = _now()
    expr_names:  dict[str, str] = {}
    expr_values: dict[str, object] = {':updatedAt': now, ':updatedBy': _actor_sub(event)}
    sets = ['updatedAt = :updatedAt', 'updatedBy = :updatedBy']
    for k, v in updates.items():
        nk, vk = f'#{k}', f':{k}'
        expr_names[nk] = k
        expr_values[vk] = v
        sets.append(f'{nk} = {vk}')

    resp = _table.update_item(
        Key={'scopeId': scope_id},
        UpdateExpression='SET ' + ', '.join(sets),
        ExpressionAttributeNames=expr_names or None,
        ExpressionAttributeValues=expr_values,
        ConditionExpression='attribute_exists(scopeId)',
        ReturnValues='ALL_NEW',
    )
    after = resp.get('Attributes', {})

    write_audit(
        event,
        action='UPDATE',
        entity_type='Scope',
        entity_id=scope_id,
        before={k: prior.get(k) for k in updates.keys()},
        after={k: after.get(k)  for k in updates.keys()},
        source='UI',
    )
    return _cors(200, after)


def _delete_scope(event: dict, scope_id: str) -> dict:
    # Soft-delete: status -> archived. Retain history for audit + rollup queries.
    prior_resp = _table.get_item(Key={'scopeId': scope_id})
    prior = prior_resp.get('Item')
    if not prior:
        return _cors(404, {'error': f'Scope not found: {scope_id}'})

    now = _now()
    _table.update_item(
        Key={'scopeId': scope_id},
        UpdateExpression='SET #s = :archived, updatedAt = :updatedAt, updatedBy = :updatedBy',
        ExpressionAttributeNames={'#s': 'status'},
        ExpressionAttributeValues={
            ':archived':  'archived',
            ':updatedAt': now,
            ':updatedBy': _actor_sub(event),
        },
        ConditionExpression='attribute_exists(scopeId)',
    )

    write_audit(
        event,
        action='ARCHIVE',
        entity_type='Scope',
        entity_id=scope_id,
        before={'status': prior.get('status', 'active')},
        after={'status': 'archived'},
        source='UI',
    )
    return _cors(200, {'scopeId': scope_id, 'status': 'archived'})


def handler(event: dict, context) -> dict:
    method   = event.get('httpMethod', 'GET')
    path     = event.get('path', '')
    path_sp  = event.get('pathParameters') or {}
    query    = event.get('queryStringParameters') or {}
    scope_id = path_sp.get('scopeId', '')

    try:
        body = json.loads(event.get('body') or '{}')
    except json.JSONDecodeError:
        return _cors(400, {'error': 'Invalid JSON body'})

    logger.info(f'scopes | {method} {path} | scopeId={scope_id}')

    # Reads — any authenticated user
    if method == 'GET' and scope_id and path.endswith('/effective-accounts'):
        return _effective_accounts(scope_id)
    if method == 'GET' and scope_id:
        return _get_scope(scope_id, include_effective=(query.get('include') == 'effective'))
    if method == 'GET' and not scope_id:
        return _list_scopes(query)

    # Writes — admin only
    try:
        require_admin(event)
    except PermissionDenied:
        return forbidden_response()

    if method == 'POST'   and not scope_id: return _create_scope(event, body)
    if method == 'PUT'    and scope_id:     return _update_scope(event, scope_id, body)
    if method == 'DELETE' and scope_id:     return _delete_scope(event, scope_id)

    return _cors(405, {'error': f'Method {method} not supported on this path'})
