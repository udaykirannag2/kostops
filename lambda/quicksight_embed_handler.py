"""
QuickSight Embed Handler
------------------------
Generates a signed, time-limited QuickSight anonymous embed URL for the
React frontend to display the KostOps Cost Overview dashboard in an <iframe>.

Route: GET /dashboard/quicksight-url

How it works:
  1. React calls GET /dashboard/quicksight-url (Cognito JWT required)
  2. This Lambda reads the request Origin header to determine the allowed domain
  3. Calls QuickSight GenerateEmbedUrlForAnonymousUser with AllowedDomains
  4. Returns a signed URL that expires in 600 minutes (10 hours)
  5. React renders <iframe src={embedUrl} />

Why AllowedDomains matters:
  QuickSight enforces X-Frame-Options / CSP on anonymous embed URLs.
  Without registering the embedding domain, browsers refuse to load the
  iframe ("refused to connect"). Passing AllowedDomains in the API call
  is the recommended programmatic approach — no console registration needed.

Pre-requisites (one-time manual setup):
  1. Subscribe to QuickSight Enterprise
  2. Enable Session Capacity Pricing:
     QuickSight → Manage QuickSight → Manage subscriptions → Readers
     → Switch plan → Monthly Capacity → Session Capacity Pricing → Confirm
  3. Deploy KostOpsQuickSightStack (sets QUICKSIGHT_DASHBOARD_ARN automatically)

If QUICKSIGHT_DASHBOARD_ARN is not set, returns {"configured": false} so
the frontend can show a helpful setup instructions card instead of an error.
"""

import os
import json
import logging

import boto3

logger          = logging.getLogger()
logger.setLevel(os.environ.get('LOG_LEVEL', 'INFO'))

AWS_ACCOUNT_ID  = os.environ.get('AWS_ACCOUNT_ID',           '')
QS_NAMESPACE    = os.environ.get('QUICKSIGHT_NAMESPACE',      'default')
AWS_REGION      = os.environ.get('AWS_REGION',                'us-east-1')
SESSION_MINUTES = int(os.environ.get('EMBED_SESSION_MINUTES', '600'))  # max = 600
FALLBACK_DOMAIN = os.environ.get('FRONTEND_URL', '')

# ── Dashboard ARN map — populated from env vars set by ApiStack ───────────────
# Keys match the DashboardKey union type in frontend/src/api/client.ts
DASHBOARD_ARNS: dict[str, str] = {
    'overview':        os.environ.get('QUICKSIGHT_DASHBOARD_ARN',     ''),
    'billing-summary': os.environ.get('QS_ARN_BILLING_SUMMARY',       ''),
    'compute':         os.environ.get('QS_ARN_COMPUTE',               ''),
    'storage':         os.environ.get('QS_ARN_STORAGE',               ''),
    'ai-ml':           os.environ.get('QS_ARN_AI_ML',                 ''),
    'commitments':     os.environ.get('QS_ARN_COMMITMENTS',           ''),
    'rightsizing':     os.environ.get('QS_ARN_RIGHTSIZING',           ''),
}

_qs = boto3.client('quicksight', region_name=AWS_REGION)

CORS = {
    'Content-Type':                'application/json',
    'Access-Control-Allow-Origin': '*',
}


def _resp(status: int, body: dict) -> dict:
    return {
        'statusCode': status,
        'headers':    CORS,
        'body':       json.dumps(body),
    }


def _allowed_domains(event: dict) -> list[str]:
    """
    Build the list of domains QuickSight should allow to embed the dashboard.

    QuickSight requires the scheme+host (e.g. "https://d1234.cloudfront.net").
    We read the Origin header forwarded by API Gateway.  If absent we fall back
    to FRONTEND_URL env var, and finally localhost for local dev.
    """
    headers = event.get('headers') or {}
    # API Gateway normalises header names to lower-case
    origin = headers.get('origin') or headers.get('Origin') or ''

    domains = []

    if origin:
        # Strip trailing slash, keep scheme+host only
        domains.append(origin.rstrip('/'))

    if FALLBACK_DOMAIN and FALLBACK_DOMAIN not in domains:
        domains.append(FALLBACK_DOMAIN.rstrip('/'))

    # Always add localhost so developers can test locally
    for local in ('http://localhost:3000', 'http://localhost:5173'):
        if local not in domains:
            domains.append(local)

    logger.info(f'AllowedDomains for embed URL: {domains}')
    return domains


def handler(event: dict, context) -> dict:
    # ── Resolve dashboard key from ?dashboard= query param ────────────────────
    qs_params    = event.get('queryStringParameters') or {}
    dashboard_key = qs_params.get('dashboard', 'overview')

    if dashboard_key not in DASHBOARD_ARNS:
        return _resp(400, {'error': f'Unknown dashboard key: {dashboard_key}. '
                                     f'Valid keys: {list(DASHBOARD_ARNS.keys())}'})

    dashboard_arn = DASHBOARD_ARNS[dashboard_key]
    logger.info(f'QuickSight embed URL request: dashboard={dashboard_key}')

    # ── Not yet configured ────────────────────────────────────────────────────
    if not dashboard_arn or not AWS_ACCOUNT_ID:
        logger.warning(f'Dashboard ARN not configured for key: {dashboard_key}')
        return _resp(200, {
            'configured': False,
            'message':    (
                f'Dashboard "{dashboard_key}" is not yet configured. '
                'Deploy the QuickSightStack: '
                'cdk deploy --context installQuickSight=true'
            ),
        })

    dashboard_id    = dashboard_arn.rsplit('/', 1)[-1]
    allowed_domains = _allowed_domains(event)

    try:
        resp = _qs.generate_embed_url_for_anonymous_user(
            AwsAccountId=AWS_ACCOUNT_ID,
            Namespace=QS_NAMESPACE,
            AuthorizedResourceArns=[dashboard_arn],
            ExperienceConfiguration={
                'Dashboard': {
                    'InitialDashboardId': dashboard_id,
                    'FeatureConfigurations': {
                        'SharedView': {'Enabled': True},
                    },
                }
            },
            SessionLifetimeInMinutes=SESSION_MINUTES,
            AllowedDomains=allowed_domains,
        )
        logger.info(f'Generated embed URL for dashboard {dashboard_key} ({dashboard_id})')
        return _resp(200, {
            'configured':  True,
            'embedUrl':    resp['EmbedUrl'],
            'expiresInMs': SESSION_MINUTES * 60 * 1000,
        })

    except _qs.exceptions.UnsupportedPricingPlanException:
        logger.error('Anonymous embedding not enabled — session capacity pricing required')
        return _resp(402, {
            'configured': True,
            'error':      (
                'Anonymous embedding requires QuickSight Session Capacity Pricing. '
                'Enable it: QuickSight → Manage QuickSight → Manage subscriptions '
                '→ Readers → Switch plan → Monthly Capacity → Session Capacity Pricing.'
            ),
        })

    except _qs.exceptions.ResourceNotFoundException:
        logger.error(f'Dashboard not found: {dashboard_arn}')
        return _resp(404, {
            'configured': True,
            'error':      f'Dashboard not found: {dashboard_id}. Re-deploy the QuickSightStack.',
        })

    except Exception as e:
        logger.error(f'QuickSight embed error: {e}')
        return _resp(502, {'error': str(e)})
