"""
KostOps AgentCore Runtime Entrypoint
------------------------------------
Thin HTTP layer that speaks the Bedrock AgentCore Runtime protocol and
delegates every turn to `agents.supervisor.dispatch`.

Replaces the monolithic `visibility_agent.py` entrypoint. Behaviour for
end users is identical at MVP — the supervisor routes every message to
`agents.visibility.handle` because that's the only specialist registered
for now. Phase 1+ adds Budget / Optimization / Analytics to the SPECIALISTS
table in agents/supervisor.py and the dispatcher starts making real choices.

HTTP server: pure Python stdlib (http.server + ThreadingMixIn). We
deliberately avoid pydantic / bedrock_agentcore / starlette because their
Rust .so imports exceed the AgentCore 30s cold-start init budget.

Protocol:
  GET  /ping          → 200 {"status": "Healthy"}
  POST /invocations   → 200 {"output": "<reply>"}

The POST body may carry optional `claims`, `groups`, `token`, and `page`
fields — chat_handler.py forwards these so the supervisor can enforce
role-gates and write tools can pass through the caller's JWT. Missing
fields degrade safely to "read-only, no write tools".
"""

import os
import json
import time
import logging
from http.server import HTTPServer, BaseHTTPRequestHandler
from socketserver import ThreadingMixIn

# ── Startup timing ────────────────────────────────────────────────────────────
_t0 = time.time()
def _elapsed() -> str:
    return f"{time.time() - _t0:.1f}s"

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)
logger.info(f"[startup] imports starting at {_elapsed()}")

from agents import supervisor, api_client  # noqa: E402

logger.info(f"[startup] supervisor imported at {_elapsed()}")


# ── HTTP handler ──────────────────────────────────────────────────────────────

class _AgentCoreHandler(BaseHTTPRequestHandler):
    """Implements the Bedrock AgentCore Runtime protocol (GET /ping, POST /invocations)."""

    def log_message(self, fmt, *args):
        logger.debug('http: ' + fmt, *args)

    def _send_json(self, code: int, data: dict):
        body = json.dumps(data, ensure_ascii=False).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == '/ping':
            self._send_json(200, {'status': 'Healthy'})
        else:
            self._send_json(404, {'error': 'not found'})

    def do_POST(self):
        if self.path != '/invocations':
            self._send_json(404, {'error': 'not found'})
            return

        length = int(self.headers.get('Content-Length', 0))
        raw    = self.rfile.read(length) if length else b'{}'
        try:
            payload = json.loads(raw)
        except Exception:
            self._send_json(400, {'error': 'invalid JSON'})
            return

        message = (payload or {}).get('inputText', '').strip()
        if not message:
            self._send_json(200, {'output': 'No message provided.'})
            return

        # Build ctx from optional caller-forwarded fields. All five are optional;
        # supervisor handles missing values by defaulting to viewer-read-only.
        ctx = {
            'claims':     payload.get('claims')     or {},
            'groups':     payload.get('groups')     or [],
            'sub':        payload.get('sub')        or '',
            'token':      payload.get('token')      or '',
            'apiBaseUrl': payload.get('apiBaseUrl') or '',
            'page':       payload.get('page')       or {},
        }

        logger.info(
            f"Invocation | message_len={len(message)} "
            f"| has_token={bool(ctx['token'])} | has_apiUrl={bool(ctx['apiBaseUrl'])}"
        )
        # Bind caller identity + API URL for any write tools the specialists invoke.
        # The binding is thread-local; ThreadingMixIn gives each request its own
        # thread, so concurrent invocations don't leak credentials.
        api_client.set_caller(token=ctx['token'], api_base_url=ctx['apiBaseUrl'])
        try:
            reply = supervisor.dispatch(message, ctx)
            logger.info(f"Invocation done | reply_len={len(reply)}")
            self._send_json(200, {'output': reply})
        except Exception as e:
            logger.exception("Supervisor dispatch failed")
            self._send_json(500, {'output': f'Agent error: {e}'})
        finally:
            api_client.clear_caller()


class _ThreadedHTTPServer(ThreadingMixIn, HTTPServer):
    """Handle each request in a separate thread."""
    daemon_threads     = True
    allow_reuse_address = True


# ── Start server (module-level so AgentCore's `python agent_entrypoint.py` runs it) ──
logger.info(f"[startup] starting HTTP server on 0.0.0.0:8080 at {_elapsed()}")
_server = _ThreadedHTTPServer(('0.0.0.0', 8080), _AgentCoreHandler)
logger.info(f"[startup] HTTP server ready at {_elapsed()} — serving AgentCore requests")
_server.serve_forever()
