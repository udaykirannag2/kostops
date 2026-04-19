"""
agents/api_client.py
--------------------
Agent-side HTTP client that calls KostOps API endpoints with the CALLER's JWT.

Design rules (Phase 1 §8, §10):
  1. Agent tools NEVER mutate DynamoDB directly. Writes go through the
     KostOps API so:
       - API Gateway's Cognito authorizer re-validates the JWT and the
         `admin` group claim.
       - The target handler emits a source=CHAT audit row keyed to the
         caller's Cognito sub.
       - Business logic (period validation, isCurrent transaction, …) is
         owned by exactly one piece of code.
  2. The bearer token flows per-request through the supervisor. We store
     it in a thread-local so every tool dispatched inside the current
     converse() loop can reach it without threading it through signatures.

Usage from the entrypoint:
    from agents.api_client import set_caller, clear_caller
    set_caller(token=ctx['token'], api_base_url=ctx.get('apiBaseUrl', ''))
    try:
        return supervisor.dispatch(message, ctx)
    finally:
        clear_caller()

Usage from a tool:
    from agents.api_client import put, ApiError
    try:
        resp = put(f'/budgets/{scope_id}/{period}', {'amountUsd': amount})
    except ApiError as e:
        return {'status': 'error', 'code': e.status, 'detail': e.message}
"""

from __future__ import annotations

import json
import logging
import threading
import urllib.request
import urllib.error
from typing import Any, Optional

logger = logging.getLogger(__name__)

_tls = threading.local()


def set_caller(*, token: str, api_base_url: str) -> None:
    """Bind the current request's JWT + API URL to this thread."""
    _tls.token        = token or ''
    _tls.api_base_url = (api_base_url or '').rstrip('/')


def clear_caller() -> None:
    """Reset per-request state. Call from a try/finally around dispatch."""
    _tls.token        = ''
    _tls.api_base_url = ''


def _get(key: str, default: str = '') -> str:
    return getattr(_tls, key, default) or default


class ApiError(Exception):
    """Raised for non-2xx responses or transport failures."""
    def __init__(self, status: int, message: str):
        super().__init__(f'{status}: {message}')
        self.status  = status
        self.message = message


def _call(method: str, path: str, body: Any = None, *, timeout: int = 30) -> Any:
    token = _get('token')
    base  = _get('api_base_url')
    if not token:
        raise ApiError(401, 'no caller token bound to this invocation')
    if not base:
        raise ApiError(500, 'API_BASE_URL not set for this invocation')

    url  = f"{base}{path if path.startswith('/') else '/' + path}"
    data = None
    if body is not None:
        data = json.dumps(body).encode('utf-8')

    req = urllib.request.Request(
        url,
        data=data,
        method=method.upper(),
        headers={
            'Content-Type':  'application/json',
            'Authorization': f'Bearer {token}',
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode('utf-8') or '{}'
            return json.loads(raw)
    except urllib.error.HTTPError as e:
        detail = e.read().decode(errors='replace') if e.fp else str(e)
        logger.warning(f'api {method} {path} -> {e.code}: {detail[:200]}')
        raise ApiError(e.code, detail) from e
    except Exception as e:
        logger.error(f'api {method} {path} failed: {e}')
        raise ApiError(502, str(e)) from e


def get(path: str, **kw)         -> Any: return _call('GET',    path, **kw)
def post(path: str, body, **kw)  -> Any: return _call('POST',   path, body, **kw)
def put(path: str, body, **kw)   -> Any: return _call('PUT',    path, body, **kw)
def patch(path: str, body, **kw) -> Any: return _call('PATCH',  path, body, **kw)
def delete(path: str, **kw)      -> Any: return _call('DELETE', path, **kw)
