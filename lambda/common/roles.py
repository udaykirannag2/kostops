"""
roles.py
--------
Cognito-group based RBAC for KostOps.

Two roles:
  admin   — full read + write across the product
  viewer  — read-only; every mutation must be refused

API Gateway's Cognito authorizer surfaces group membership to Lambdas as
`event.requestContext.authorizer.claims['cognito:groups']`. Because JWTs are
already validated upstream, these helpers trust the claims dict — they only
inspect it, never re-decode.

Usage:

    from common.roles import require_admin, get_claims, PermissionDenied

    def handler(event, context):
        try:
            require_admin(event)
        except PermissionDenied as e:
            return {'statusCode': 403, 'body': str(e)}
        ...
"""

from __future__ import annotations

import json
import logging
from typing import Iterable

logger = logging.getLogger(__name__)

ADMIN  = 'admin'
VIEWER = 'viewer'
KNOWN_ROLES = {ADMIN, VIEWER}


class PermissionDenied(Exception):
    """Raised when the caller lacks the required Cognito group."""


def get_claims(event: dict) -> dict:
    """Return the JWT claims dict surfaced by API Gateway's Cognito authorizer."""
    return (
        event.get('requestContext', {})
             .get('authorizer', {})
             .get('claims', {})
             or {}
    )


def get_user_sub(event: dict) -> str:
    """Return the Cognito sub (unique user id) or 'anonymous' for unauth paths."""
    return get_claims(event).get('sub', 'anonymous')


def get_user_email(event: dict) -> str:
    return get_claims(event).get('email', '')


def get_groups(event_or_claims: dict) -> set[str]:
    """
    Parse `cognito:groups` into a set. Cognito emits the claim as either a
    comma-separated string ("admin,viewer") or a list — accept both shapes.
    """
    claims = event_or_claims if 'sub' in event_or_claims else get_claims(event_or_claims)
    raw    = claims.get('cognito:groups') or ''
    if isinstance(raw, list):
        return {str(g).strip() for g in raw if str(g).strip()}
    if isinstance(raw, str):
        # Cognito sometimes serialises as "[admin viewer]"
        cleaned = raw.strip('[]')
        return {g.strip() for g in cleaned.replace(',', ' ').split() if g.strip()}
    return set()


def has_any_group(event: dict, groups: Iterable[str]) -> bool:
    user_groups = get_groups(event)
    return any(g in user_groups for g in groups)


def is_admin(event: dict) -> bool:
    return ADMIN in get_groups(event)


def require_admin(event: dict) -> None:
    """Raise PermissionDenied if the caller is not in the `admin` group."""
    if not is_admin(event):
        sub = get_user_sub(event)
        logger.warning(f"permission denied | sub={sub[:8]}... | required=admin")
        raise PermissionDenied('admin role required')


def require_viewer(event: dict) -> None:
    """
    Raise PermissionDenied if the caller has no recognised role.

    Admin counts as viewer + more, so having either group passes.
    """
    if not has_any_group(event, KNOWN_ROLES):
        sub = get_user_sub(event)
        logger.warning(f"permission denied | sub={sub[:8]}... | required=viewer|admin")
        raise PermissionDenied('viewer or admin role required')


def forbidden_response() -> dict:
    """Canonical 403 payload for API Gateway proxy integrations."""
    return {
        'statusCode': 403,
        'headers': {
            'Content-Type':                'application/json',
            'Access-Control-Allow-Origin': '*',
        },
        'body': json.dumps({'error': 'admin role required'}),
    }
