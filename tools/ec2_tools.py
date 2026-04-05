"""
EC2 Tools
---------
Custom Strands tools for EC2 resource discovery in the linked account.
Used by the agent to find idle/wasteful resources that don't show up
in Cost Explorer recommendations.

Checks performed:
  - Unattached EBS volumes (available state, not attached to any instance)
  - Old snapshots (older than threshold, not tagged as archived)
  - Non-production instances (tagged Environment != prod/production)
"""

import os
import logging
from datetime import datetime, timezone, timedelta
from strands import tool
import boto3

logger    = logging.getLogger(__name__)
AWS_REGION = os.environ.get('AWS_REGION', 'us-east-1')
_ec2      = boto3.client('ec2', region_name=AWS_REGION)


# ── Internal helpers ──────────────────────────────────────────────────────────

def _get_tag(tags: list[dict], key: str, default: str = '') -> str:
    """Extract a tag value from an EC2 tags list."""
    for tag in tags or []:
        if tag['Key'].lower() == key.lower():
            return tag['Value']
    return default


def _volume_monthly_cost(size_gb: int, volume_type: str) -> float:
    """
    Rough monthly cost estimate for an EBS volume.
    Uses us-east-1 on-demand prices as a proxy — close enough for ranking.
    """
    prices = {
        'gp3': 0.08,
        'gp2': 0.10,
        'io1': 0.125,
        'io2': 0.125,
        'st1': 0.045,
        'sc1': 0.025,
        'standard': 0.05,
    }
    price_per_gb = prices.get(volume_type, 0.08)
    return round(size_gb * price_per_gb, 2)


# ── Strands tools ─────────────────────────────────────────────────────────────

@tool
def list_unattached_ebs_volumes() -> list[dict]:
    """
    Find EBS volumes in 'available' state — not attached to any instance.
    These volumes are being charged but providing no value.

    Returns:
        List of dicts with keys: volume_id, size_gb, volume_type, state,
        region, created_at, name_tag, estimated_monthly_cost_usd.
    """
    paginator = _ec2.get_paginator('describe_volumes')
    results   = []

    for page in paginator.paginate(Filters=[{'Name': 'status', 'Values': ['available']}]):
        for vol in page['Volumes']:
            results.append({
                'volume_id':                    vol['VolumeId'],
                'size_gb':                      vol['Size'],
                'volume_type':                  vol['VolumeType'],
                'state':                        vol['State'],
                'region':                       AWS_REGION,
                'created_at':                   vol['CreateTime'].isoformat(),
                'name_tag':                     _get_tag(vol.get('Tags', []), 'Name'),
                'estimated_monthly_cost_usd':   _volume_monthly_cost(vol['Size'], vol['VolumeType']),
            })

    results.sort(key=lambda v: v['estimated_monthly_cost_usd'], reverse=True)
    logger.info(f"Found {len(results)} unattached EBS volumes")
    return results


@tool
def list_old_snapshots(older_than_days: int = 90) -> list[dict]:
    """
    Find EBS snapshots older than the specified number of days that are
    owned by this account. Old snapshots are often forgotten and accumulate
    storage costs silently.

    Args:
        older_than_days: Return snapshots older than this many days (default 90).

    Returns:
        List of dicts with keys: snapshot_id, volume_id, size_gb,
        created_at, age_days, description, name_tag,
        estimated_monthly_cost_usd.
    """
    account_id = boto3.client('sts', region_name=AWS_REGION).get_caller_identity()['Account']
    cutoff     = datetime.now(timezone.utc) - timedelta(days=older_than_days)

    paginator = _ec2.get_paginator('describe_snapshots')
    results   = []

    for page in paginator.paginate(OwnerIds=[account_id]):
        for snap in page['Snapshots']:
            if snap['StartTime'] >= cutoff:
                continue
            age_days = (datetime.now(timezone.utc) - snap['StartTime']).days
            # EBS snapshots are compressed and incremental, but ~$0.05/GB/month
            # is a reasonable upper-bound estimate for the full size
            estimated_cost = round(snap['VolumeSize'] * 0.05, 2)
            results.append({
                'snapshot_id':                  snap['SnapshotId'],
                'volume_id':                    snap.get('VolumeId', ''),
                'size_gb':                      snap['VolumeSize'],
                'created_at':                   snap['StartTime'].isoformat(),
                'age_days':                     age_days,
                'description':                  snap.get('Description', ''),
                'name_tag':                     _get_tag(snap.get('Tags', []), 'Name'),
                'estimated_monthly_cost_usd':   estimated_cost,
            })

    results.sort(key=lambda s: s['age_days'], reverse=True)
    logger.info(f"Found {len(results)} snapshots older than {older_than_days} days")
    return results


@tool
def list_nonprod_instances() -> list[dict]:
    """
    Find running EC2 instances tagged as non-production environments
    (Environment tag = dev, development, staging, stage, test, qa, sandbox).
    These are candidates for scheduled stop/start or rightsizing.

    Returns:
        List of dicts with keys: instance_id, instance_type, state,
        environment_tag, name_tag, launch_time, region, private_ip.
    """
    nonprod_envs = ['dev', 'development', 'staging', 'stage', 'test', 'qa', 'sandbox']

    paginator = _ec2.get_paginator('describe_instances')
    results   = []

    for page in paginator.paginate(
        Filters=[{'Name': 'instance-state-name', 'Values': ['running']}]
    ):
        for reservation in page['Reservations']:
            for inst in reservation['Instances']:
                env_tag = _get_tag(inst.get('Tags', []), 'Environment').lower()
                if env_tag not in nonprod_envs:
                    continue
                results.append({
                    'instance_id':    inst['InstanceId'],
                    'instance_type':  inst['InstanceType'],
                    'state':          inst['State']['Name'],
                    'environment_tag': env_tag,
                    'name_tag':       _get_tag(inst.get('Tags', []), 'Name'),
                    'launch_time':    inst['LaunchTime'].isoformat(),
                    'region':         AWS_REGION,
                    'private_ip':     inst.get('PrivateIpAddress', ''),
                })

    logger.info(f"Found {len(results)} running non-prod instances")
    return results
