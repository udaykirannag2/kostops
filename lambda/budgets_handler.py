"""
Budgets Handler
---------------
Versioned budget CRUD for the Budget Agent.

Routes:
  GET /budgets?scopeId=&period=       current (isCurrent=true) version
  GET /budgets/{scopeId}/history      all versions newest-first (viewer)
  PUT /budgets/{scopeId}/{period}     create a new version (admin); flips the
                                      previous current row's isCurrent to false
                                      in a DynamoDB transaction.

Schema (kostops-budgets):
  pk: scopeId
  sk: "<period>#v<N>"    e.g. "2026-05#v3"  (period = YYYY-MM or YYYY-Qn)
  attrs: amountUsd, granularity (MONTHLY|QUARTERLY), currency='USD',
         createdBy, createdAt, note, isCurrent (boolean), version

All writes emit AuditEvents entityType="Budget".
"""

from __future__ import annotations

import os
import json
import re
import logging
from decimal import Decimal
from datetime import datetime, timezone

import boto3
from boto3.dynamodb.conditions import Key, Attr

from common.roles import require_admin, PermissionDenied, forbidden_response
from common.audit import write_audit

logger = logging.getLogger()
logger.setLevel(os.environ.get('LOG_LEVEL', 'INFO'))

BUDGETS_TABLE = os.environ.get('BUDGETS_TABLE', 'kostops-budgets')
AWS_REGION    = os.environ.get('AWS_REGION',    'us-east-1')

_ddb   = boto3.resource('dynamodb', region_name=AWS_REGION)
_table = _ddb.Table(BUDGETS_TABLE)
_client = boto3.client('dynamodb', region_name=AWS_REGION)   # for TransactWriteItems

_PERIOD_RE = re.compile(r'^\d{4}-(0[1-9]|1[0-2]|Q[1-4])$')


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


def _current_version_item(scope_id: str, period: str) -> dict | None:
    resp = _table.query(
        KeyConditionExpression=Key('scopeId').eq(scope_id) & Key('sk').begins_with(f'{period}#'),
        FilterExpression=Attr('isCurrent').eq(True),
        Limit=1,
    )
    items = resp.get('Items', [])
    return items[0] if items else None


def _get_current(query: dict) -> dict:
    scope_id = (query.get('scopeId') or '').strip()
    period   = (query.get('period')   or '').strip()
    if not scope_id or not period:
        return _cors(400, {'error': 'scopeId and period query params are required'})

    item = _current_version_item(scope_id, period)
    if not item:
        return _cors(404, {'error': f'No budget for {scope_id}/{period}'})
    return _cors(200, item)


def _get_history(scope_id: str) -> dict:
    resp = _table.query(
        KeyConditionExpression=Key('scopeId').eq(scope_id),
        ScanIndexForward=False,   # newest first
        Limit=200,
    )
    return _cors(200, {'scopeId': scope_id, 'versions': resp.get('Items', [])})


def _put_version(event: dict, scope_id: str, period: str, body: dict) -> dict:
    if not _PERIOD_RE.match(period):
        return _cors(400, {'error': 'period must be YYYY-MM or YYYY-Qn'})

    try:
        amount_usd = float(body.get('amountUsd') or body.get('amount') or 0)
    except (TypeError, ValueError):
        return _cors(400, {'error': 'amountUsd must be a number'})
    if amount_usd < 0:
        return _cors(400, {'error': 'amountUsd must be >= 0'})

    granularity = (body.get('granularity') or ('QUARTERLY' if 'Q' in period else 'MONTHLY')).upper()
    if granularity not in {'MONTHLY', 'QUARTERLY'}:
        return _cors(400, {'error': 'granularity must be MONTHLY or QUARTERLY'})

    note = (body.get('note') or '').strip()[:512]

    # Figure out next version number by querying current + counting.
    existing = _table.query(
        KeyConditionExpression=Key('scopeId').eq(scope_id) & Key('sk').begins_with(f'{period}#'),
        Select='COUNT',
    ).get('Count', 0)
    next_version = int(existing) + 1
    new_sk       = f'{period}#v{next_version}'
    now          = _now()

    new_item = {
        'scopeId':     scope_id,
        'sk':          new_sk,
        'period':      period,
        'version':     next_version,
        'amountUsd':   Decimal(str(round(amount_usd, 2))),
        'granularity': granularity,
        'currency':    'USD',
        'createdBy':   _actor_sub(event),
        'createdAt':   now,
        'note':        note,
        'isCurrent':   True,
    }

    # Flip the prior current row (if any) to isCurrent=false, and put the new
    # row with isCurrent=true, atomically.
    prior = _current_version_item(scope_id, period)
    tx_items: list[dict] = []
    if prior:
        tx_items.append({
            'Update': {
                'TableName':        BUDGETS_TABLE,
                'Key':              {'scopeId': {'S': scope_id}, 'sk': {'S': prior['sk']}},
                'UpdateExpression': 'SET isCurrent = :f',
                'ExpressionAttributeValues': {':f': {'BOOL': False}},
                'ConditionExpression': 'attribute_exists(sk)',
            }
        })
    # DynamoDB raw TransactWriteItems needs marshalled types.
    tx_items.append({
        'Put': {
            'TableName': BUDGETS_TABLE,
            'Item': {
                'scopeId':     {'S': scope_id},
                'sk':          {'S': new_sk},
                'period':      {'S': period},
                'version':     {'N': str(next_version)},
                'amountUsd':   {'N': str(round(amount_usd, 2))},
                'granularity': {'S': granularity},
                'currency':    {'S': 'USD'},
                'createdBy':   {'S': new_item['createdBy']},
                'createdAt':   {'S': now},
                'note':        {'S': note},
                'isCurrent':   {'BOOL': True},
            },
            'ConditionExpression': 'attribute_not_exists(sk)',
        }
    })
    try:
        _client.transact_write_items(TransactItems=tx_items)
    except _client.exceptions.TransactionCanceledException as e:
        logger.error(f'budget transaction cancelled: {e}')
        return _cors(409, {'error': 'Concurrent update — retry', 'detail': str(e)[:200]})

    write_audit(
        event,
        action='UPDATE' if prior else 'CREATE',
        entity_type='Budget',
        entity_id=f'{scope_id}#{period}',
        before={'amountUsd': float(prior.get('amountUsd', 0)) if prior else None, 'version': (prior or {}).get('version')},
        after={'amountUsd': amount_usd, 'version': next_version, 'granularity': granularity},
        source='UI',
    )
    return _cors(201, new_item)


def handler(event: dict, context) -> dict:
    method   = event.get('httpMethod', 'GET')
    path     = event.get('path', '')
    path_sp  = event.get('pathParameters') or {}
    query    = event.get('queryStringParameters') or {}
    scope_id = path_sp.get('scopeId', '')
    period   = path_sp.get('period',  '')

    try:
        body = json.loads(event.get('body') or '{}')
    except json.JSONDecodeError:
        return _cors(400, {'error': 'Invalid JSON body'})

    logger.info(f'budgets | {method} {path} | scopeId={scope_id} period={period}')

    if method == 'GET' and scope_id and path.endswith('/history'):
        return _get_history(scope_id)
    if method == 'GET' and not scope_id and not period:
        return _get_current(query)

    if method == 'PUT' and scope_id and period:
        try:
            require_admin(event)
        except PermissionDenied:
            return forbidden_response()
        return _put_version(event, scope_id, period, body)

    return _cors(405, {'error': f'Method {method} not supported on this path'})
