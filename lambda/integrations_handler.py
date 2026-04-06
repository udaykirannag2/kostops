"""
Integrations Handler
--------------------
Lambda function for managing third-party integrations (Slack, Jira, etc.).

Metadata (non-sensitive config) lives in DynamoDB kostops-integrations.
Secrets (webhook URLs, tokens) live in SSM Parameter Store as SecureString.

Routes (all require Cognito JWT):
  GET    /integrations              → list all integrations + connected status
  GET    /integrations/{name}       → get config for one integration (secrets masked)
  PUT    /integrations/{name}       → create or update integration config
  DELETE /integrations/{name}       → disconnect / remove integration
  POST   /integrations/{name}/test  → send a test message to verify connectivity
"""

import os
import json
import logging
import urllib.request
import urllib.error
from datetime import datetime, timezone

import boto3
from boto3.dynamodb.conditions import Key

logger              = logging.getLogger()
logger.setLevel(os.environ.get('LOG_LEVEL', 'INFO'))

INTEGRATIONS_TABLE  = os.environ['INTEGRATIONS_TABLE']
AWS_REGION          = os.environ.get('AWS_REGION', 'us-east-1')
SSM_PREFIX          = '/kostops/integrations'

_ddb   = boto3.resource('dynamodb', region_name=AWS_REGION)
_table = _ddb.Table(INTEGRATIONS_TABLE)
_ssm   = boto3.client('ssm', region_name=AWS_REGION)

SUPPORTED = {'slack', 'jira', 'pagerduty', 'email'}


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


def _ssm_key(integration: str, secret: str) -> str:
    return f'{SSM_PREFIX}/{integration}/{secret}'


def _put_secret(integration: str, secret: str, value: str) -> None:
    _ssm.put_parameter(
        Name=_ssm_key(integration, secret),
        Value=value,
        Type='SecureString',
        Overwrite=True,
        Description=f'KostOps {integration} {secret}',
    )


def _get_secret(integration: str, secret: str) -> str | None:
    try:
        resp = _ssm.get_parameter(
            Name=_ssm_key(integration, secret),
            WithDecryption=True,
        )
        return resp['Parameter']['Value']
    except _ssm.exceptions.ParameterNotFound:
        return None
    except Exception as e:
        logger.warning(f'SSM get failed for {secret}: {e}')
        return None


def _delete_secret(integration: str, secret: str) -> None:
    try:
        _ssm.delete_parameter(Name=_ssm_key(integration, secret))
    except Exception:
        pass  # Already gone is fine


def _mask(value: str | None) -> str:
    """Return last 4 chars masked for display."""
    if not value:
        return ''
    return '••••••••' + value[-4:] if len(value) > 4 else '••••'


# ── Integration definitions ───────────────────────────────────────────────────

INTEGRATION_META = {
    'slack': {
        'displayName': 'Slack',
        'description': 'Send daily digests, anomaly alerts, and answer /kostops slash commands.',
        'icon':        'slack',
        'secrets':     ['webhookUrl', 'signingSecret'],
        'configFields': ['channel', 'notifications'],
    },
    'jira': {
        'displayName': 'Jira',
        'description': 'Auto-create tickets from findings above your cost threshold.',
        'icon':        'jira',
        'secrets':     ['apiToken'],
        'configFields': ['siteUrl', 'projectKey', 'email', 'ticketThreshold'],
    },
    'pagerduty': {
        'displayName': 'PagerDuty',
        'description': 'Alert on cost anomalies exceeding your severity thresholds.',
        'icon':        'pagerduty',
        'secrets':     ['integrationKey'],
        'configFields': ['severityThreshold'],
    },
    'email': {
        'displayName': 'Email',
        'description': 'Send weekly cost reports to your team.',
        'icon':        'email',
        'secrets':     [],
        'configFields': ['recipients', 'schedule'],
    },
}


# ── Route handlers ────────────────────────────────────────────────────────────

def _list_integrations() -> dict:
    """Return all integration configs (secrets masked)."""
    result = []
    for name, meta in INTEGRATION_META.items():
        # Try to load saved config from DynamoDB
        resp = _table.get_item(Key={'pk': f'INTEGRATION#{name}', 'sk': 'CONFIG'})
        item = resp.get('Item')
        result.append({
            'name':        name,
            'displayName': meta['displayName'],
            'description': meta['description'],
            'icon':        meta['icon'],
            'connected':   bool(item and item.get('enabled')),
            'configuredAt': item.get('configuredAt') if item else None,
            'config':      item.get('config', {}) if item else {},
        })
    return _cors(200, {'integrations': result})


def _get_integration(name: str) -> dict:
    if name not in SUPPORTED:
        return _cors(404, {'error': f'Unknown integration: {name}'})

    resp = _table.get_item(Key={'pk': f'INTEGRATION#{name}', 'sk': 'CONFIG'})
    item = resp.get('Item')
    meta = INTEGRATION_META[name]

    # Build masked secrets
    masked_secrets = {}
    for secret in meta['secrets']:
        val = _get_secret(name, secret)
        masked_secrets[secret] = _mask(val) if val else ''

    return _cors(200, {
        'name':          name,
        'displayName':   meta['displayName'],
        'description':   meta['description'],
        'connected':     bool(item and item.get('enabled')),
        'configuredAt':  item.get('configuredAt') if item else None,
        'config':        item.get('config', {}) if item else {},
        'secrets':       masked_secrets,   # never return real values
    })


def _put_integration(name: str, body: dict) -> dict:
    """Create or update an integration config."""
    if name not in SUPPORTED:
        return _cors(404, {'error': f'Unknown integration: {name}'})

    meta    = INTEGRATION_META[name]
    config  = body.get('config', {})
    secrets = body.get('secrets', {})

    # Persist non-empty secrets to SSM (skip if value is masked/empty)
    for secret_name in meta['secrets']:
        value = secrets.get(secret_name, '')
        if value and not value.startswith('••'):
            _put_secret(name, secret_name, value)

    # Store config metadata in DynamoDB
    now = datetime.now(timezone.utc).isoformat()
    _table.put_item(Item={
        'pk':            f'INTEGRATION#{name}',
        'sk':            'CONFIG',
        'name':          name,
        'enabled':       True,
        'config':        config,
        'configuredAt':  now,
        'updatedAt':     now,
    })

    logger.info(f'Integration {name} configured')
    return _cors(200, {'name': name, 'connected': True, 'configuredAt': now})


def _delete_integration(name: str) -> dict:
    if name not in SUPPORTED:
        return _cors(404, {'error': f'Unknown integration: {name}'})

    meta = INTEGRATION_META[name]

    # Remove secrets from SSM
    for secret in meta['secrets']:
        _delete_secret(name, secret)

    # Remove from DynamoDB
    _table.delete_item(Key={'pk': f'INTEGRATION#{name}', 'sk': 'CONFIG'})

    logger.info(f'Integration {name} disconnected')
    return _cors(200, {'name': name, 'connected': False})


def _test_integration(name: str) -> dict:
    if name not in SUPPORTED:
        return _cors(404, {'error': f'Unknown integration: {name}'})

    if name == 'slack':
        return _test_slack()

    return _cors(400, {'error': f'Test not implemented for {name} yet'})


def _test_slack() -> dict:
    """Send a test message to the configured Slack webhook."""
    webhook_url = _get_secret('slack', 'webhookUrl')
    if not webhook_url:
        return _cors(400, {'error': 'Slack webhook URL not configured'})

    # Fetch channel config
    resp    = _table.get_item(Key={'pk': 'INTEGRATION#slack', 'sk': 'CONFIG'})
    item    = resp.get('Item', {})
    channel = item.get('config', {}).get('channel', '#general')

    message = {
        'blocks': [
            {
                'type': 'section',
                'text': {
                    'type': 'mrkdwn',
                    'text': (
                        '*✅ KostOps connected successfully!*\n'
                        f'Your Slack integration is working. Cost alerts and digests '
                        f'will be sent to *{channel}*.'
                    ),
                },
            },
            {
                'type': 'context',
                'elements': [{'type': 'mrkdwn', 'text': 'Sent from KostOps · AWS FinOps Agent'}],
            },
        ]
    }

    try:
        payload = json.dumps(message).encode('utf-8')
        req = urllib.request.Request(
            webhook_url,
            data=payload,
            headers={'Content-Type': 'application/json'},
            method='POST',
        )
        with urllib.request.urlopen(req, timeout=10) as resp:
            logger.info(f'Slack test response: {resp.status}')
        return _cors(200, {'ok': True, 'message': 'Test message sent to Slack'})
    except urllib.error.HTTPError as e:
        detail = e.read().decode()
        logger.error(f'Slack test failed: {e.code} {detail}')
        return _cors(502, {'error': f'Slack returned {e.code}: {detail}'})
    except Exception as e:
        logger.error(f'Slack test error: {e}')
        return _cors(502, {'error': str(e)})


# ── Main handler ──────────────────────────────────────────────────────────────

def handler(event: dict, context) -> dict:
    method      = event.get('httpMethod', '')
    path_params = event.get('pathParameters') or {}
    name        = path_params.get('name', '').lower()
    action      = path_params.get('action', '').lower()

    try:
        body = json.loads(event.get('body') or '{}')
    except json.JSONDecodeError:
        return _cors(400, {'error': 'Invalid JSON body'})

    logger.info(f'Integrations | method={method} name={name} action={action}')

    # GET /integrations
    if method == 'GET' and not name:
        return _list_integrations()

    # GET /integrations/{name}
    if method == 'GET' and name and not action:
        return _get_integration(name)

    # PUT /integrations/{name}
    if method == 'PUT' and name and not action:
        return _put_integration(name, body)

    # DELETE /integrations/{name}
    if method == 'DELETE' and name and not action:
        return _delete_integration(name)

    # POST /integrations/{name}/test
    if method == 'POST' and name and action == 'test':
        return _test_integration(name)

    return _cors(405, {'error': f'Method {method} not supported on this path'})
