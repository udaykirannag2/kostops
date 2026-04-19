"""
api_client.py
-------------
Agent-side HTTP client that calls KostOps API endpoints with the caller's JWT.

Design rule: agent write tools MUST NOT mutate DynamoDB directly. They go
through the API so:

  - The API Gateway Cognito authorizer re-validates the JWT and role.
  - Each write lands a `source=CHAT` audit row automatically (the target
    handler calls `write_audit` with the caller's sub from the claims).
  - Tool behaviour stays identical whether invoked from UI, Slack, or chat.

This module is imported by agent tool modules (tools/*_tools.py) after the
supervisor hands off to a specialist.

The caller JWT is passed in via the agent `ctx` dict (chat_handler forwards it
from `event.headers.Authorization`). At MVP the supervisor stores it in a
thread-local so tools can access it without threading it through every call.
"""

from __future__ import annotations

import os
import json
import logging
import threading
import urllib.request
import urllib.error
from typing import Any, Optional

logger = logging.getLogger(__name__)

API_BASE_URL = os.environ.get('API_BASE_URL', '')

# Thread-local JWT store — set once per invocation by the supervisor,
# read by whichever tool the active specialist calls.
_tls = threading.local()


def set_caller_token(token: str) -> None:
    _tls.token = token


def get_caller_token() -> Optional[str]:
    return getattr(_tls, 'token', None)


class ApiError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(f'{status}: {message}')
        self.status  = status
        self.message = message


def api_call(method: str, path: str, body: Any = None, *, timeout: int = 30) -> Any:
    """
    Call the KostOps API with the caller's bearer token.
    Raises ApiError on non-2xx responses.
    """
    if not API_BASE_URL:
        raise ApiError(500, 'API_BASE_URL env var not configured for agent')

    token = get_caller_token()
    if not token:
        raise ApiError(401, 'no caller token bound to this invocation')

    url = f'{API_BASE_URL.rstrip("/")}{path}'
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


def get(path: str, **kw)  -> Any: return api_call('GET',    path, **kw)
def post(path: str, body, **kw) -> Any: return api_call('POST',   path, body, **kw)
def put(path: str, body, **kw)  -> Any: return api_call('PUT',    path, body, **kw)
def patch(path: str, body, **kw) -> Any: return api_call('PATCH', path, body, **kw)
def delete(path: str, **kw) -> Any: return api_call('DELETE', path, **kw)
