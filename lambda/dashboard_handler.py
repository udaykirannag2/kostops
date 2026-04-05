"""
Dashboard Handler
-----------------
Lambda function that runs the monthly spend Athena query and returns
the last 13 months of spend data directly to the React dashboard.

Unlike the chat endpoint, this calls Athena directly — no agent involved.
Results are suitable for rendering as a bar/line chart in the UI.

Route: GET /dashboard/monthly-spend
"""

import os
import json
import time
import logging
import boto3

logger            = logging.getLogger()
logger.setLevel(os.environ.get('LOG_LEVEL', 'INFO'))

ATHENA_WORKGROUP  = os.environ.get('ATHENA_WORKGROUP',  'kostops-workgroup')
GLUE_DATABASE     = os.environ.get('GLUE_DATABASE',     'kostops_cur')
CUR_TABLE         = os.environ.get('CUR_TABLE',         'cur')
AWS_REGION        = os.environ.get('AWS_REGION',        'us-east-1')

_athena = boto3.client('athena', region_name=AWS_REGION)

SQL = f"""
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


def _run_athena(sql: str) -> list[dict]:
    resp         = _athena.start_query_execution(
        QueryString=sql,
        QueryExecutionContext={'Database': GLUE_DATABASE},
        WorkGroup=ATHENA_WORKGROUP,
    )
    execution_id = resp['QueryExecutionId']

    for _ in range(60):
        status = _athena.get_query_execution(QueryExecutionId=execution_id)
        state  = status['QueryExecution']['Status']['State']
        if state == 'SUCCEEDED':
            break
        if state in ('FAILED', 'CANCELLED'):
            reason = status['QueryExecution']['Status'].get('StateChangeReason', '')
            raise RuntimeError(f"Athena {state}: {reason}")
        time.sleep(2)
    else:
        raise TimeoutError('Athena query timed out')

    pages   = []
    pager   = _athena.get_paginator('get_query_results')
    for page in pager.paginate(QueryExecutionId=execution_id):
        pages.append(page)

    if not pages or not pages[0]['ResultSet']['Rows']:
        return []

    headers = [c['VarCharValue'] for c in pages[0]['ResultSet']['Rows'][0]['Data']]
    rows    = []
    for page in pages:
        for row in page['ResultSet']['Rows'][1:]:
            values = [cell.get('VarCharValue', '') for cell in row['Data']]
            rows.append(dict(zip(headers, values)))
    return rows


def _cors(status: int, body) -> dict:
    return {
        'statusCode': status,
        'headers': {
            'Content-Type':                'application/json',
            'Access-Control-Allow-Origin': '*',
        },
        'body': json.dumps(body),
    }


def handler(event: dict, context) -> dict:
    logger.info('Dashboard monthly-spend request')
    try:
        rows = _run_athena(SQL)
        # Normalise: total_cost as float, fill currency default
        data = [
            {
                'year_month': r['year_month'],
                'total_cost': float(r.get('total_cost') or 0),
                'currency':   r.get('currency', 'USD'),
            }
            for r in rows
        ]
        logger.info(f'Returning {len(data)} monthly data points')
        return _cors(200, {'monthly_spend': data})
    except RuntimeError as e:
        # Athena query failed — likely Glue table not yet created
        logger.warning(f'Athena error: {e}')
        return _cors(503, {
            'error':   'CUR data not available yet',
            'detail':  str(e),
            'hint':    'Run the Glue crawler after the first CUR delivery: '
                       'aws glue start-crawler --name kostops-cur-crawler',
        })
    except Exception as e:
        logger.error(f'Unexpected error: {e}')
        return _cors(500, {'error': 'Internal error'})
