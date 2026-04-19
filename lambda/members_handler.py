"""
Members Handler
---------------
Admin-only Cognito group management for the KostOps Members page.

Roles: admin (read + write), viewer (read-only). Because this handler is
itself admin-gated, the `admin` group is the bootstrap authority for everyone
else — the first invited user is auto-added to `admin` by auth-stack.ts.

Routes:
  GET    /members                        → list users with role
  POST   /members                        → invite a new user at a given role
  PUT    /members/{sub}                  → change a user's role
  DELETE /members/{sub}                  → disable (not delete) a user

Design notes:
  - We never delete Cognito users here — disabled is reversible, deleted is not.
  - Role is expressed via Cognito group membership. A user in no group is
    effectively a viewer (see `common/roles.py::require_admin`); UI renders
    missing groups as "viewer" for clarity.
  - Every mutation writes an AuditEvents row with entity_type='Member'.
"""

from __future__ import annotations

import os
import json
import logging

import boto3

from common.roles import require_admin, PermissionDenied, forbidden_response, ADMIN, VIEWER
from common.audit import write_audit

logger = logging.getLogger()
logger.setLevel(os.environ.get('LOG_LEVEL', 'INFO'))

USER_POOL_ID = os.environ['USER_POOL_ID']
AWS_REGION   = os.environ.get('AWS_REGION', 'us-east-1')

_cognito = boto3.client('cognito-idp', region_name=AWS_REGION)

VALID_ROLES = {ADMIN, VIEWER}


def _cors(status: int, body) -> dict:
    return {
        'statusCode': status,
        'headers': {
            'Content-Type':                'application/json',
            'Access-Control-Allow-Origin': '*',
        },
        'body': json.dumps(body, default=str),
    }


def _attr(attrs: list, name: str) -> str:
    for a in attrs:
        if a.get('Name') == name:
            return a.get('Value', '')
    return ''


def _role_of(username: str) -> str:
    try:
        resp = _cognito.admin_list_groups_for_user(
            Username=username,
            UserPoolId=USER_POOL_ID,
            Limit=10,
        )
        names = {g.get('GroupName') for g in resp.get('Groups', [])}
        if ADMIN in names:
            return ADMIN
        if VIEWER in names:
            return VIEWER
    except Exception as e:
        logger.warning(f'admin_list_groups_for_user({username}) failed: {e}')
    return VIEWER  # default — unenrolled users are read-only


def _list_members() -> dict:
    """Return all users in the pool with their resolved role."""
    users = []
    paginator_token = None
    while True:
        kwargs = {'UserPoolId': USER_POOL_ID, 'Limit': 60}
        if paginator_token:
            kwargs['PaginationToken'] = paginator_token
        resp = _cognito.list_users(**kwargs)
        for u in resp.get('Users', []):
            username = u.get('Username', '')
            attrs    = u.get('Attributes', [])
            users.append({
                'sub':       _attr(attrs, 'sub'),
                'username':  username,
                'email':     _attr(attrs, 'email'),
                'status':    u.get('UserStatus', ''),
                'enabled':   bool(u.get('Enabled', True)),
                'createdAt': u.get('UserCreateDate', '').isoformat() if u.get('UserCreateDate') else '',
                'role':      _role_of(username),
            })
        paginator_token = resp.get('PaginationToken')
        if not paginator_token:
            break
    users.sort(key=lambda x: x.get('email', ''))
    return _cors(200, {'members': users, 'count': len(users)})


def _invite_member(event: dict, body: dict) -> dict:
    email = (body.get('email') or '').strip().lower()
    role  = (body.get('role')  or VIEWER).lower()

    if not email or '@' not in email:
        return _cors(400, {'error': 'email is required and must be valid'})
    if role not in VALID_ROLES:
        return _cors(400, {'error': f'role must be one of {sorted(VALID_ROLES)}'})

    try:
        create_resp = _cognito.admin_create_user(
            UserPoolId=USER_POOL_ID,
            Username=email,
            UserAttributes=[
                {'Name': 'email',          'Value': email},
                {'Name': 'email_verified', 'Value': 'true'},
            ],
            DesiredDeliveryMediums=['EMAIL'],
        )
    except _cognito.exceptions.UsernameExistsException:
        return _cors(409, {'error': f'user already exists: {email}'})
    except Exception as e:
        logger.error(f'admin_create_user failed: {e}')
        return _cors(500, {'error': str(e)})

    user = create_resp.get('User', {})
    sub  = _attr(user.get('Attributes', []), 'sub')

    try:
        _cognito.admin_add_user_to_group(
            UserPoolId=USER_POOL_ID,
            Username=email,
            GroupName=role,
        )
    except Exception as e:
        logger.warning(f'admin_add_user_to_group failed: {e}')

    write_audit(
        event,
        action='CREATE',
        entity_type='Member',
        entity_id=sub or email,
        before=None,
        after={'email': email, 'role': role},
        source='UI',
    )
    return _cors(201, {'sub': sub, 'email': email, 'role': role, 'status': user.get('UserStatus', '')})


def _change_role(event: dict, sub_or_username: str, body: dict) -> dict:
    role = (body.get('role') or '').lower()
    if role not in VALID_ROLES:
        return _cors(400, {'error': f'role must be one of {sorted(VALID_ROLES)}'})

    username = sub_or_username
    prior    = _role_of(username)

    # Remove from the other group (at most one of admin/viewer at a time)
    other = VIEWER if role == ADMIN else ADMIN
    try:
        _cognito.admin_remove_user_from_group(
            UserPoolId=USER_POOL_ID,
            Username=username,
            GroupName=other,
        )
    except _cognito.exceptions.ResourceNotFoundException:
        pass
    except Exception as e:
        logger.info(f'remove from {other} noop: {e}')

    try:
        _cognito.admin_add_user_to_group(
            UserPoolId=USER_POOL_ID,
            Username=username,
            GroupName=role,
        )
    except Exception as e:
        logger.error(f'admin_add_user_to_group failed: {e}')
        return _cors(500, {'error': str(e)})

    write_audit(
        event,
        action='ROLE_CHANGE',
        entity_type='Member',
        entity_id=username,
        before={'role': prior},
        after={'role': role},
        source='UI',
    )
    return _cors(200, {'username': username, 'role': role})


def _disable_member(event: dict, sub_or_username: str) -> dict:
    username = sub_or_username
    try:
        _cognito.admin_disable_user(UserPoolId=USER_POOL_ID, Username=username)
    except _cognito.exceptions.UserNotFoundException:
        return _cors(404, {'error': f'user not found: {username}'})
    except Exception as e:
        logger.error(f'admin_disable_user failed: {e}')
        return _cors(500, {'error': str(e)})

    write_audit(
        event,
        action='DISABLE',
        entity_type='Member',
        entity_id=username,
        before={'enabled': True},
        after={'enabled': False},
        source='UI',
    )
    return _cors(200, {'username': username, 'enabled': False})


def handler(event: dict, context) -> dict:
    # Every /members route is admin-only (including GET — member list is
    # sensitive identity data).
    try:
        require_admin(event)
    except PermissionDenied:
        return forbidden_response()

    method      = event.get('httpMethod', '')
    path_params = event.get('pathParameters') or {}
    sub         = path_params.get('sub', '')

    try:
        body = json.loads(event.get('body') or '{}')
    except json.JSONDecodeError:
        return _cors(400, {'error': 'Invalid JSON body'})

    logger.info(f'Members | method={method} | sub={sub}')

    if method == 'GET' and not sub:
        return _list_members()
    if method == 'POST' and not sub:
        return _invite_member(event, body)
    if method == 'PUT' and sub:
        return _change_role(event, sub, body)
    if method == 'DELETE' and sub:
        return _disable_member(event, sub)

    return _cors(405, {'error': f'Method {method} not allowed'})
