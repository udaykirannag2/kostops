"""
lambda/common/orgs.py
---------------------
Shared AWS Organizations helpers for KostOps Lambda handlers.

All Lambda handlers that need to walk Organizations (visibility filters,
scope effective-account resolution, budget-refresh account expansion, …)
go through this module so the STS assume-role behaviour and OU/account
cache stay consistent.

Usage:
    from common.orgs import payer_session, list_accounts_and_ous, expand_accounts_for_scope

The cache is process-local (in-memory), not distributed. Each Lambda
container holds its own copy for FILTER_CACHE_TTL_SECONDS (default 300s).
"""

from __future__ import annotations

import os
import time
import logging
from typing import Optional

import boto3

logger = logging.getLogger(__name__)

AWS_REGION        = os.environ.get('AWS_REGION',                  'us-east-1')
PAYER_ROLE_ARN    = os.environ.get('PAYER_CROSS_ACCOUNT_ROLE',    '')
CACHE_TTL_SECONDS = int(os.environ.get('FILTER_CACHE_TTL_SECONDS', '300'))

_sts = boto3.client('sts', region_name=AWS_REGION)

_cache: dict[str, object] = {'value': None, 'expiresAt': 0.0}


def payer_session() -> Optional[boto3.Session]:
    """Return a boto3 Session with payer-role credentials, or None if unconfigured."""
    if not PAYER_ROLE_ARN:
        return None
    creds = _sts.assume_role(
        RoleArn=PAYER_ROLE_ARN,
        RoleSessionName='kostops-orgs',
    )['Credentials']
    return boto3.Session(
        aws_access_key_id     = creds['AccessKeyId'],
        aws_secret_access_key = creds['SecretAccessKey'],
        aws_session_token     = creds['SessionToken'],
        region_name           = AWS_REGION,
    )


def _fetch_accounts_and_ous() -> dict:
    """Actually walk the org tree. Callers should go through list_accounts_and_ous()."""
    session = payer_session()
    if not session:
        return {'accounts': [], 'ous': []}

    orgs = session.client('organizations')

    # Walk OU tree — collect all OUs by ID with parent pointers for hierarchy.
    ou_by_id: dict[str, dict] = {}
    try:
        roots = orgs.list_roots()['Roots']
        for root in roots:
            stack = [root['Id']]
            while stack:
                parent_id = stack.pop()
                paginator = orgs.get_paginator('list_organizational_units_for_parent')
                for page in paginator.paginate(ParentId=parent_id):
                    for ou in page.get('OrganizationalUnits', []):
                        ou_by_id[ou['Id']] = {'id': ou['Id'], 'name': ou['Name'], 'parentId': parent_id}
                        stack.append(ou['Id'])
    except Exception as e:
        logger.warning(f'OU walk failed (non-fatal): {e}')

    accounts: list[dict] = []
    try:
        paginator = orgs.get_paginator('list_accounts')
        for page in paginator.paginate():
            for acct in page.get('Accounts', []):
                if acct.get('Status') != 'ACTIVE':
                    continue
                acct_id = acct['Id']
                ou_id   = ''
                ou_name = ''
                try:
                    parents = orgs.list_parents(ChildId=acct_id).get('Parents', [])
                    if parents:
                        p = parents[0]
                        if p.get('Type') == 'ORGANIZATIONAL_UNIT':
                            ou_id   = p['Id']
                            ou_name = ou_by_id.get(ou_id, {}).get('name', '')
                        elif p.get('Type') == 'ROOT':
                            ou_id   = p['Id']
                            ou_name = 'Root'
                except Exception as e:
                    logger.debug(f'list_parents({acct_id}) failed: {e}')
                accounts.append({
                    'id':     acct_id,
                    'name':   acct.get('Name', acct_id),
                    'email':  acct.get('Email', ''),
                    'ouId':   ou_id,
                    'ouName': ou_name,
                })
    except Exception as e:
        logger.warning(f'ListAccounts failed (non-fatal): {e}')

    accounts.sort(key=lambda a: a['name'].lower())
    ous = sorted(ou_by_id.values(), key=lambda o: o['name'].lower())
    return {'accounts': accounts, 'ous': ous}


def list_accounts_and_ous(force_refresh: bool = False) -> dict:
    """
    Return {accounts: [...], ous: [...]} cached per-container for CACHE_TTL_SECONDS.
    Pass force_refresh=True to bypass the cache (e.g. post-admin change that
    reorganised the Org tree).
    """
    now = time.time()
    if not force_refresh and _cache['value'] and float(_cache['expiresAt']) > now:
        return _cache['value']  # type: ignore[return-value]

    value = _fetch_accounts_and_ous()
    _cache['value']     = value
    _cache['expiresAt'] = now + CACHE_TTL_SECONDS
    return value


def expand_accounts_for_scope(scope: dict) -> list[str]:
    """
    Resolve a Scope item into the list of account IDs it covers.

    Scope schema (DynamoDB Scopes table):
      scopeId, scopeType ∈ {OU,TEAM,ACCOUNT,CUSTOM}
      ouIds[], includeAccountIds[], excludeAccountIds[]

    Semantics:
      ACCOUNT   → includeAccountIds verbatim
      OU / TEAM → (⋃ accounts under ouIds) ∪ includeAccountIds \\ excludeAccountIds
      CUSTOM    → includeAccountIds (OUs optionally expanded too)
    """
    include = set(scope.get('includeAccountIds', []) or [])
    exclude = set(scope.get('excludeAccountIds', []) or [])
    ou_ids  = set(scope.get('ouIds', []) or [])
    stype   = (scope.get('scopeType') or '').upper()

    if stype == 'ACCOUNT':
        return sorted(include - exclude)

    if ou_ids:
        data = list_accounts_and_ous()
        for a in data.get('accounts', []):
            if a.get('ouId') in ou_ids:
                include.add(a['id'])

    return sorted(include - exclude)
