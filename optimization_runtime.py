"""
AgentCore process entry — intentionally tiny.

Only json + stdlib http so GET /ping succeeds within AgentCore’s init window.
Heavy agent code loads on first POST /invocations (optimization_agent_core — the FinOps Agent).
"""

import json
import logging
import time
from http.server import HTTPServer, BaseHTTPRequestHandler
from socketserver import ThreadingMixIn

_t0 = time.time()
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger('kostops.finops_agent_runtime')


def _elapsed() -> str:
    return f"{time.time() - _t0:.1f}s"


class _AgentCoreHandler(BaseHTTPRequestHandler):
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

        logger.info(f"invocation | len={len(message)} at {_elapsed()}")
        try:
            from optimization_agent_core import _get_agent
            reply = _get_agent()(message)
            self._send_json(200, {'output': reply})
        except Exception as e:
            logger.exception('invocation failed')
            # Always 200 so AgentCore returns the body to the client (5xx is often opaque to callers)
            self._send_json(200, {'output': f'Agent error: {type(e).__name__}: {e}'})


class _ThreadedHTTPServer(ThreadingMixIn, HTTPServer):
    daemon_threads      = True
    allow_reuse_address = True


logger.info(f"binding 0.0.0.0:8080 at {_elapsed()}")
_server = _ThreadedHTTPServer(('0.0.0.0', 8080), _AgentCoreHandler)
logger.info(f"ready — first POST loads optimization_agent_core at {_elapsed()}")
_server.serve_forever()
