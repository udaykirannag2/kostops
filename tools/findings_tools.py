"""
Findings Tools
--------------
Custom Strands tools for persisting savings opportunities (findings)
to DynamoDB. The React UI reads findings from the same table via the API.

Finding lifecycle:
  OPEN → agent creates it when it detects a savings opportunity
  RESOLVED → engineer marks it done after applying the fix
  IGNORED → engineer dismisses it (e.g. volume is intentionally unattached)

TTL: findings auto-expire after 30 days unless updated.
"""

import os
import uuid
import logging
from datetime import datetime, timezone, timedelta
from strands import tool
import boto3
from boto3.dynamodb.conditions import Key, Attr

logger         = logging.getLogger(__name__)
FINDINGS_TABLE = os.environ.get('FINDINGS_TABLE', 'kostops-findings')
AWS_REGION     = os.environ.get('AWS_REGION', 'us-east-1')

_ddb   = boto3.resource('dynamodb', region_name=AWS_REGION)
_table = _ddb.Table(FINDINGS_TABLE)

# Valid finding types and statuses
VALID_TYPES    = {'IDLE_EC2', 'UNATTACHED_EBS', 'OLD_SNAPSHOT', 'RIGHTSIZING', 'SAVINGS_PLAN', 'OTHER'}
VALID_STATUSES = {'OPEN', 'RESOLVED', 'IGNORED'}
TTL_DAYS       = 30


# ── Strands tools ─────────────────────────────────────────────────────────────

@tool
def save_finding(
    title: str,
    description: str,
    finding_type: str,
    estimated_monthly_savings: float,
    resource_id: str = '',
    resource_type: str = '',
) -> dict:
    """
    Save a new savings opportunity finding to DynamoDB.
    Call this whenever you identify a cost optimization opportunity so it
    appears in the KostOps UI dashboard.

    Args:
        title:                     Short human-readable title (max 200 chars).
        description:               Detailed explanation from the agent.
        finding_type:              One of: IDLE_EC2, UNATTACHED_EBS, OLD_SNAPSHOT,
                                   RIGHTSIZING, SAVINGS_PLAN, OTHER.
        estimated_monthly_savings: Estimated USD savings per month.
        resource_id:               AWS resource ID (optional, e.g. i-1234abcd).
        resource_type:             Resource type (optional, e.g. ec2:instance).

    Returns:
        Dict with the saved finding including its generated findingId.
    """
    if finding_type not in VALID_TYPES:
        finding_type = 'OTHER'

    now        = datetime.now(timezone.utc)
    finding_id = str(uuid.uuid4())
    created_at = now.isoformat()
    ttl        = int((now + timedelta(days=TTL_DAYS)).timestamp())

    item = {
        'findingId':                finding_id,
        'createdAt':                created_at,
        'status':                   'OPEN',
        'type':                     finding_type,
        'title':                    title[:200],
        'description':              description,
        'estimatedMonthlySavings':  str(round(estimated_monthly_savings, 2)),
        'resourceId':               resource_id,
        'resourceType':             resource_type,
        'ttl':                      ttl,
    }

    _table.put_item(Item=item)
    logger.info(f"Saved finding {finding_id}: {title}")
    return item


@tool
def list_findings(
    status: str = 'OPEN',
    limit: int = 50,
) -> list[dict]:
    """
    List findings filtered by status, sorted by estimated savings descending.
    Use this at the start of an optimization session to see what's already known.

    Args:
        status: Filter by status: OPEN, RESOLVED, or IGNORED (default OPEN).
        limit:  Maximum number of findings to return (default 50).

    Returns:
        List of finding dicts sorted by estimatedMonthlySavings descending.
    """
    if status not in VALID_STATUSES:
        status = 'OPEN'

    response = _table.query(
        IndexName='status-index',
        KeyConditionExpression=Key('status').eq(status),
        ScanIndexForward=False,   # newest first by createdAt
        Limit=limit,
    )

    findings = response.get('Items', [])
    # Sort by estimated savings so highest-value items come first
    findings.sort(
        key=lambda f: float(f.get('estimatedMonthlySavings', 0)),
        reverse=True,
    )
    return findings


@tool
def get_finding(finding_id: str, created_at: str) -> dict | None:
    """
    Retrieve a single finding by its ID and creation timestamp.

    Args:
        finding_id: The UUID of the finding.
        created_at: The ISO 8601 creation timestamp (sort key).

    Returns:
        The finding dict, or None if not found.
    """
    response = _table.get_item(
        Key={'findingId': finding_id, 'createdAt': created_at}
    )
    return response.get('Item')
