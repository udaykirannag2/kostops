"""
Athena Tools
------------
Custom Strands tools for querying the Cost and Usage Report (CUR)
via Amazon Athena. The CUR data lives in the replicated S3 bucket
(kostops-cur-<accountId>) and is queryable through the Glue table
registered under the kostops_cur database.

All tools follow the Strands @tool pattern — the docstring becomes
the tool description shown to the agent.
"""

import os
import time
import logging
import boto3
from strands import tool

logger = logging.getLogger(__name__)

ATHENA_WORKGROUP  = os.environ.get('ATHENA_WORKGROUP', 'kostops-workgroup')
GLUE_DATABASE     = os.environ.get('GLUE_DATABASE', 'kostops_cur')
CUR_TABLE         = os.environ.get('CUR_TABLE', 'data')
AWS_REGION        = os.environ.get('AWS_REGION', 'us-east-1')

_athena = boto3.client('athena', region_name=AWS_REGION)


# ── Internal helpers ──────────────────────────────────────────────────────────

def _run_query(sql: str) -> list[dict]:
    """
    Execute an Athena query and return results as a list of dicts.
    Polls until the query completes or fails (max 120 seconds).
    """
    response = _athena.start_query_execution(
        QueryString=sql,
        QueryExecutionContext={'Database': GLUE_DATABASE},
        WorkGroup=ATHENA_WORKGROUP,
    )
    execution_id = response['QueryExecutionId']

    # Poll for completion
    for _ in range(60):
        status = _athena.get_query_execution(QueryExecutionId=execution_id)
        state  = status['QueryExecution']['Status']['State']
        if state == 'SUCCEEDED':
            break
        if state in ('FAILED', 'CANCELLED'):
            reason = status['QueryExecution']['Status'].get('StateChangeReason', 'unknown')
            raise RuntimeError(f"Athena query {state}: {reason}\nSQL: {sql}")
        time.sleep(2)
    else:
        raise TimeoutError(f"Athena query timed out after 120s: {execution_id}")

    # Fetch results
    pages   = []
    paginator = _athena.get_paginator('get_query_results')
    for page in paginator.paginate(QueryExecutionId=execution_id):
        pages.append(page)

    if not pages or not pages[0].get('ResultSet', {}).get('Rows'):
        return []

    # First row is the header
    headers = [col['VarCharValue'] for col in pages[0]['ResultSet']['Rows'][0]['Data']]
    rows    = []
    for page in pages:
        for row in page['ResultSet']['Rows'][1:]:
            values = [cell.get('VarCharValue', '') for cell in row['Data']]
            rows.append(dict(zip(headers, values)))
    return rows


# ── Strands tools ─────────────────────────────────────────────────────────────

@tool
def get_spend_by_service(
    start_date: str,
    end_date: str,
    limit: int = 20,
) -> list[dict]:
    """
    Return total spend grouped by AWS service for the given date range.

    Args:
        start_date: Start date in YYYY-MM-DD format (inclusive).
        end_date:   End date in YYYY-MM-DD format (exclusive).
        limit:      Maximum number of services to return, ordered by spend desc.

    Returns:
        List of dicts with keys: service, total_cost, currency.
    """
    sql = f"""
        SELECT
            line_item_product_code           AS service,
            ROUND(SUM(line_item_unblended_cost), 2) AS total_cost,
            line_item_currency_code          AS currency
        FROM {CUR_TABLE}
        WHERE line_item_usage_start_date >= TIMESTAMP '{start_date} 00:00:00'
          AND line_item_usage_start_date <  TIMESTAMP '{end_date} 00:00:00'
          AND line_item_line_item_type NOT IN ('Credit', 'Refund', 'Tax')
        GROUP BY line_item_product_code, line_item_currency_code
        ORDER BY total_cost DESC
        LIMIT {limit}
    """
    return _run_query(sql)


@tool
def get_spend_by_account(
    start_date: str,
    end_date: str,
) -> list[dict]:
    """
    Return total spend grouped by linked account for the given date range.
    Useful for identifying which account is driving the most cost.

    Args:
        start_date: Start date in YYYY-MM-DD format (inclusive).
        end_date:   End date in YYYY-MM-DD format (exclusive).

    Returns:
        List of dicts with keys: account_id, account_name, total_cost, currency.
    """
    sql = f"""
        SELECT
            line_item_usage_account_id       AS account_id,
            bill_payer_account_id            AS payer_account_id,
            ROUND(SUM(line_item_unblended_cost), 2) AS total_cost,
            line_item_currency_code          AS currency
        FROM {CUR_TABLE}
        WHERE line_item_usage_start_date >= TIMESTAMP '{start_date} 00:00:00'
          AND line_item_usage_start_date <  TIMESTAMP '{end_date} 00:00:00'
          AND line_item_line_item_type NOT IN ('Credit', 'Refund', 'Tax')
        GROUP BY line_item_usage_account_id, bill_payer_account_id, line_item_currency_code
        ORDER BY total_cost DESC
    """
    return _run_query(sql)


@tool
def get_spend_last_13_months() -> list[dict]:
    """
    Return total spend grouped by calendar month for the last 13 months.
    13 months gives enough history for year-over-year comparison
    (e.g. April 2026 vs April 2025).

    Returns:
        List of dicts with keys: year_month, total_cost, currency,
        sorted oldest → newest so charts render left-to-right correctly.
    """
    sql = f"""
        SELECT
            DATE_FORMAT(line_item_usage_start_date, '%Y-%m') AS year_month,
            ROUND(SUM(line_item_unblended_cost), 2)          AS total_cost,
            line_item_currency_code                          AS currency
        FROM {CUR_TABLE}
        WHERE line_item_usage_start_date >= DATE_ADD('month', -13, CURRENT_DATE)
          AND line_item_line_item_type NOT IN ('Credit', 'Refund', 'Tax')
        GROUP BY
            DATE_FORMAT(line_item_usage_start_date, '%Y-%m'),
            line_item_currency_code
        ORDER BY year_month ASC
    """
    return _run_query(sql)


@tool
def get_daily_spend_trend(
    start_date: str,
    end_date: str,
    service: str | None = None,
) -> list[dict]:
    """
    Return daily spend totals for the given date range, optionally filtered
    to a single AWS service. Use this to spot spending spikes day by day.

    Args:
        start_date: Start date in YYYY-MM-DD format (inclusive).
        end_date:   End date in YYYY-MM-DD format (exclusive).
        service:    Optional AWS service name to filter (e.g. "Amazon EC2").
                    If omitted, returns total spend across all services.

    Returns:
        List of dicts with keys: date, total_cost, currency, sorted by date asc.
    """
    service_filter = f"AND line_item_product_code = '{service}'" if service else ''
    sql = f"""
        SELECT
            DATE(line_item_usage_start_date)        AS date,
            ROUND(SUM(line_item_unblended_cost), 2) AS total_cost,
            line_item_currency_code                 AS currency
        FROM {CUR_TABLE}
        WHERE line_item_usage_start_date >= TIMESTAMP '{start_date} 00:00:00'
          AND line_item_usage_start_date <  TIMESTAMP '{end_date} 00:00:00'
          AND line_item_line_item_type NOT IN ('Credit', 'Refund', 'Tax')
          {service_filter}
        GROUP BY DATE(line_item_usage_start_date), line_item_currency_code
        ORDER BY date ASC
    """
    return _run_query(sql)


@tool
def get_top_cost_drivers(
    start_date: str,
    end_date: str,
    limit: int = 10,
) -> list[dict]:
    """
    Return the top individual line items driving cost — broken down by
    service, usage type, and resource ID. Use this to pinpoint the exact
    resources responsible for high spend.

    Args:
        start_date: Start date in YYYY-MM-DD format (inclusive).
        end_date:   End date in YYYY-MM-DD format (exclusive).
        limit:      Number of top line items to return.

    Returns:
        List of dicts with keys: service, usage_type, resource_id,
        account_id, total_cost, currency.
    """
    sql = f"""
        SELECT
            line_item_product_code           AS service,
            line_item_usage_type             AS usage_type,
            line_item_resource_id            AS resource_id,
            line_item_usage_account_id       AS account_id,
            ROUND(SUM(line_item_unblended_cost), 2) AS total_cost,
            line_item_currency_code          AS currency
        FROM {CUR_TABLE}
        WHERE line_item_usage_start_date >= TIMESTAMP '{start_date} 00:00:00'
          AND line_item_usage_start_date <  TIMESTAMP '{end_date} 00:00:00'
          AND line_item_line_item_type NOT IN ('Credit', 'Refund', 'Tax')
          AND line_item_unblended_cost > 0
        GROUP BY
            line_item_product_code,
            line_item_usage_type,
            line_item_resource_id,
            line_item_usage_account_id,
            line_item_currency_code
        ORDER BY total_cost DESC
        LIMIT {limit}
    """
    return _run_query(sql)
