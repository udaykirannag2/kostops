"""
Slack Handler
-------------
Lambda function that sends KostOps notifications to Slack.

Two use cases:
  1. Daily digest  — triggered by EventBridge schedule (9am weekdays)
                     summarises top OPEN findings and total estimated savings
  2. On-demand     — POST /slack/digest from the UI triggers an immediate send

Slack message format:
  *KostOps Daily Digest — 2026-04-04*
  Total estimated savings: $1,234/month across 7 findings

  1. 🔴 $450/mo — 3 unattached EBS volumes (gp3, 500 GB total)
  2. 🟡 $320/mo — EC2 rightsizing: i-0abc running at 4% CPU avg
  3. 🟡 $200/mo — 47 snapshots older than 90 days
  ...
  View in KostOps → https://d1234.cloudfront.net
"""

import os
import json
import logging
import urllib.request
import urllib.error
from datetime import date
import boto3
from boto3.dynamodb.conditions import Key

logger            = logging.getLogger()
logger.setLevel(os.environ.get('LOG_LEVEL', 'INFO'))

FINDINGS_TABLE    = os.environ['FINDINGS_TABLE']
SLACK_WEBHOOK_URL = os.environ.get('SLACK_WEBHOOK_URL', '')
AWS_REGION        = os.environ.get('AWS_REGION', 'us-east-1')

_ddb   = boto3.resource('dynamodb', region_name=AWS_REGION)
_table = _ddb.Table(FINDINGS_TABLE)

# Emoji by finding type
TYPE_EMOJI = {
    'IDLE_EC2':      '🖥️',
    'UNATTACHED_EBS': '💾',
    'OLD_SNAPSHOT':  '📸',
    'RIGHTSIZING':   '📐',
    'SAVINGS_PLAN':  '💰',
    'OTHER':         '🔍',
}

# Severity colour by savings amount
def _severity_emoji(savings: float) -> str:
    if savings >= 200:
        return '🔴'
    if savings >= 50:
        return '🟡'
    return '🟢'


def _get_open_findings(limit: int = 10) -> list[dict]:
    response = _table.query(
        IndexName='status-index',
        KeyConditionExpression=Key('status').eq('OPEN'),
        ScanIndexForward=False,
        Limit=50,
    )
    findings = response.get('Items', [])
    findings.sort(
        key=lambda f: float(f.get('estimatedMonthlySavings', 0)),
        reverse=True,
    )
    return findings[:limit]


def _format_digest(findings: list[dict]) -> str:
    today         = date.today().isoformat()
    total_savings = sum(float(f.get('estimatedMonthlySavings', 0)) for f in findings)

    lines = [
        f"*KostOps Daily Digest — {today}*",
        f"Total estimated savings: *${total_savings:,.0f}/month* across {len(findings)} open finding(s)\n",
    ]

    for i, finding in enumerate(findings, 1):
        savings     = float(finding.get('estimatedMonthlySavings', 0))
        ftype       = finding.get('type', 'OTHER')
        title       = finding.get('title', 'Untitled')
        severity    = _severity_emoji(savings)
        type_icon   = TYPE_EMOJI.get(ftype, '🔍')
        lines.append(f"{i}. {severity} {type_icon} *${savings:,.0f}/mo* — {title}")

    if not findings:
        lines.append('✅ No open findings. Your AWS spend looks clean!')

    return '\n'.join(lines)


def _send_to_slack(message: str) -> None:
    if not SLACK_WEBHOOK_URL:
        logger.warning("SLACK_WEBHOOK_URL not set — skipping Slack notification")
        return

    payload = json.dumps({'text': message}).encode('utf-8')
    req     = urllib.request.Request(
        SLACK_WEBHOOK_URL,
        data=payload,
        headers={'Content-Type': 'application/json'},
        method='POST',
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            logger.info(f"Slack response: {resp.status}")
    except urllib.error.HTTPError as e:
        logger.error(f"Slack webhook error {e.code}: {e.read().decode()}")
        raise


def _cors_response(status_code: int, body: dict) -> dict:
    return {
        'statusCode': status_code,
        'headers': {
            'Content-Type':                'application/json',
            'Access-Control-Allow-Origin': '*',
        },
        'body': json.dumps(body),
    }


def handler(event: dict, context) -> dict:
    logger.info("Slack digest triggered")

    findings = _get_open_findings(limit=10)
    message  = _format_digest(findings)

    try:
        _send_to_slack(message)
    except Exception as e:
        logger.error(f"Failed to send Slack digest: {e}")
        return _cors_response(502, {'error': str(e)})

    logger.info(f"Sent Slack digest with {len(findings)} findings")
    return _cors_response(200, {
        'sent':     True,
        'findings': len(findings),
        'message':  message,
    })
