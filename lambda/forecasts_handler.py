"""
Forecasts Handler
-----------------
Minimal read-through for CE-based forecasts tied to scopes.

Routes:
  GET /forecasts?scopeId=&period=          list cached forecasts for (scopeId, period)
  POST /forecasts/{scopeId}/{period}       refresh a forecast (admin) — calls
                                           Cost Explorer GetCostForecast filtered
                                           to the scope's effective accounts and
                                           stores the result.

Phase 1 ships with CE_FORECAST only. LINEAR, PRIOR_PERIOD, MANUAL land later.
"""

from __future__ import annotations

import os
import json
import logging
from decimal import Decimal
from datetime import datetime, date, timezone, timedelta

import boto3
from boto3.dynamodb.conditions import Key

from common.roles import require_admin, PermissionDenied, forbidden_response
from common.orgs  import payer_session, expand_accounts_for_scope

logger = logging.getLogger()
logger.setLevel(os.environ.get('LOG_LEVEL', 'INFO'))

FORECASTS_TABLE = os.environ.get('FORECASTS_TABLE', 'kostops-forecasts')
SCOPES_TABLE    = os.environ.get('SCOPES_TABLE',    'kostops-scopes')
AWS_REGION      = os.environ.get('AWS_REGION',      'us-east-1')

_ddb           = boto3.resource('dynamodb', region_name=AWS_REGION)
_forecasts     = _ddb.Table(FORECASTS_TABLE)
_scopes        = _ddb.Table(SCOPES_TABLE)


def _cors(status: int, body) -> dict:
    return {
        'statusCode': status,
        'headers': {
            'Content-Type':                'application/json',
            'Access-Control-Allow-Origin': '*',
        },
        'body': json.dumps(body, default=str),
    }


def _period_to_dates(period: str) -> tuple[date, date]:
    """Return (start, end_exclusive) for a period string YYYY-MM or YYYY-Qn."""
    if 'Q' in period:
        year  = int(period[:4])
        q     = int(period[-1])
        start = date(year, (q - 1) * 3 + 1, 1)
        end   = date(year + (q // 4), ((q * 3) % 12) + 1, 1)
        return start, end
    year, month = period.split('-')
    y, m = int(year), int(month)
    start = date(y, m, 1)
    end   = date(y + (1 if m == 12 else 0), 1 if m == 12 else m + 1, 1)
    return start, end


def _list_forecasts(query: dict) -> dict:
    scope_id = (query.get('scopeId') or '').strip()
    period   = (query.get('period')  or '').strip()
    if not scope_id or not period:
        return _cors(400, {'error': 'scopeId and period query params are required'})

    resp = _forecasts.query(
        KeyConditionExpression=Key('scopeId').eq(scope_id) & Key('sk').begins_with(f'{period}#'),
    )
    return _cors(200, {'scopeId': scope_id, 'period': period, 'forecasts': resp.get('Items', [])})


def _refresh_ce_forecast(event: dict, scope_id: str, period: str) -> dict:
    scope_resp = _scopes.get_item(Key={'scopeId': scope_id})
    scope = scope_resp.get('Item')
    if not scope:
        return _cors(404, {'error': f'Scope not found: {scope_id}'})

    try:
        start, end = _period_to_dates(period)
    except Exception:
        return _cors(400, {'error': 'period must be YYYY-MM or YYYY-Qn'})

    # CE GetCostForecast requires a future window. If the period is entirely
    # in the past, surface a clear message; UI can still show historical
    # actuals separately.
    today = date.today()
    if end <= today:
        return _cors(400, {'error': f'Forecast window {start} → {end} is in the past'})
    start_used = max(start, today + timedelta(days=1))

    session = payer_session()
    if not session:
        return _cors(503, {'error': 'Payer cross-account role not configured'})
    ce = session.client('ce', region_name='us-east-1')  # CE is us-east-1

    accounts = expand_accounts_for_scope(scope)
    filter_expr = {'Dimensions': {'Key': 'LINKED_ACCOUNT', 'Values': accounts}} if accounts else None

    try:
        kwargs = {
            'TimePeriod':   {'Start': start_used.isoformat(), 'End': end.isoformat()},
            'Metric':       'UNBLENDED_COST',
            'Granularity':  'MONTHLY',
        }
        if filter_expr:
            kwargs['Filter'] = filter_expr
        resp = ce.get_cost_forecast(**kwargs)
    except Exception as e:
        logger.error(f'get_cost_forecast failed: {e}')
        return _cors(502, {'error': f'Cost Explorer forecast failed: {e}'})

    amount = float((resp.get('Total') or {}).get('Amount') or 0)
    now    = datetime.now(timezone.utc).isoformat()
    item = {
        'scopeId':      scope_id,
        'sk':           f'{period}#CE_FORECAST',
        'period':       period,
        'sourceMethod': 'CE_FORECAST',
        'amountUsd':    Decimal(str(round(amount, 2))),
        'generatedAt':  now,
        'inputs':       {
            'windowStart': start_used.isoformat(),
            'windowEnd':   end.isoformat(),
            'accountCount': len(accounts),
        },
    }
    _forecasts.put_item(Item=item)
    return _cors(200, item)


def handler(event: dict, context) -> dict:
    method  = event.get('httpMethod', 'GET')
    path    = event.get('path', '')
    path_sp = event.get('pathParameters') or {}
    query   = event.get('queryStringParameters') or {}

    try:
        _body = json.loads(event.get('body') or '{}')
    except json.JSONDecodeError:
        return _cors(400, {'error': 'Invalid JSON body'})

    logger.info(f'forecasts | {method} {path}')

    if method == 'GET' and path.endswith('/forecasts'):
        return _list_forecasts(query)

    if method == 'POST' and path_sp.get('scopeId') and path_sp.get('period'):
        try:
            require_admin(event)
        except PermissionDenied:
            return forbidden_response()
        return _refresh_ce_forecast(event, path_sp['scopeId'], path_sp['period'])

    return _cors(405, {'error': f'Method {method} not supported on this path'})
