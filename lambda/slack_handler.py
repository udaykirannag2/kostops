"""
Slack Handler
-------------
Sends KostOps digest notifications to Slack.

Two triggers:
  1. Daily digest  — EventBridge schedule (9am weekdays)
  2. On-demand     — POST /slack/digest from the UI

Webhook URL is read from SSM (set via the Integrations page) rather than
a hardcoded env var. This allows customers to update their Slack config
without a CDK redeploy.

Message format uses Slack Block Kit for rich formatting.
"""

import os
import json
import logging
import urllib.request
import urllib.error
from datetime import date

import boto3
from boto3.dynamodb.conditions import Key

logger              = logging.getLogger()
logger.setLevel(os.environ.get('LOG_LEVEL', 'INFO'))

FINDINGS_TABLE      = os.environ['FINDINGS_TABLE']
INTEGRATIONS_TABLE  = os.environ.get('INTEGRATIONS_TABLE', 'kostops-integrations')
AWS_REGION          = os.environ.get('AWS_REGION', 'us-east-1')
SSM_WEBHOOK_KEY     = '/kostops/integrations/slack/webhookUrl'

_ddb          = boto3.resource('dynamodb', region_name=AWS_REGION)
_findings_tbl = _ddb.Table(FINDINGS_TABLE)
_integ_tbl    = _ddb.Table(INTEGRATIONS_TABLE)
_ssm          = boto3.client('ssm', region_name=AWS_REGION)


# ── Config helpers ────────────────────────────────────────────────────────────

def _get_slack_config() -> dict:
    """Load Slack integration config from DynamoDB."""
    try:
        resp = _integ_tbl.get_item(Key={'pk': 'INTEGRATION#slack', 'sk': 'CONFIG'})
        return resp.get('Item', {})
    except Exception as e:
        logger.warning(f'Could not load Slack config from DynamoDB: {e}')
        return {}


def _get_webhook_url() -> str:
    """Fetch the webhook URL from SSM (decrypted SecureString)."""
    # Fallback to env var for backward compat
    fallback = os.environ.get('SLACK_WEBHOOK_URL', '')
    try:
        resp = _ssm.get_parameter(Name=SSM_WEBHOOK_KEY, WithDecryption=True)
        return resp['Parameter']['Value']
    except _ssm.exceptions.ParameterNotFound:
        return fallback
    except Exception as e:
        logger.warning(f'SSM get webhook failed: {e}')
        return fallback


# ── Findings ──────────────────────────────────────────────────────────────────

def _get_open_findings(limit: int = 10) -> list[dict]:
    response = _findings_tbl.query(
        IndexName='status-index',
        KeyConditionExpression=Key('status').eq('OPEN'),
        ScanIndexForward=False,
        Limit=50,
    )
    findings = response.get('Items', [])
    findings.sort(key=lambda f: float(f.get('estimatedMonthlySavings', 0)), reverse=True)
    return findings[:limit]


# ── Block Kit message builder ─────────────────────────────────────────────────

_SEVERITY = {
    'high':   ('🔴', 200),   # >= $200/mo
    'medium': ('🟡', 50),    # >= $50/mo
    'low':    ('🟢', 0),     # < $50/mo
}

_TYPE_LABEL = {
    'IDLE_EC2':       '💻 Idle EC2',
    'UNATTACHED_EBS': '💾 Unattached EBS',
    'OLD_SNAPSHOT':   '📸 Old Snapshot',
    'RIGHTSIZING':    '📐 Rightsizing',
    'SAVINGS_PLAN':   '💰 Savings Plan',
    'OTHER':          '🔍 Other',
}


def _severity_emoji(savings: float) -> str:
    for label, (emoji, threshold) in _SEVERITY.items():
        if savings >= threshold:
            return emoji
    return '🟢'


def _build_blocks(findings: list[dict], config: dict) -> list[dict]:
    today         = date.today().strftime('%B %d, %Y')
    total_savings = sum(float(f.get('estimatedMonthlySavings', 0)) for f in findings)
    channel       = config.get('config', {}).get('channel', '')

    blocks = [
        {
            'type': 'header',
            'text': {'type': 'plain_text', 'text': f'💰 KostOps Daily Digest — {today}', 'emoji': True},
        },
        {
            'type': 'section',
            'fields': [
                {'type': 'mrkdwn', 'text': f'*Open Findings*\n{len(findings)}'},
                {'type': 'mrkdwn', 'text': f'*Est. Monthly Savings*\n${total_savings:,.0f}/mo'},
            ],
        },
        {'type': 'divider'},
    ]

    if not findings:
        blocks.append({
            'type': 'section',
            'text': {'type': 'mrkdwn', 'text': '✅ *No open findings.* Your AWS spend looks clean!'},
        })
    else:
        for i, f in enumerate(findings[:8], 1):
            savings   = float(f.get('estimatedMonthlySavings', 0))
            ftype     = f.get('type', 'OTHER')
            title     = f.get('title', 'Untitled')
            severity  = _severity_emoji(savings)
            type_label = _TYPE_LABEL.get(ftype, '🔍 Other')
            blocks.append({
                'type': 'section',
                'text': {
                    'type': 'mrkdwn',
                    'text': f'{severity} *${savings:,.0f}/mo* — {title}\n_{type_label}_',
                },
            })

    blocks.append({'type': 'divider'})
    blocks.append({
        'type': 'context',
        'elements': [
            {'type': 'mrkdwn', 'text': '🤖 KostOps · AWS FinOps Agent · Use `/kostops` to ask questions in Slack'},
        ],
    })

    return blocks


# ── Slack send ────────────────────────────────────────────────────────────────

def _send_to_slack(webhook_url: str, blocks: list[dict], fallback_text: str) -> None:
    if not webhook_url:
        logger.warning('No Slack webhook URL configured — skipping')
        return

    payload = json.dumps({
        'text':   fallback_text,  # shown in notifications / accessibility
        'blocks': blocks,
    }).encode('utf-8')

    req = urllib.request.Request(
        webhook_url,
        data=payload,
        headers={'Content-Type': 'application/json'},
        method='POST',
    )
    with urllib.request.urlopen(req, timeout=10) as resp:
        logger.info(f'Slack response: {resp.status}')


# ── CORS helper ───────────────────────────────────────────────────────────────

def _cors(status: int, body: dict) -> dict:
    return {
        'statusCode': status,
        'headers': {
            'Content-Type':                'application/json',
            'Access-Control-Allow-Origin': '*',
        },
        'body': json.dumps(body),
    }


# ── Main handler ──────────────────────────────────────────────────────────────

def handler(event: dict, context) -> dict:
    logger.info('Slack digest triggered')

    config      = _get_slack_config()
    webhook_url = _get_webhook_url()

    findings    = _get_open_findings(limit=10)
    blocks      = _build_blocks(findings, config)
    total       = sum(float(f.get('estimatedMonthlySavings', 0)) for f in findings)
    fallback    = f'KostOps: {len(findings)} open findings, ${total:,.0f}/mo estimated savings'

    try:
        _send_to_slack(webhook_url, blocks, fallback)
    except urllib.error.HTTPError as e:
        detail = e.read().decode()
        logger.error(f'Slack webhook error {e.code}: {detail}')
        return _cors(502, {'error': f'Slack error {e.code}: {detail}'})
    except Exception as e:
        logger.error(f'Failed to send Slack digest: {e}')
        return _cors(502, {'error': str(e)})

    logger.info(f'Sent Slack digest | findings={len(findings)} | savings=${total:,.0f}')
    return _cors(200, {
        'sent':     True,
        'findings': len(findings),
        'channel':  config.get('config', {}).get('channel', ''),
    })
