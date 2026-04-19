"""
Visibility Handler
------------------
Serves the native Cost Visibility dashboards (replaces the QuickSight embed flow).

Routes:
  GET /visibility/filters
      Returns { accounts: [{id, name, ouId, ouName}], ous: [{id, name}], periods: [...] }
      so the React FilterBar can populate its dropdowns.

  GET /visibility/dashboard?type=<key>
      Returns panels for the dashboard `type`, filtered by query params:
        linkedAccountIds, accountIds, ouIds  (all comma-separated)
        startPeriod, endPeriod               (YYYY-MM)
      Panels:
        monthly_trend  — monthly spend time series for the filter set
        top_services   — top N AWS services by spend
        top_accounts   — top N linked accounts by spend
      Dashboard-type specific SERVICE_FILTER prefilters the SQL:
        billing-summary → all services
        compute         → EC2 / Lambda / ECS / EKS / Fargate
        storage         → S3 / EBS / EFS / FSx / Glacier
        ai-ml           → SageMaker / Bedrock / Rekognition / Comprehend / Translate / Textract
        commitments     → Savings Plans / Reserved Instances usage (by charge type)
        rightsizing     → EC2 only (helps Optimization)

Design:
  - Organizations lookups require the payer cross-account role; we reuse the
    same PAYER_CROSS_ACCOUNT_ROLE env var the agent already uses.
  - Filter option list is cached in-memory per Lambda container for 5 minutes
    (FILTER_CACHE_TTL) so subsequent dropdown loads stay fast without paging
    Organizations every time.
"""

from __future__ import annotations

import os
import json
import time
import logging
from datetime import datetime, timezone
from typing import Any, Optional

import boto3

logger = logging.getLogger()
logger.setLevel(os.environ.get('LOG_LEVEL', 'INFO'))

ATHENA_WORKGROUP        = os.environ.get('ATHENA_WORKGROUP',  'kostops-workgroup')
GLUE_DATABASE           = os.environ.get('GLUE_DATABASE',     'kostops_cur')
CUR_TABLE               = os.environ.get('CUR_TABLE',         'data')
AWS_REGION              = os.environ.get('AWS_REGION',        'us-east-1')
PAYER_ROLE_ARN          = os.environ.get('PAYER_CROSS_ACCOUNT_ROLE', '')
FILTER_CACHE_TTL        = int(os.environ.get('FILTER_CACHE_TTL_SECONDS', '300'))

_athena      = boto3.client('athena', region_name=AWS_REGION)
_sts         = boto3.client('sts',    region_name=AWS_REGION)

_filter_cache: dict[str, Any] = {'value': None, 'expiresAt': 0.0}


# ── Helpers ───────────────────────────────────────────────────────────────────

def _cors(status: int, body) -> dict:
    return {
        'statusCode': status,
        'headers': {
            'Content-Type':                'application/json',
            'Access-Control-Allow-Origin': '*',
        },
        'body': json.dumps(body, default=str),
    }


def _payer_session() -> Optional[boto3.Session]:
    if not PAYER_ROLE_ARN:
        return None
    creds = _sts.assume_role(
        RoleArn=PAYER_ROLE_ARN,
        RoleSessionName='kostops-visibility',
    )['Credentials']
    return boto3.Session(
        aws_access_key_id     = creds['AccessKeyId'],
        aws_secret_access_key = creds['SecretAccessKey'],
        aws_session_token     = creds['SessionToken'],
        region_name           = AWS_REGION,
    )


def _list_organizations() -> dict:
    """Return {accounts: [...], ous: [...]} via the payer role; pagination aware."""
    session = _payer_session()
    if not session:
        return {'accounts': [], 'ous': []}

    orgs = session.client('organizations')

    # Walk OU tree starting from the org root to build id → name + parent lookup.
    ou_by_id: dict[str, dict] = {}
    try:
        roots = orgs.list_roots()['Roots']
        for root in roots:
            stack = [root['Id']]
            while stack:
                parent_id = stack.pop()
                paginator = orgs.get_paginator('list_organizational_units_for_parent')
                for page in paginator.paginate(ParentId=parent_id):
                    for ou in page.get('OrganizationalUnits', []):
                        ou_by_id[ou['Id']] = {'id': ou['Id'], 'name': ou['Name'], 'parentId': parent_id}
                        stack.append(ou['Id'])
    except Exception as e:
        logger.warning(f'OU walk failed (non-fatal): {e}')

    # Accounts: the ListAccounts API returns all accounts under the org regardless
    # of OU; map each to its parent OU using list_parents (cheap; one call per account).
    accounts: list[dict] = []
    try:
        paginator = orgs.get_paginator('list_accounts')
        for page in paginator.paginate():
            for acct in page.get('Accounts', []):
                if acct.get('Status') != 'ACTIVE':
                    continue
                acct_id = acct['Id']
                ou_id   = ''
                ou_name = ''
                try:
                    parents = orgs.list_parents(ChildId=acct_id).get('Parents', [])
                    if parents:
                        p = parents[0]
                        if p.get('Type') == 'ORGANIZATIONAL_UNIT':
                            ou_id   = p['Id']
                            ou_name = ou_by_id.get(ou_id, {}).get('name', '')
                        elif p.get('Type') == 'ROOT':
                            ou_id   = p['Id']
                            ou_name = 'Root'
                except Exception as e:
                    logger.debug(f'list_parents({acct_id}) failed: {e}')
                accounts.append({
                    'id':      acct_id,
                    'name':    acct.get('Name', acct_id),
                    'email':   acct.get('Email', ''),
                    'ouId':    ou_id,
                    'ouName':  ou_name,
                })
    except Exception as e:
        logger.warning(f'ListAccounts failed (non-fatal): {e}')

    accounts.sort(key=lambda a: a['name'].lower())
    ous = sorted(ou_by_id.values(), key=lambda o: o['name'].lower())
    return {'accounts': accounts, 'ous': ous}


def _cached_filter_options() -> dict:
    now = time.time()
    if _filter_cache['value'] and _filter_cache['expiresAt'] > now:
        return _filter_cache['value']

    org_data = _list_organizations()

    # Generate period list from CUR billing_period partitions if available, else
    # fall back to last 13 months derived from today.
    periods = _list_periods() or _last_n_months(13)

    value = {
        'accounts': org_data['accounts'],
        'ous':      org_data['ous'],
        'periods':  periods,
    }
    _filter_cache['value']     = value
    _filter_cache['expiresAt'] = now + FILTER_CACHE_TTL
    return value


def _last_n_months(n: int) -> list[str]:
    today = datetime.now(timezone.utc).date()
    out = []
    y, m = today.year, today.month
    for _ in range(n):
        out.append(f'{y:04d}-{m:02d}')
        m -= 1
        if m == 0:
            m = 12
            y -= 1
    return sorted(out)


def _list_periods() -> list[str]:
    """Distinct billing_period values from CUR. Empty on error — caller falls back."""
    sql = f"SELECT DISTINCT billing_period FROM {CUR_TABLE} ORDER BY billing_period ASC"
    try:
        rows = _run_athena(sql)
        return [r['billing_period'] for r in rows if r.get('billing_period')]
    except Exception as e:
        logger.info(f'_list_periods fallback: {e}')
        return []


# ── Athena ────────────────────────────────────────────────────────────────────

def _run_athena(sql: str, timeout_s: int = 60) -> list[dict]:
    resp   = _athena.start_query_execution(
        QueryString             = sql,
        QueryExecutionContext   = {'Database': GLUE_DATABASE},
        WorkGroup               = ATHENA_WORKGROUP,
    )
    execution_id = resp['QueryExecutionId']

    deadline = time.time() + timeout_s
    while time.time() < deadline:
        status = _athena.get_query_execution(QueryExecutionId=execution_id)
        state  = status['QueryExecution']['Status']['State']
        if state == 'SUCCEEDED':
            break
        if state in ('FAILED', 'CANCELLED'):
            reason = status['QueryExecution']['Status'].get('StateChangeReason', '')
            raise RuntimeError(f'Athena {state}: {reason}')
        time.sleep(1.5)
    else:
        raise TimeoutError('Athena query timed out')

    pager   = _athena.get_paginator('get_query_results')
    pages   = list(pager.paginate(QueryExecutionId=execution_id))
    if not pages or not pages[0]['ResultSet']['Rows']:
        return []

    headers = [c.get('VarCharValue', '') for c in pages[0]['ResultSet']['Rows'][0]['Data']]
    rows: list[dict] = []
    for i, page in enumerate(pages):
        data_rows = page['ResultSet']['Rows']
        if i == 0:
            data_rows = data_rows[1:]  # skip header
        for row in data_rows:
            values = [cell.get('VarCharValue', '') for cell in row['Data']]
            rows.append(dict(zip(headers, values)))
    return rows


# ── SQL building ──────────────────────────────────────────────────────────────

_SERVICE_WHERE: dict[str, str] = {
    # Dashboard type → extra WHERE filter on product_servicecode
    'billing-summary': '',
    'compute':         "AND product_servicecode IN ('AmazonEC2','AWSLambda','AmazonECS','AmazonEKS','AmazonFSx')",
    'storage':         "AND product_servicecode IN ('AmazonS3','AmazonEBS','AmazonEFS','AmazonGlacier','AmazonS3GlacierDeepArchive')",
    'ai-ml':           "AND product_servicecode IN ('AmazonSageMaker','AmazonBedrock','AmazonRekognition','AmazonComprehend','AmazonTranslate','AmazonTextract','AmazonPersonalize','AmazonForecast')",
    'commitments':     "AND line_item_line_item_type IN ('SavingsPlanCoveredUsage','SavingsPlanNegation','SavingsPlanUpfrontFee','SavingsPlanRecurringFee','DiscountedUsage','RIFee','Credit')",
    'rightsizing':     "AND product_servicecode = 'AmazonEC2'",
}


def _sql_safe_list(values: list[str]) -> str:
    """Inline-escaped CSV for IN clauses — values must be clean account IDs / period strings."""
    return ",".join(f"'{v.replace(chr(39), '')}'" for v in values if v)


def _where_from_filters(q: dict, service_where: str) -> str:
    clauses = [
        "line_item_line_item_type NOT IN ('Credit','Refund','Tax')",
    ]
    linked = [a for a in (q.get('linkedAccountIds') or '').split(',') if a.strip().isdigit()]
    accts  = [a for a in (q.get('accountIds')       or '').split(',') if a.strip().isdigit()]
    ids    = sorted(set(linked) | set(accts))
    if ids:
        clauses.append(f"line_item_usage_account_id IN ({_sql_safe_list(ids)})")

    start = (q.get('startPeriod') or '').strip()
    end   = (q.get('endPeriod')   or '').strip()
    if start:
        clauses.append(f"billing_period >= '{start}'")
    if end:
        clauses.append(f"billing_period <= '{end}'")

    # OU filtering: expand OU IDs → account IDs via Organizations options
    ous = [o for o in (q.get('ouIds') or '').split(',') if o.strip()]
    if ous:
        opts    = _cached_filter_options()
        ou_set  = set(ous)
        ou_accts = [a['id'] for a in opts.get('accounts', []) if a.get('ouId') in ou_set]
        if ou_accts:
            clauses.append(f"line_item_usage_account_id IN ({_sql_safe_list(ou_accts)})")
        else:
            clauses.append('1=0')  # no matching accounts → empty result set

    where = ' AND '.join(clauses)
    if service_where:
        where += f' {service_where}'
    return where


# ── Panel queries ─────────────────────────────────────────────────────────────

def _panel_monthly_trend(qp: dict, service_where: str) -> dict:
    where = _where_from_filters(qp, service_where)
    sql = f"""
        SELECT billing_period AS period,
               ROUND(SUM(line_item_unblended_cost), 2) AS cost
        FROM {CUR_TABLE}
        WHERE {where}
        GROUP BY billing_period
        ORDER BY billing_period ASC
    """
    rows = _run_athena(sql)
    return {
        'id':    'monthly_trend',
        'title': 'Monthly spend',
        'kind':  'bar',
        'data':  [{'period': r['period'], 'cost': float(r.get('cost') or 0)} for r in rows],
    }


def _panel_top_services(qp: dict, service_where: str, limit: int = 10) -> dict:
    where = _where_from_filters(qp, service_where)
    sql = f"""
        SELECT product_servicecode AS service,
               ROUND(SUM(line_item_unblended_cost), 2) AS cost
        FROM {CUR_TABLE}
        WHERE {where}
        GROUP BY product_servicecode
        ORDER BY cost DESC
        LIMIT {limit}
    """
    rows = _run_athena(sql)
    return {
        'id':    'top_services',
        'title': f'Top {limit} services',
        'kind':  'table',
        'data':  [{'service': r.get('service', ''), 'cost': float(r.get('cost') or 0)} for r in rows],
    }


def _panel_top_accounts(qp: dict, service_where: str, limit: int = 10) -> dict:
    opts    = _cached_filter_options()
    name_by_id = {a['id']: a.get('name', a['id']) for a in opts.get('accounts', [])}
    ou_by_id   = {a['id']: a.get('ouName', '')    for a in opts.get('accounts', [])}

    where = _where_from_filters(qp, service_where)
    sql = f"""
        SELECT line_item_usage_account_id AS account_id,
               ROUND(SUM(line_item_unblended_cost), 2) AS cost
        FROM {CUR_TABLE}
        WHERE {where}
        GROUP BY line_item_usage_account_id
        ORDER BY cost DESC
        LIMIT {limit}
    """
    rows = _run_athena(sql)
    return {
        'id':    'top_accounts',
        'title': f'Top {limit} linked accounts',
        'kind':  'table',
        'data':  [{
            'accountId':   r.get('account_id', ''),
            'accountName': name_by_id.get(r.get('account_id', ''), ''),
            'ouName':      ou_by_id.get(r.get('account_id', ''), ''),
            'cost':        float(r.get('cost') or 0),
        } for r in rows],
    }


# ── Route dispatch ────────────────────────────────────────────────────────────

def _dashboard(qp: dict) -> dict:
    dashboard_type = (qp.get('type') or 'billing-summary').lower()
    service_where  = _SERVICE_WHERE.get(dashboard_type, '')
    panels = []
    for builder in (_panel_monthly_trend, _panel_top_services, _panel_top_accounts):
        try:
            panels.append(builder(qp, service_where))
        except Exception as e:
            logger.warning(f'panel {builder.__name__} failed: {e}')
            panels.append({
                'id':    builder.__name__.replace('_panel_', ''),
                'title': '',
                'kind':  'error',
                'error': str(e)[:200],
                'data':  [],
            })
    return {'type': dashboard_type, 'panels': panels}


def handler(event, context):
    method = event.get('httpMethod', 'GET')
    path   = event.get('path', '')
    qp     = event.get('queryStringParameters') or {}
    logger.info(f'visibility | {method} {path} | keys={list(qp.keys())}')

    if method == 'GET' and path.endswith('/visibility/filters'):
        try:
            return _cors(200, _cached_filter_options())
        except Exception as e:
            logger.error(f'filters error: {e}')
            return _cors(500, {'error': 'failed to load filter options', 'detail': str(e)[:200]})

    if method == 'GET' and path.endswith('/visibility/dashboard'):
        try:
            return _cors(200, _dashboard(qp))
        except Exception as e:
            logger.error(f'dashboard error: {e}')
            return _cors(500, {'error': 'dashboard query failed', 'detail': str(e)[:200]})

    return _cors(405, {'error': f'Method {method} not supported on this path'})
