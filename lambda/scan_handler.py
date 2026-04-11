"""
Scan Handler — Proactive Daily Findings
----------------------------------------
Runs daily at 07:00 UTC via EventBridge.

Sources queried (no agent / no LLM — direct boto3 API calls):
  1. Cost Optimization Hub  — cross-service recommendations (rightsizing, idle)
  2. Compute Optimizer      — over-provisioned EC2 instances
  3. Cost Explorer Anomalies — active spend anomalies
  4. EC2                    — unattached EBS volumes, old snapshots (>90 days)

Design decisions:
  - Idempotent: dedup key = (type + resourceId). If an identical OPEN finding
    already exists for the same resource, skip it — no duplicates on re-run.
  - Non-destructive: never touches RESOLVED or IGNORED findings.
  - Non-fatal per source: if Cost Optimization Hub fails (e.g. not enabled),
    still runs all other sources and logs a warning.
  - Payer credentials: assumes payer cross-account role when PAYER_ROLE_ARN is set.
  - Target: writes up to 100 findings per run (highest-savings first).

Environment variables:
  FINDINGS_TABLE          — DynamoDB table name
  PAYER_ROLE_ARN          — Cross-account role to assume for Cost Explorer / COH
  PAYER_ACCOUNT_ID        — Payer account ID (for Cost Optimization Hub)
  AWS_REGION              — default 'us-east-1'
  LOG_LEVEL               — default 'INFO'
  MAX_FINDINGS_PER_RUN    — default '100'
"""

import os
import json
import uuid
import time
import logging
from datetime import datetime, timezone, timedelta
from decimal import Decimal

import boto3
from botocore.exceptions import ClientError

logger = logging.getLogger()
logger.setLevel(os.environ.get('LOG_LEVEL', 'INFO'))

FINDINGS_TABLE      = os.environ.get('FINDINGS_TABLE',       'kostops-findings')
PAYER_ROLE_ARN      = os.environ.get('PAYER_ROLE_ARN',       '')
PAYER_ACCOUNT_ID    = os.environ.get('PAYER_ACCOUNT_ID',     '')
AWS_REGION          = os.environ.get('AWS_REGION',           'us-east-1')
MAX_PER_RUN         = int(os.environ.get('MAX_FINDINGS_PER_RUN', '100'))
TTL_DAYS            = 30

_ddb = boto3.resource('dynamodb', region_name=AWS_REGION)
_table = _ddb.Table(FINDINGS_TABLE)


# ── Entry point ───────────────────────────────────────────────────────────────

def handler(event, context):
    """
    EventBridge scheduled event OR direct invoke from CDK bootstrap.
    Returns a summary dict (used by CDK AwsCustomResource response).
    """
    logger.info('Starting proactive scan...')
    start = time.time()

    # Build boto3 clients — use payer cross-account role if available
    clients = _build_clients()

    # Collect findings from all sources (non-fatal per source)
    findings = []
    findings += _scan_cost_optimization_hub(clients)
    findings += _scan_compute_optimizer(clients)
    findings += _scan_cost_anomalies(clients)
    findings += _scan_unattached_ebs(clients)
    findings += _scan_old_snapshots(clients)

    # Sort by savings descending, cap at MAX_PER_RUN
    findings.sort(key=lambda f: f.get('estimatedMonthlySavings', 0), reverse=True)
    findings = findings[:MAX_PER_RUN]

    # Load existing OPEN findings for dedup
    existing_keys = _load_existing_open_keys()

    # Write new findings to DynamoDB (skip duplicates)
    written = 0
    skipped = 0
    now = datetime.now(timezone.utc)

    for f in findings:
        dedup_key = f'{f["type"]}#{f.get("resourceId", "")}'
        if dedup_key in existing_keys:
            skipped += 1
            continue

        item = {
            'findingId':               str(uuid.uuid4()),
            'createdAt':               now.isoformat(),
            'updatedAt':               now.isoformat(),
            'status':                  'OPEN',
            'type':                    f['type'],
            'title':                   f['title'],
            'description':             f['description'],
            'estimatedMonthlySavings': Decimal(str(round(f.get('estimatedMonthlySavings', 0), 2))),
            'ttl':                     int(now.timestamp()) + (TTL_DAYS * 86400),
        }
        if f.get('resourceId'):
            item['resourceId']   = f['resourceId']
        if f.get('resourceType'):
            item['resourceType'] = f['resourceType']

        try:
            _table.put_item(Item=item)
            written += 1
            existing_keys.add(dedup_key)   # prevent dupes within same run
        except Exception as e:
            logger.error(f'Failed to write finding {f["title"]}: {e}')

    duration = round(time.time() - start, 1)
    summary = {
        'scanned': len(findings),
        'written': written,
        'skipped': skipped,
        'durationSeconds': duration,
    }
    logger.info(f'Scan complete: {json.dumps(summary)}')
    return summary


# ── Payer credentials ─────────────────────────────────────────────────────────

def _build_clients() -> dict:
    """Return boto3 clients, using payer cross-account role if PAYER_ROLE_ARN is set."""
    if PAYER_ROLE_ARN:
        try:
            sts  = boto3.client('sts', region_name=AWS_REGION)
            creds = sts.assume_role(
                RoleArn=PAYER_ROLE_ARN,
                RoleSessionName='kostops-scan',
            )['Credentials']
            kwargs = {
                'aws_access_key_id':     creds['AccessKeyId'],
                'aws_secret_access_key': creds['SecretAccessKey'],
                'aws_session_token':     creds['SessionToken'],
                'region_name':           AWS_REGION,
            }
            logger.info(f'Assumed payer role: {PAYER_ROLE_ARN}')
        except Exception as e:
            logger.warning(f'Could not assume payer role {PAYER_ROLE_ARN}: {e} — using linked-account creds')
            kwargs = {'region_name': AWS_REGION}
    else:
        kwargs = {'region_name': AWS_REGION}

    return {
        'ce':   boto3.client('ce',               **kwargs),
        'coh':  boto3.client('cost-optimization-hub', **kwargs),
        'co':   boto3.client('compute-optimizer', **kwargs),
        'ec2':  boto3.client('ec2',              **kwargs),
    }


# ── Dedup helper ─────────────────────────────────────────────────────────────

def _load_existing_open_keys() -> set:
    """
    Return a set of 'type#resourceId' strings for all currently OPEN findings.
    Uses the status-index GSI. Non-fatal on failure.
    """
    keys = set()
    try:
        from boto3.dynamodb.conditions import Key
        resp = _table.query(
            IndexName='status-index',
            KeyConditionExpression=Key('status').eq('OPEN'),
            ProjectionExpression='#t, resourceId',
            ExpressionAttributeNames={'#t': 'type'},
        )
        for item in resp.get('Items', []):
            keys.add(f'{item["type"]}#{item.get("resourceId", "")}')
        # Paginate if needed
        while 'LastEvaluatedKey' in resp:
            resp = _table.query(
                IndexName='status-index',
                KeyConditionExpression=Key('status').eq('OPEN'),
                ProjectionExpression='#t, resourceId',
                ExpressionAttributeNames={'#t': 'type'},
                ExclusiveStartKey=resp['LastEvaluatedKey'],
            )
            for item in resp.get('Items', []):
                keys.add(f'{item["type"]}#{item.get("resourceId", "")}')
    except Exception as e:
        logger.warning(f'Could not load existing findings for dedup: {e}')
    logger.info(f'Loaded {len(keys)} existing OPEN finding keys for dedup')
    return keys


# ══════════════════════════════════════════════════════════════════════════════
# Source 1 — Cost Optimization Hub
# ══════════════════════════════════════════════════════════════════════════════

def _scan_cost_optimization_hub(clients: dict) -> list:
    """
    Fetch grouped savings summaries from Cost Optimization Hub.
    Returns up to 50 row(s) with estimatedMonthlySavings > $5 per group.
    Non-fatal: returns [] if COH is not enabled or not accessible.
    """
    findings = []
    try:
        paginator = clients['coh'].get_paginator('list_recommendation_summaries')
        for page in paginator.paginate(
            groupBy='ActionType',
            PaginationConfig={'MaxItems': 50},
        ):
            for rec in page.get('items', []):
                savings = float(rec.get('estimatedMonthlySavings') or 0)
                if savings < 5:
                    continue
                group = rec.get('group') or 'OTHER'
                count = int(rec.get('recommendationCount') or 0)
                finding_type = _coh_type_map(group)
                findings.append({
                    'type':                    finding_type,
                    'title':                   f'Cost Optimization Hub ({group}): {count} recommendation(s)',
                    'description':             (
                        f'{count} grouped recommendation(s) for action type "{group}". '
                        f'Estimated savings: ${savings:.2f}/month. Review in Cost Optimization Hub.'
                    ),
                    'estimatedMonthlySavings': savings,
                    'resourceId':              f'coh:{group}',
                    'resourceType':            'cost-optimization-hub:summary',
                })
    except ClientError as e:
        code = e.response['Error']['Code']
        if code in ('AccessDeniedException', 'OptInRequiredException', 'ResourceNotFoundException'):
            logger.warning(f'Cost Optimization Hub not available: {code}')
        else:
            logger.warning(f'Cost Optimization Hub error: {e}')
    except Exception as e:
        logger.warning(f'Cost Optimization Hub scan failed: {e}')

    logger.info(f'Cost Optimization Hub: {len(findings)} findings')
    return findings


def _coh_type_map(action_or_group: str) -> str:
    t = (action_or_group or '').lower()
    if 'rightsize' in t or 'resize' in t: return 'RIGHTSIZING'
    if 'savings' in t or 'commitment' in t or 'reserved' in t: return 'SAVINGS_PLAN'
    if 'idle' in t or 'unused' in t or 'stop' in t: return 'IDLE_EC2'
    if 'ebs' in t or 'volume' in t or 'storage' in t: return 'UNATTACHED_EBS'
    if 'graviton' in t or 'upgrade' in t: return 'OTHER'
    return 'OTHER'


# ══════════════════════════════════════════════════════════════════════════════
# Source 2 — Compute Optimizer (EC2 rightsizing)
# ══════════════════════════════════════════════════════════════════════════════

def _scan_compute_optimizer(clients: dict) -> list:
    """
    Fetch over-provisioned EC2 instance recommendations from Compute Optimizer.
    Only includes recommendations with finding = OVER_PROVISIONED and savings > $5.
    """
    findings = []
    try:
        paginator = clients['co'].get_paginator('get_ec2_instance_recommendations')
        for page in paginator.paginate():
            for rec in page.get('InstanceRecommendations', []):
                if rec.get('Finding') != 'OVER_PROVISIONED':
                    continue
                instance_id   = rec.get('InstanceId', '')
                instance_name = rec.get('InstanceName') or instance_id
                current_type  = rec.get('CurrentInstanceType', '')

                # Pick the top recommendation option (first = highest savings)
                options = rec.get('RecommendationOptions', [])
                if not options:
                    continue
                best = options[0]
                recommended_type = best.get('InstanceType', '')
                savings = 0.0
                so = best.get('SavingsOpportunity') or {}
                est = so.get('EstimatedMonthlySavings')
                if isinstance(est, dict):
                    savings = float(est.get('Value') or 0)
                elif est is not None:
                    savings = float(est)

                if savings < 5:
                    continue

                findings.append({
                    'type':                    'RIGHTSIZING',
                    'title':                   f'Over-provisioned EC2: {instance_name}',
                    'description':             (
                        f'Instance {instance_id} ({current_type}) is over-provisioned. '
                        f'Compute Optimizer recommends downsizing to {recommended_type}. '
                        f'Estimated saving: ${savings:.2f}/month.'
                    ),
                    'estimatedMonthlySavings': savings,
                    'resourceId':              instance_id,
                    'resourceType':            'ec2:instance',
                })
    except ClientError as e:
        code = e.response['Error']['Code']
        if code in ('AccessDeniedException', 'OptInRequiredException'):
            logger.warning(f'Compute Optimizer not available: {code}. Enable it in the console.')
        else:
            logger.warning(f'Compute Optimizer error: {e}')
    except Exception as e:
        logger.warning(f'Compute Optimizer scan failed: {e}')

    logger.info(f'Compute Optimizer: {len(findings)} findings')
    return findings


# ══════════════════════════════════════════════════════════════════════════════
# Source 3 — Cost Explorer Anomalies
# ══════════════════════════════════════════════════════════════════════════════

def _scan_cost_anomalies(clients: dict) -> list:
    """
    Fetch active cost anomalies from Cost Explorer.
    Reports anomalies with impact > $50 as OPEN findings.
    """
    findings = []
    try:
        today = datetime.now(timezone.utc).date()
        resp  = clients['ce'].get_anomalies(
            DateInterval={
                'StartDate': (today - timedelta(days=7)).isoformat(),
                'EndDate':   today.isoformat(),
            },
            MaxResults=20,
        )
        for anomaly in resp.get('Anomalies', []):
            impact  = anomaly.get('Impact', {})
            total   = float(impact.get('TotalImpact', 0))
            if total < 50:
                continue

            dim     = anomaly.get('AnomalyDetails', {})
            service = dim.get('Service', anomaly.get('AnomalyId', 'Unknown service'))
            start   = anomaly.get('AnomalyStartDate', '')
            findings.append({
                'type':                    'OTHER',
                'title':                   f'Cost anomaly detected: {service}',
                'description':             (
                    f'Unusual spend detected for {service} starting {start}. '
                    f'Total impact: ${total:.2f}. '
                    'Review the Cost Explorer Anomaly Detection page for details.'
                ),
                'estimatedMonthlySavings': round(total, 2),
                'resourceId':              anomaly.get('AnomalyId', ''),
                'resourceType':            'billing:anomaly',
            })
    except ClientError as e:
        logger.warning(f'Cost anomalies error: {e}')
    except Exception as e:
        logger.warning(f'Cost anomalies scan failed: {e}')

    logger.info(f'Cost anomalies: {len(findings)} findings')
    return findings


# ══════════════════════════════════════════════════════════════════════════════
# Source 4 — Unattached EBS Volumes
# ══════════════════════════════════════════════════════════════════════════════

def _scan_unattached_ebs(clients: dict) -> list:
    """
    Find EBS volumes in 'available' state (not attached to any instance).
    Estimates savings based on volume size and type.
    """
    findings = []
    # EBS price per GB/month (approximate, us-east-1 on-demand)
    price_per_gb = {'gp3': 0.08, 'gp2': 0.10, 'io1': 0.125, 'io2': 0.125,
                    'st1': 0.045, 'sc1': 0.025, 'standard': 0.05}
    try:
        paginator = clients['ec2'].get_paginator('describe_volumes')
        for page in paginator.paginate(Filters=[{'Name': 'status', 'Values': ['available']}]):
            for vol in page.get('Volumes', []):
                size     = vol.get('Size', 0)
                vol_type = vol.get('VolumeType', 'gp2')
                price    = price_per_gb.get(vol_type, 0.10)
                savings  = round(size * price, 2)

                if savings < 1:
                    continue

                vol_id = vol.get('VolumeId', '')
                name   = _get_tag(vol, 'Name') or vol_id
                az     = vol.get('AvailabilityZone', '')

                findings.append({
                    'type':                    'UNATTACHED_EBS',
                    'title':                   f'Unattached EBS volume: {name}',
                    'description':             (
                        f'Volume {vol_id} ({size} GB {vol_type}) in {az} is not attached '
                        f'to any instance. Estimated cost: ${savings:.2f}/month. '
                        'Delete or snapshot it to eliminate this cost.'
                    ),
                    'estimatedMonthlySavings': savings,
                    'resourceId':              vol_id,
                    'resourceType':            'ec2:volume',
                })
    except ClientError as e:
        logger.warning(f'EBS scan error: {e}')
    except Exception as e:
        logger.warning(f'EBS scan failed: {e}')

    logger.info(f'Unattached EBS volumes: {len(findings)} findings')
    return findings


# ══════════════════════════════════════════════════════════════════════════════
# Source 5 — Old Snapshots (>90 days)
# ══════════════════════════════════════════════════════════════════════════════

def _scan_old_snapshots(clients: dict) -> list:
    """
    Find EBS snapshots older than 90 days owned by this account.
    Estimates savings at $0.05/GB/month (standard snapshot storage).
    """
    findings   = []
    price_per_gb = 0.05   # $/GB/month for EBS snapshots
    cutoff     = datetime.now(timezone.utc) - timedelta(days=90)

    try:
        # Get caller account ID for owner filter
        account_id = boto3.client('sts', region_name=AWS_REGION).get_caller_identity()['Account']
        paginator  = clients['ec2'].get_paginator('describe_snapshots')
        for page in paginator.paginate(OwnerIds=[account_id]):
            for snap in page.get('Snapshots', []):
                start_time = snap.get('StartTime')
                if start_time and start_time.replace(tzinfo=timezone.utc) > cutoff:
                    continue

                size    = snap.get('VolumeSize', 0)
                savings = round(size * price_per_gb, 2)
                if savings < 1:
                    continue

                snap_id = snap.get('SnapshotId', '')
                name    = _get_tag(snap, 'Name') or snap_id
                age_days = (datetime.now(timezone.utc) - start_time.replace(tzinfo=timezone.utc)).days if start_time else 0

                findings.append({
                    'type':                    'OLD_SNAPSHOT',
                    'title':                   f'Old EBS snapshot: {name}',
                    'description':             (
                        f'Snapshot {snap_id} ({size} GB) is {age_days} days old. '
                        f'Estimated storage cost: ${savings:.2f}/month. '
                        'Review and delete if no longer needed.'
                    ),
                    'estimatedMonthlySavings': savings,
                    'resourceId':              snap_id,
                    'resourceType':            'ec2:snapshot',
                })
    except ClientError as e:
        logger.warning(f'Snapshot scan error: {e}')
    except Exception as e:
        logger.warning(f'Snapshot scan failed: {e}')

    logger.info(f'Old snapshots: {len(findings)} findings')
    return findings


# ── Utilities ─────────────────────────────────────────────────────────────────

def _get_tag(resource: dict, key: str) -> str:
    """Extract a tag value from a boto3 resource dict."""
    for tag in resource.get('Tags', []):
        if tag.get('Key') == key:
            return tag.get('Value', '')
    return ''
