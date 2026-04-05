"""
Payer Role Helper
-----------------
Provides temporary credentials for the payer cross-account role.
The KostOps agent assumes this role before calling Cost Explorer,
Compute Optimizer, Budgets, and Cost Optimization Hub — all of which
only return meaningful data when called from the payer account.

Usage:
    from tools.payer_role import get_payer_credentials, get_payer_session

    # Option 1: get boto3 session (for direct boto3 calls)
    session = get_payer_session()
    ce = session.client('ce')

    # Option 2: get env-style credentials dict (for MCP server subprocess)
    creds = get_payer_credentials()
    # creds = {AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_SESSION_TOKEN}
"""

import os
import time
import boto3
import logging

logger = logging.getLogger(__name__)

PAYER_CROSS_ACCOUNT_ROLE = os.environ.get('PAYER_CROSS_ACCOUNT_ROLE', '')
PAYER_ACCOUNT_ID         = os.environ.get('PAYER_ACCOUNT_ID', '')

# Cache assumed role credentials to avoid repeated STS calls
# Cost Explorer charges $0.01/call — don't add STS overhead unnecessarily
_cached_credentials: dict | None = None
_credentials_expiry: float = 0


def get_payer_session() -> boto3.Session:
    """
    Return a boto3 Session using credentials from the payer cross-account role.
    Credentials are cached and refreshed automatically when they expire.
    Raises ValueError if PAYER_CROSS_ACCOUNT_ROLE is not configured.
    """
    creds = _assume_payer_role()
    return boto3.Session(
        aws_access_key_id=     creds['AccessKeyId'],
        aws_secret_access_key= creds['SecretAccessKey'],
        aws_session_token=     creds['SessionToken'],
        region_name=           os.environ.get('AWS_REGION', 'us-east-1'),
    )


def get_payer_credentials() -> dict[str, str]:
    """
    Return env-style credentials dict for injecting into MCP server subprocess.
    Used by AgentCore Gateway to pass payer credentials to the billing MCP server.
    """
    creds = _assume_payer_role()
    return {
        'AWS_ACCESS_KEY_ID':     creds['AccessKeyId'],
        'AWS_SECRET_ACCESS_KEY': creds['SecretAccessKey'],
        'AWS_SESSION_TOKEN':     creds['SessionToken'],
        'AWS_REGION':            os.environ.get('AWS_REGION', 'us-east-1'),
    }


def is_configured() -> bool:
    """Return True if payer cross-account role is configured."""
    return bool(PAYER_CROSS_ACCOUNT_ROLE and PAYER_ACCOUNT_ID)


def _assume_payer_role() -> dict:
    """
    Assume the payer cross-account role via STS.
    Returns the Credentials dict from AssumeRole response.
    Caches credentials and refreshes 5 minutes before expiry.
    """
    global _cached_credentials, _credentials_expiry

    if not PAYER_CROSS_ACCOUNT_ROLE:
        raise ValueError(
            'PAYER_CROSS_ACCOUNT_ROLE environment variable not set. '
            'Run the payer CDK stack first: cdk deploy KostOpsPayerStack'
        )

    # Return cached credentials if still valid (with 5-min buffer)
    now = time.time()
    if _cached_credentials and now < (_credentials_expiry - 300):
        return _cached_credentials

    logger.info(f"Assuming payer role: {PAYER_CROSS_ACCOUNT_ROLE}")

    sts = boto3.client('sts', region_name=os.environ.get('AWS_REGION', 'us-east-1'))

    response = sts.assume_role(
        RoleArn=         PAYER_CROSS_ACCOUNT_ROLE,
        RoleSessionName= 'KostOpsAgent',
        DurationSeconds= 3600,  # 1 hour — matches maxSessionDuration in payer-stack.ts
    )

    _cached_credentials = response['Credentials']
    _credentials_expiry  = _cached_credentials['Expiration'].timestamp()

    logger.info(
        f"Assumed payer role successfully. "
        f"Expires: {_cached_credentials['Expiration'].isoformat()}"
    )

    return _cached_credentials
