"""
Budget tools
------------
Read-only tools for the Budget specialist:

  get_current_budget(scope_id, period)      current version of a budget
  list_budget_history(scope_id, limit)      all versions newest-first
  get_forecast(scope_id, period)            cached CE_FORECAST (or LINEAR etc)
  get_variance_summary(scope_id, period)    budget vs current forecast + actuals

Writes (set_budget, start_import, commit_import, set_allocation) go through
the KostOps API via agents/api_client.py so the Cognito authorizer re-validates
admin role and every mutation produces a source=CHAT audit row. Those tools
land in Slice B.2.
"""

from __future__ import annotations

import os
import json
import logging
from decimal import Decimal
from typing import Optional

import boto3
from boto3.dynamodb.conditions import Key, Attr

logger = logging.getLogger(__name__)

BUDGETS_TABLE        = os.environ.get('BUDGETS_TABLE',       'kostops-budgets')
FORECASTS_TABLE      = os.environ.get('FORECASTS_TABLE',     'kostops-forecasts')
SCOPE_ACTUALS_TABLE  = os.environ.get('SCOPE_ACTUALS_TABLE', 'kostops-scope-actuals')
AWS_REGION           = os.environ.get('AWS_REGION',          'us-east-1')

_ddb           = boto3.resource('dynamodb', region_name=AWS_REGION)
_budgets       = _ddb.Table(BUDGETS_TABLE)
_forecasts     = _ddb.Table(FORECASTS_TABLE)
_scope_actuals = _ddb.Table(SCOPE_ACTUALS_TABLE)


def _to_float(v) -> float:
    if isinstance(v, Decimal):
        return float(v)
    try:
        return float(v) if v is not None else 0.0
    except (TypeError, ValueError):
        return 0.0


def get_current_budget(scope_id: str, period: str) -> dict:
    """
    Return the currently-authoritative budget for a scope/period.

    Args:
        scope_id: KostOps scope id.
        period:   'YYYY-MM' or 'YYYY-Qn' (e.g. "2026-05", "2026-Q2").

    Returns: budget record with amountUsd, granularity, version, createdBy,
             createdAt. Empty dict if no budget has been set for this period.
    """
    logger.info(f"get_current_budget {scope_id}/{period}")
    resp = _budgets.query(
        KeyConditionExpression=Key('scopeId').eq(scope_id) & Key('sk').begins_with(f'{period}#'),
        FilterExpression=Attr('isCurrent').eq(True),
        Limit=1,
    )
    items = resp.get('Items', [])
    if not items:
        return {}
    b = items[0]
    return {
        'scopeId':     b.get('scopeId'),
        'period':      b.get('period'),
        'version':     int(b.get('version') or 0),
        'amountUsd':   _to_float(b.get('amountUsd')),
        'granularity': b.get('granularity', ''),
        'createdBy':   b.get('createdBy', ''),
        'createdAt':   b.get('createdAt', ''),
        'note':        b.get('note', ''),
    }


def list_budget_history(scope_id: str, limit: int = 50) -> list:
    """
    Return all budget versions for a scope, newest first.

    Args:
        scope_id: KostOps scope id.
        limit:    max rows to return (default 50).
    """
    logger.info(f"list_budget_history {scope_id} limit={limit}")
    resp = _budgets.query(
        KeyConditionExpression=Key('scopeId').eq(scope_id),
        ScanIndexForward=False,
        Limit=min(max(1, int(limit)), 200),
    )
    out = []
    for b in resp.get('Items', []):
        out.append({
            'period':      b.get('period'),
            'version':     int(b.get('version') or 0),
            'amountUsd':   _to_float(b.get('amountUsd')),
            'granularity': b.get('granularity', ''),
            'isCurrent':   bool(b.get('isCurrent', False)),
            'createdBy':   b.get('createdBy', ''),
            'createdAt':   b.get('createdAt', ''),
            'note':        b.get('note', ''),
        })
    return out


def get_forecast(scope_id: str, period: str, source_method: str = 'CE_FORECAST') -> dict:
    """
    Return a cached forecast for (scope, period) produced earlier by an admin
    refresh. Does not trigger a fresh Cost Explorer call — POST to
    /forecasts/{scopeId}/{period} (admin) refreshes the cache.

    Args:
        scope_id: KostOps scope id.
        period:   'YYYY-MM' or 'YYYY-Qn'.
        source_method: 'CE_FORECAST' (default). 'LINEAR' / 'PRIOR_PERIOD' /
                       'MANUAL' land in later phases.
    """
    logger.info(f"get_forecast {scope_id}/{period}/{source_method}")
    resp = _forecasts.get_item(Key={'scopeId': scope_id, 'sk': f'{period}#{source_method}'})
    item = resp.get('Item') or {}
    if not item:
        return {}
    return {
        'scopeId':      item.get('scopeId'),
        'period':       item.get('period'),
        'sourceMethod': item.get('sourceMethod'),
        'amountUsd':    _to_float(item.get('amountUsd')),
        'generatedAt':  item.get('generatedAt', ''),
        'inputs':       item.get('inputs', {}),
    }


def get_variance_summary(scope_id: str, period: str) -> dict:
    """
    Compare current budget vs the latest ScopeActuals snapshot (+ forecast if
    available). Does NOT query Athena — it reads the weekly snapshot written
    by budget_refresh_handler. If no snapshot exists yet, actualUsd is 0.

    Returns: {
      scopeId, period,
      budgetUsd, actualUsd, forecastUsd,
      varianceUsd (actual - budget), variancePct (actual/budget - 1 * 100),
      snapshotAt   (timestamp of the actuals snapshot, empty if none)
    }
    """
    logger.info(f"get_variance_summary {scope_id}/{period}")
    budget_row   = get_current_budget(scope_id, period)
    forecast_row = get_forecast(scope_id, period)
    actuals_resp = _scope_actuals.get_item(Key={'scopeId': scope_id, 'period': period})
    actuals_row  = actuals_resp.get('Item') or {}

    budget_usd   = budget_row.get('amountUsd', 0.0)
    actual_usd   = _to_float(actuals_row.get('actualUsd'))
    forecast_usd = forecast_row.get('amountUsd', 0.0)

    variance_usd = round(actual_usd - budget_usd, 2)
    variance_pct = round((actual_usd / budget_usd - 1) * 100, 1) if budget_usd else 0.0

    return {
        'scopeId':     scope_id,
        'period':      period,
        'budgetUsd':   budget_usd,
        'actualUsd':   actual_usd,
        'forecastUsd': forecast_usd,
        'varianceUsd': variance_usd,
        'variancePct': variance_pct,
        'snapshotAt':  actuals_row.get('snapshotAt', ''),
        'budgetSet':   bool(budget_row),
    }
