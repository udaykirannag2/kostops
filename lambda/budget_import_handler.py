"""
Budget Import Handler
---------------------
CSV planning workflow for the Budget Agent (Phase 2).

Design: for MVP we avoid S3 pre-signed upload orchestration entirely — the
CSV is small (<< 1 MB even for 1000s of rows) so we accept it inline in the
POST body, parse + validate synchronously, stash the preview in DynamoDB,
and commit by re-reading the preview and applying row-by-row via the same
transactional code path as budgets_handler.

Routes:
  GET  /budgets/template
       Returns a prefilled CSV template (text/csv) for the current active
       scopes and the next 6 months, so the admin can fill in amounts and
       upload it back. Admin only.

  POST /budgets/import
       Body: { csv: "<raw csv text>" }
       Parses + validates the CSV, stores an ImportJob with status=PREVIEWED,
       returns { jobId, preview: [...], errors: [...], summary: {...} }.
       Admin only.

  GET  /budgets/import/{jobId}
       Returns the stored preview for the job (for re-review or the agent to
       show the admin what's about to apply). Admin only.

  POST /budgets/import/{jobId}/commit
       Applies the PREVIEWED rows. Each row becomes a new budget version via
       the same isCurrent-flip transaction used by PUT /budgets/{id}/{period}.
       Marks the job status=APPLIED with appliedAt + applied count. Admin only.

CSV format (one row per scope/period):
    scope_id,scope_name,period,amount_usd,granularity,note
    sc_eng_plat,Platform Eng,2026-05,42000,MONTHLY,Q2 uplift

    - scope_name is informational. We resolve rows by scope_id; if the id is
      blank we try to resolve by unique name.
    - period: YYYY-MM or YYYY-Qn.
    - granularity: optional, defaults from period (MONTHLY for YYYY-MM,
      QUARTERLY for YYYY-Qn).
    - note: optional free text.

All writes emit AuditEvents (entityType="Budget") on commit, plus one
"ImportJob#{jobId}" audit row on import / commit transitions.
"""

from __future__ import annotations

import os
import csv
import io
import json
import re
import time
import uuid
import logging
from decimal import Decimal
from datetime import datetime, timezone

import boto3
from boto3.dynamodb.conditions import Key, Attr

from common.roles import require_admin, PermissionDenied, forbidden_response
from common.audit import write_audit

logger = logging.getLogger()
logger.setLevel(os.environ.get('LOG_LEVEL', 'INFO'))

SCOPES_TABLE      = os.environ.get('SCOPES_TABLE',       'kostops-scopes')
BUDGETS_TABLE     = os.environ.get('BUDGETS_TABLE',      'kostops-budgets')
IMPORT_JOBS_TABLE = os.environ.get('IMPORT_JOBS_TABLE',  'kostops-budget-import-jobs')
AWS_REGION        = os.environ.get('AWS_REGION',         'us-east-1')

_ddb         = boto3.resource('dynamodb', region_name=AWS_REGION)
_scopes      = _ddb.Table(SCOPES_TABLE)
_budgets     = _ddb.Table(BUDGETS_TABLE)
_import_jobs = _ddb.Table(IMPORT_JOBS_TABLE)
_client      = boto3.client('dynamodb', region_name=AWS_REGION)   # TransactWriteItems

_PERIOD_RE  = re.compile(r'^\d{4}-(0[1-9]|1[0-2]|Q[1-4])$')
JOB_TTL_DAYS = 7


# ── Helpers ───────────────────────────────────────────────────────────────────

def _cors(status: int, body=None, *, content_type: str = 'application/json', raw: str | None = None) -> dict:
    headers = {
        'Content-Type':                content_type,
        'Access-Control-Allow-Origin': '*',
    }
    if raw is not None:
        return {'statusCode': status, 'headers': headers, 'body': raw}
    return {'statusCode': status, 'headers': headers, 'body': json.dumps(body or {}, default=str)}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _actor_sub(event: dict) -> str:
    return (
        event.get('requestContext', {})
             .get('authorizer', {})
             .get('claims', {})
             .get('sub', 'anonymous')
    )


def _active_scopes() -> list[dict]:
    resp = _scopes.scan(
        FilterExpression=Attr('status').eq('active'),
        Limit=500,
    )
    items = resp.get('Items', [])
    items.sort(key=lambda s: (s.get('name') or '').lower())
    return items


def _next_n_months(n: int) -> list[str]:
    """YYYY-MM for current + n-1 future months."""
    out: list[str] = []
    d = datetime.now(timezone.utc)
    y, m = d.year, d.month
    for _ in range(n):
        out.append(f'{y:04d}-{m:02d}')
        m += 1
        if m == 13:
            m = 1
            y += 1
    return out


def _template_rows(scopes: list[dict], periods: list[str]) -> str:
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(['scope_id', 'scope_name', 'period', 'amount_usd', 'granularity', 'note'])
    for s in scopes:
        for p in periods:
            w.writerow([s.get('scopeId', ''), s.get('name', ''), p, '', 'MONTHLY', ''])
    return buf.getvalue()


# ── GET /budgets/template ────────────────────────────────────────────────────

def _download_template() -> dict:
    scopes  = _active_scopes()
    periods = _next_n_months(6)
    body    = _template_rows(scopes, periods)
    # `text/csv` prompts most browsers to offer Save As…
    return _cors(200, raw=body, content_type='text/csv')


# ── POST /budgets/import ─────────────────────────────────────────────────────

def _resolve_scope(scope_id: str, scope_name: str, scopes_by_id: dict, scopes_by_name: dict) -> tuple[str, str]:
    """Return (scopeId, error_message). scopeId is empty when unresolved."""
    sid = (scope_id or '').strip()
    if sid:
        if sid in scopes_by_id:
            return sid, ''
        return '', f'scope_id "{sid}" not found'
    nm = (scope_name or '').strip().lower()
    if nm:
        hits = scopes_by_name.get(nm, [])
        if len(hits) == 1:
            return hits[0], ''
        if len(hits) > 1:
            return '', f'scope_name "{scope_name}" matches multiple scopes — provide scope_id'
        return '', f'scope_name "{scope_name}" not found'
    return '', 'scope_id or scope_name is required'


def _parse_rows(csv_text: str) -> tuple[list[dict], list[dict]]:
    """
    Parse + validate. Returns (preview_rows, errors).
    preview_rows are the rows that WILL be applied on commit; errors list is
    human-readable problems the admin should fix.
    """
    preview: list[dict] = []
    errors:  list[dict] = []

    scopes_items     = _active_scopes()
    scopes_by_id     = {s['scopeId']: s for s in scopes_items}
    scopes_by_name: dict[str, list[str]] = {}
    for s in scopes_items:
        nm = (s.get('name') or '').strip().lower()
        if nm:
            scopes_by_name.setdefault(nm, []).append(s['scopeId'])

    reader = csv.DictReader(io.StringIO(csv_text))
    if not reader.fieldnames or 'period' not in reader.fieldnames or 'amount_usd' not in reader.fieldnames:
        return preview, [{
            'row':    0,
            'field':  'header',
            'value':  (','.join(reader.fieldnames or []))[:100],
            'reason': 'header must include at least period,amount_usd; add scope_id or scope_name too',
        }]

    for idx, raw in enumerate(reader, start=2):   # start=2 so row 1 = header
        scope_id   = (raw.get('scope_id')   or '').strip()
        scope_name = (raw.get('scope_name') or '').strip()
        period     = (raw.get('period')     or '').strip()
        amount_raw = (raw.get('amount_usd') or '').strip()
        gran       = (raw.get('granularity') or '').strip().upper()
        note       = (raw.get('note')       or '').strip()[:512]

        # Skip completely blank rows (admins will leave some scope/period
        # cells blank in the template).
        if not any([scope_id, scope_name, period, amount_raw]):
            continue
        if not amount_raw:
            # treat blank amount as "skip this row" — matches template usage
            continue

        # Period shape
        if not _PERIOD_RE.match(period):
            errors.append({'row': idx, 'field': 'period', 'value': period, 'reason': 'must be YYYY-MM or YYYY-Qn'})
            continue

        # Amount
        try:
            amount = float(amount_raw.replace(',', '').replace('$', ''))
        except (TypeError, ValueError):
            errors.append({'row': idx, 'field': 'amount_usd', 'value': amount_raw, 'reason': 'not a number'})
            continue
        if amount < 0:
            errors.append({'row': idx, 'field': 'amount_usd', 'value': amount_raw, 'reason': 'must be >= 0'})
            continue

        # Granularity (default from period shape)
        if not gran:
            gran = 'QUARTERLY' if 'Q' in period else 'MONTHLY'
        if gran not in ('MONTHLY', 'QUARTERLY'):
            errors.append({'row': idx, 'field': 'granularity', 'value': gran, 'reason': 'must be MONTHLY or QUARTERLY'})
            continue

        # Scope resolution
        sid, err = _resolve_scope(scope_id, scope_name, scopes_by_id, scopes_by_name)
        if err:
            errors.append({'row': idx, 'field': 'scope', 'value': scope_id or scope_name, 'reason': err})
            continue

        # Diff vs current budget
        current = _current_budget_amount(sid, period)
        preview.append({
            'row':          idx,
            'scopeId':      sid,
            'scopeName':    scopes_by_id[sid].get('name', ''),
            'period':       period,
            'amountUsd':    round(amount, 2),
            'granularity':  gran,
            'note':         note,
            'currentUsd':   current,
            'deltaUsd':     round(amount - current, 2) if current is not None else None,
            'changeType':   'update' if current not in (None, amount) else ('same' if current == amount else 'create'),
        })

    # De-dupe (scopeId, period) — last one wins; report earlier dup as error
    seen: dict[tuple[str, str], dict] = {}
    deduped: list[dict] = []
    for row in preview:
        key = (row['scopeId'], row['period'])
        if key in seen:
            errors.append({
                'row':    row['row'],
                'field':  'duplicate',
                'value':  f"{row['scopeId']}/{row['period']}",
                'reason': f"row {seen[key]['row']} already sets this scope/period — last value wins",
            })
            # replace the earlier kept row in deduped
            deduped = [r for r in deduped if (r['scopeId'], r['period']) != key]
        seen[key] = row
        deduped.append(row)

    return deduped, errors


def _current_budget_amount(scope_id: str, period: str) -> float | None:
    resp = _budgets.query(
        KeyConditionExpression=Key('scopeId').eq(scope_id) & Key('sk').begins_with(f'{period}#'),
        FilterExpression=Attr('isCurrent').eq(True),
        Limit=1,
    )
    items = resp.get('Items', [])
    if not items:
        return None
    return float(items[0].get('amountUsd', 0))


def _start_import(event: dict, body: dict) -> dict:
    csv_text = body.get('csv') or ''
    if not csv_text:
        return _cors(400, {'error': 'csv body field is required'})
    if len(csv_text) > 2_000_000:   # ~2 MB cap — well under API GW 10 MB proxy limit
        return _cors(413, {'error': 'CSV too large; max 2 MB'})

    preview, errors = _parse_rows(csv_text)

    job_id     = f'imp_{uuid.uuid4().hex[:12]}'
    now        = _now()
    applicable = [r for r in preview if r.get('changeType') != 'same']
    status     = 'PREVIEWED' if applicable else 'NO_CHANGES'

    item = {
        'jobId':       job_id,
        'status':      status,
        'uploadedBy':  _actor_sub(event),
        'uploadedAt':  now,
        'rowCount':    len(preview),
        'errorCount':  len(errors),
        'preview':     _to_ddb(preview),
        'errors':      _to_ddb(errors),
        'summary':     _to_ddb({
            'creates': sum(1 for r in preview if r.get('changeType') == 'create'),
            'updates': sum(1 for r in preview if r.get('changeType') == 'update'),
            'sames':   sum(1 for r in preview if r.get('changeType') == 'same'),
        }),
        'ttl':         int(time.time()) + JOB_TTL_DAYS * 86400,
    }
    _import_jobs.put_item(Item=item)

    write_audit(
        event,
        action='PREVIEW',
        entity_type='ImportJob',
        entity_id=job_id,
        before=None,
        after={'rowCount': len(preview), 'errorCount': len(errors), 'status': status},
        source='CSV',
    )
    return _cors(201, {
        'jobId':      job_id,
        'status':     status,
        'preview':    preview,
        'errors':     errors,
        'summary':    item['summary'],
        'uploadedAt': now,
    })


def _to_ddb(value):
    """Recursively convert floats to Decimal so DynamoDB accepts the item."""
    if isinstance(value, float):
        return Decimal(str(value))
    if isinstance(value, dict):
        return {k: _to_ddb(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_to_ddb(v) for v in value]
    return value


def _from_ddb(value):
    """Pair with _to_ddb for serialisation back to JSON."""
    if isinstance(value, Decimal):
        return float(value)
    if isinstance(value, dict):
        return {k: _from_ddb(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_from_ddb(v) for v in value]
    return value


# ── GET /budgets/import/{jobId} ──────────────────────────────────────────────

def _get_preview(job_id: str) -> dict:
    resp = _import_jobs.get_item(Key={'jobId': job_id})
    item = resp.get('Item')
    if not item:
        return _cors(404, {'error': f'ImportJob not found: {job_id}'})
    return _cors(200, _from_ddb(item))


# ── POST /budgets/import/{jobId}/commit ──────────────────────────────────────

def _commit(event: dict, job_id: str) -> dict:
    resp = _import_jobs.get_item(Key={'jobId': job_id})
    item = resp.get('Item')
    if not item:
        return _cors(404, {'error': f'ImportJob not found: {job_id}'})
    status = item.get('status', '')
    if status in ('APPLIED', 'FAILED'):
        return _cors(409, {'error': f'Job already {status}', 'jobId': job_id})
    if status == 'NO_CHANGES':
        return _cors(409, {'error': 'Nothing to apply: all rows match current budgets', 'jobId': job_id})

    preview = _from_ddb(item.get('preview', []))
    actor   = _actor_sub(event)
    now     = _now()

    applied: list[dict] = []
    failed:  list[dict] = []

    for row in preview:
        if row.get('changeType') == 'same':
            continue
        scope_id = row['scopeId']
        period   = row['period']
        amount   = float(row['amountUsd'])
        gran     = row.get('granularity') or ('QUARTERLY' if 'Q' in period else 'MONTHLY')
        note     = (row.get('note') or '')[:512]

        # Next version
        count = _budgets.query(
            KeyConditionExpression=Key('scopeId').eq(scope_id) & Key('sk').begins_with(f'{period}#'),
            Select='COUNT',
        ).get('Count', 0)
        next_version = int(count) + 1
        new_sk = f'{period}#v{next_version}'

        # Current row to flip (if any)
        current_resp = _budgets.query(
            KeyConditionExpression=Key('scopeId').eq(scope_id) & Key('sk').begins_with(f'{period}#'),
            FilterExpression=Attr('isCurrent').eq(True),
            Limit=1,
        )
        current_items = current_resp.get('Items', [])

        tx_items: list[dict] = []
        if current_items:
            tx_items.append({
                'Update': {
                    'TableName':                 BUDGETS_TABLE,
                    'Key':                       {'scopeId': {'S': scope_id}, 'sk': {'S': current_items[0]['sk']}},
                    'UpdateExpression':          'SET isCurrent = :f',
                    'ExpressionAttributeValues': {':f': {'BOOL': False}},
                    'ConditionExpression':       'attribute_exists(sk)',
                }
            })
        tx_items.append({
            'Put': {
                'TableName': BUDGETS_TABLE,
                'Item': {
                    'scopeId':     {'S': scope_id},
                    'sk':          {'S': new_sk},
                    'period':      {'S': period},
                    'version':     {'N': str(next_version)},
                    'amountUsd':   {'N': str(round(amount, 2))},
                    'granularity': {'S': gran},
                    'currency':    {'S': 'USD'},
                    'createdBy':   {'S': actor},
                    'createdAt':   {'S': now},
                    'note':        {'S': note},
                    'isCurrent':   {'BOOL': True},
                    'importJobId': {'S': job_id},
                },
                'ConditionExpression': 'attribute_not_exists(sk)',
            }
        })
        try:
            _client.transact_write_items(TransactItems=tx_items)
            applied.append({
                'scopeId': scope_id, 'period': period,
                'version': next_version, 'amountUsd': amount,
            })
            write_audit(
                event,
                action='UPDATE' if current_items else 'CREATE',
                entity_type='Budget',
                entity_id=f'{scope_id}#{period}',
                before={'amountUsd': float(current_items[0].get('amountUsd', 0)) if current_items else None},
                after={'amountUsd': amount, 'version': next_version, 'granularity': gran},
                source='CSV',
            )
        except Exception as e:
            logger.error(f'commit row failed {scope_id}/{period}: {e}')
            failed.append({'scopeId': scope_id, 'period': period, 'reason': str(e)[:200]})

    final_status = 'APPLIED' if not failed else ('PARTIAL' if applied else 'FAILED')
    _import_jobs.update_item(
        Key={'jobId': job_id},
        UpdateExpression='SET #s = :s, appliedAt = :a, appliedCount = :c, failedCount = :f',
        ExpressionAttributeNames={'#s': 'status'},
        ExpressionAttributeValues={
            ':s': final_status,
            ':a': now,
            ':c': len(applied),
            ':f': len(failed),
        },
    )
    write_audit(
        event,
        action='COMMIT',
        entity_type='ImportJob',
        entity_id=job_id,
        before={'status': status},
        after={'status': final_status, 'applied': len(applied), 'failed': len(failed)},
        source='CSV',
    )
    return _cors(200, {
        'jobId':   job_id,
        'status':  final_status,
        'applied': applied,
        'failed':  failed,
    })


# ── Handler dispatch ─────────────────────────────────────────────────────────

def handler(event: dict, context) -> dict:
    method  = event.get('httpMethod', 'GET')
    path    = event.get('path', '')
    path_sp = event.get('pathParameters') or {}
    job_id  = path_sp.get('jobId', '')

    try:
        body = json.loads(event.get('body') or '{}')
    except json.JSONDecodeError:
        return _cors(400, {'error': 'Invalid JSON body'})

    logger.info(f'budget_import | {method} {path} | jobId={job_id}')

    # All routes are admin-only
    try:
        require_admin(event)
    except PermissionDenied:
        return forbidden_response()

    if method == 'GET' and path.endswith('/budgets/template'):
        return _download_template()

    if method == 'POST' and path.endswith('/budgets/import'):
        return _start_import(event, body)

    if method == 'GET' and job_id and path.endswith(f'/budgets/import/{job_id}'):
        return _get_preview(job_id)

    if method == 'POST' and job_id and path.endswith('/commit'):
        return _commit(event, job_id)

    return _cors(405, {'error': f'Method {method} not supported on this path'})
