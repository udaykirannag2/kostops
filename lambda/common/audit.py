"""
audit.py
--------
Immutable mutation log for KostOps.

Every write across the product — findings status updates, integrations config,
scopes/budgets/allocations, report definitions, reliability runbook runs — must
land one row in the `AuditEvents` DynamoDB table so operators can answer "who
changed X, when, and why".

Schema (see stacks/data-stack.ts):
  PK  entityType#entityId   e.g. "Finding#f-123", "Integration#slack"
  SK  ts#eventId             ISO 8601 + short UUID for uniqueness
  actorSub       Cognito sub of the user that made the change
  actorEmail     optional — convenience for UI
  action         short verb: CREATE, UPDATE, DELETE, STATUS_CHANGE, …
  before         JSON of the entity prior to the change (or null on CREATE)
  after          JSON of the entity after the change (or null on DELETE)
  source         UI | CHAT | CSV | API | CRON | SELF_HEAL
  requestId     optional — X-Ray / API Gateway request id for correlation

Usage:

    from common.audit import write_audit

    write_audit(
        event,
        action='STATUS_CHANGE',
        entity_type='Finding',
        entity_id=finding_id,
        before={'status': 'OPEN'},
        after={'status': 'RESOLVED'},
        source='UI',
    )

Design note: we do NOT fail the business mutation if the audit write fails —
we log loudly and return. Audit completeness is backstopped by CloudWatch Logs
and the CI grep in `scripts/check_rbac.sh`. The caller-controlled `fail_closed`
argument is available for high-risk paths that must refuse to mutate without
an audit trail.
"""

from __future__ import annotations

import os
import json
import uuid
import logging
from datetime import datetime, timezone
from decimal import Decimal
from typing import Any, Optional

import boto3

from .roles import get_user_sub, get_user_email

logger = logging.getLogger(__name__)

AUDIT_TABLE = os.environ.get('AUDIT_TABLE', 'kostops-audit-events')
AWS_REGION  = os.environ.get('AWS_REGION',  'us-east-1')

_ddb   = boto3.resource('dynamodb', region_name=AWS_REGION)
_table = _ddb.Table(AUDIT_TABLE)


def _to_ddb(value: Any) -> Any:
    """
    Recursively prepare a Python value for DynamoDB put_item.
    Floats → Decimal (DynamoDB rejects raw floats).
    """
    if isinstance(value, float):
        return Decimal(str(value))
    if isinstance(value, dict):
        return {k: _to_ddb(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_to_ddb(v) for v in value]
    return value


def write_audit(
    event: Optional[dict],
    *,
    action:      str,
    entity_type: str,
    entity_id:   str,
    before:      Any = None,
    after:       Any = None,
    source:      str = 'UI',
    actor_sub:   Optional[str] = None,
    actor_email: Optional[str] = None,
    fail_closed: bool = False,
) -> str:
    """
    Append one immutable audit row. Returns the event ID.

    Either pass the Lambda `event` to auto-extract the actor from claims, or
    pass `actor_sub` / `actor_email` explicitly (cron jobs, self-heal, etc.).

    When `fail_closed=True`, any write failure is re-raised so the caller can
    refuse to commit the business mutation. Default is log-and-continue.
    """
    sub   = actor_sub   or (get_user_sub(event)   if event else 'system')
    email = actor_email or (get_user_email(event) if event else '')

    now      = datetime.now(timezone.utc).isoformat()
    event_id = uuid.uuid4().hex[:12]

    item = {
        'pk':         f'{entity_type}#{entity_id}',
        'sk':         f'{now}#{event_id}',
        'actorSub':   sub,
        'actorEmail': email,
        'action':     action,
        'before':     _to_ddb(before) if before is not None else None,
        'after':      _to_ddb(after)  if after  is not None else None,
        'source':     source,
        'ts':         now,
        'eventId':    event_id,
        'entityType': entity_type,
        'entityId':   entity_id,
    }
    # DynamoDB rejects None values at the top level — drop them
    item = {k: v for k, v in item.items() if v is not None}

    try:
        _table.put_item(Item=item)
        logger.info(
            f"audit | {action} | {entity_type}#{entity_id} "
            f"| actor={sub[:8]}... | source={source} | event={event_id}"
        )
    except Exception as e:
        logger.error(
            f"audit write failed | {action} | {entity_type}#{entity_id} "
            f"| actor={sub[:8]}... | err={e}"
        )
        if fail_closed:
            raise

    return event_id


def list_events(entity_type: str, entity_id: str, *, limit: int = 50) -> list[dict]:
    """Return audit rows for a single entity, newest first. Used by /audit API."""
    from boto3.dynamodb.conditions import Key

    resp = _table.query(
        KeyConditionExpression=Key('pk').eq(f'{entity_type}#{entity_id}'),
        ScanIndexForward=False,
        Limit=limit,
    )
    return resp.get('Items', [])
