"""
KostOps Visibility Agent
------------------------
Deployed on Amazon Bedrock AgentCore Runtime.

HTTP server: pure Python stdlib (http.server + ThreadingMixIn).
NO bedrock_agentcore / NO pydantic / NO Rust .so files.
Reason: pydantic_core's 4.1 MB ARM64 .so exceeds AgentCore's 30s
        cold-start initialization timeout when loaded via dlopen().

Agent loop: boto3.converse() — pure Python, ships in the zip.

Protocol (AgentCore Runtime):
  GET  /ping          → {"status": "Healthy"}
  POST /invocations   → {"inputText": "..."} → {"output": "..."}
"""

import os
import json
import time
import inspect
import logging
import threading
from http.server import HTTPServer, BaseHTTPRequestHandler
from socketserver import ThreadingMixIn
from typing import get_type_hints, Optional, List, Dict, Any
import boto3

# ── Startup timing ────────────────────────────────────────────────────────────
_t0 = time.time()
def _elapsed() -> str:
    return f"{time.time() - _t0:.1f}s"

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)
logger.info(f"[startup] imports done at {_elapsed()}")

# ── Tool imports ──────────────────────────────────────────────────────────────
from tools.billing_tools import (
    get_cost_and_usage,
    get_cost_forecast,
    get_cost_comparison,
    get_anomalies,
    describe_anomaly_monitors,
    get_dimension_values,
    get_tag_values,
    get_today_date,
    get_savings_plans_purchase_recommendation,
    get_rightsizing_recommendations,
    get_budget_list,
    get_budget_performance,
    get_cost_optimization_hub_recommendations,
)
from tools.athena_tools import (
    get_spend_by_service,
    get_spend_by_account,
    get_spend_last_13_months,
    get_daily_spend_trend,
    get_top_cost_drivers,
)
from tools.ec2_tools import (
    list_unattached_ebs_volumes,
    list_old_snapshots,
    list_nonprod_instances,
)
from tools.findings_tools import (
    save_finding,
    list_findings,
    get_finding,
)

logger.info(f"[startup] tool imports done at {_elapsed()}")

# ── System prompt ─────────────────────────────────────────────────────────────
SYSTEM_PROMPT = """
You are KostOps — an AWS FinOps assistant for cost visibility and optimization.

ACCOUNT CONTEXT:
- You run in an AWS account that has full billing and CUR data available
- CUR data is queryable via Athena (get_spend_* tools) — this is your PRIMARY data source
- Cost Explorer tools (get_cost_and_usage etc.) work for this account directly
- If a payer cross-account role is not configured, billing tools use this account's credentials — all data is still available
- Resource data (EC2, EBS snapshots) comes from this account

TOOL PRIORITY — always try in this order:
1. ATHENA TOOLS FIRST for any spend/cost questions (fast, free, detailed):
   get_spend_last_13_months, get_spend_by_service, get_spend_by_account,
   get_daily_spend_trend, get_top_cost_drivers
2. BILLING TOOLS for forecasts, anomalies, recommendations, budgets:
   get_cost_and_usage, get_cost_forecast, get_cost_comparison,
   get_anomalies, get_rightsizing_recommendations,
   get_savings_plans_purchase_recommendation, get_budget_list,
   get_cost_optimization_hub_recommendations
3. EC2 TOOLS for resource waste:
   list_unattached_ebs_volumes, list_old_snapshots, list_nonprod_instances
4. FINDINGS for persistence:
   save_finding, list_findings, get_finding

RULES:
- ALWAYS call get_today_date first before constructing any date range
- Never invent numbers — every figure must come from a tool call
- If a billing tool call fails, immediately fall back to the equivalent Athena tool
- Cost Explorer API costs $0.01/call — never repeat identical calls
- Save actionable findings via save_finding so they appear in the UI
- Keep answers concise — lead with the key number, add context only if needed

RESPONSE FORMAT:
- Lead with the single most important number in bold: **$X,XXX** or **+X%**
- Single-number answers: one sentence, no table, no list
- Multi-row data (4+ rows): use a markdown table with | column | headers |
- Three rows or fewer: use a short bullet list instead of a table
- End every multi-part response with one italicised offer: _Want X? Just ask._
- Numbers: $X,XXX format for thousands; % changes with sign (+12%, -4%)
- Never use headers (#, ##) — responses are chat bubbles, not documents
- Never pad with filler phrases ("Great question", "Certainly", "As you can see")

WORKFLOWS:
"Show me spend / costs / how much am I spending?"
  1. get_today_date
  2. get_spend_last_13_months (Athena — always works)
  3. get_spend_by_service (for current month)
  4. Summarize top services and monthly trend

"Why did costs go up?"
  1. get_today_date
  2. get_spend_by_service for the spike period (Athena)
  3. get_daily_spend_trend to find the exact day
  4. get_cost_comparison (CE) for context
  5. Return 3-sentence summary with actual dollar amounts

"What should I fix / optimize?"
  1. list_findings (OPEN) — show cached first
  2. get_cost_optimization_hub_recommendations
  3. get_rightsizing_recommendations
  4. list_unattached_ebs_volumes + list_old_snapshots
  5. Rank by savings, save new findings, return top 5
""".strip()

# ── Tool schema auto-generation ───────────────────────────────────────────────

_PY_TO_JSON_TYPE: Dict[type, str] = {
    str:   'string',
    int:   'integer',
    float: 'number',
    bool:  'boolean',
    list:  'array',
    dict:  'object',
    List:  'array',
    Dict:  'object',
}

def _resolve_type(annotation) -> str:
    if annotation is inspect.Parameter.empty:
        return 'string'
    origin = getattr(annotation, '__origin__', None)
    args   = getattr(annotation, '__args__', ())
    if origin is type(None):
        return 'string'
    import typing
    if origin is typing.Union:
        non_none = [a for a in args if a is not type(None)]
        return _resolve_type(non_none[0]) if non_none else 'string'
    if origin in (list, List):
        return 'array'
    if origin in (dict, Dict):
        return 'object'
    return _PY_TO_JSON_TYPE.get(annotation, 'string')


def _make_tool_spec(fn) -> dict:
    doc = inspect.getdoc(fn) or fn.__name__
    description = doc.split('\n')[0].strip()
    try:
        hints = get_type_hints(fn)
    except Exception:
        hints = {}
    sig        = inspect.signature(fn)
    properties: Dict[str, Any] = {}
    required:   List[str]      = []
    for name, param in sig.parameters.items():
        if name == 'self':
            continue
        annotation = hints.get(name, str)
        json_type  = _resolve_type(annotation)
        properties[name] = {'type': json_type}
        if param.default is inspect.Parameter.empty:
            required.append(name)
    return {
        'toolSpec': {
            'name':        fn.__name__,
            'description': description,
            'inputSchema': {
                'json': {
                    'type':       'object',
                    'properties': properties,
                    'required':   required,
                }
            },
        }
    }


# ── KostOpsAgent ──────────────────────────────────────────────────────────────

class KostOpsAgent:
    MAX_ROUNDS = 20

    def __init__(self, tools: list, system_prompt: str):
        self._tool_map    = {fn.__name__: fn for fn in tools}
        self._tool_config = {'tools': [_make_tool_spec(fn) for fn in tools]}
        self._system      = [{'text': system_prompt}]
        self._model_id    = os.environ.get(
            'BEDROCK_MODEL_ID',
            'us.anthropic.claude-sonnet-4-5-20250929-v1:0',
        )
        self._region  = os.environ.get('AWS_REGION', 'us-east-1')
        self._bedrock = None

    def _client(self):
        if self._bedrock is None:
            self._bedrock = boto3.client('bedrock-runtime', region_name=self._region)
        return self._bedrock

    def __call__(self, message: str, **kwargs) -> str:
        if message.strip() == '__ping__':
            return 'pong'
        messages = [{'role': 'user', 'content': [{'text': message}]}]
        for round_num in range(self.MAX_ROUNDS):
            try:
                resp = self._client().converse(
                    modelId    = self._model_id,
                    system     = self._system,
                    messages   = messages,
                    toolConfig = self._tool_config,
                )
            except Exception as e:
                logger.error(f"Bedrock converse error: {e}")
                return f"Error calling Bedrock: {e}"
            output_msg  = resp['output']['message']
            stop_reason = resp['stopReason']
            messages.append(output_msg)
            logger.info(f"[round {round_num}] stopReason={stop_reason}")
            if stop_reason == 'end_turn':
                return self._extract_text(output_msg)
            if stop_reason == 'tool_use':
                tool_results = self._run_tools(output_msg)
                messages.append({'role': 'user', 'content': tool_results})
            else:
                logger.warning(f"Unexpected stopReason: {stop_reason}")
                return self._extract_text(output_msg) or f"Agent stopped: {stop_reason}"
        return "Agent reached maximum tool-call depth without a final answer."

    def _run_tools(self, message: dict) -> list:
        results = []
        for block in message.get('content', []):
            if 'toolUse' not in block:
                continue
            tool_use = block['toolUse']
            name     = tool_use['name']
            inputs   = tool_use.get('input', {})
            tool_id  = tool_use['toolUseId']
            logger.info(f"Tool: {name}({list(inputs.keys())})")
            try:
                fn     = self._tool_map[name]
                result = fn(**inputs)
                status = 'success'
                text   = json.dumps(result) if isinstance(result, (dict, list)) else str(result)
            except KeyError:
                status = 'error'
                text   = f"Unknown tool: {name}"
                logger.error(text)
            except Exception as e:
                status = 'error'
                text   = f"Tool {name} failed: {e}"
                logger.error(text)
            results.append({
                'toolResult': {
                    'toolUseId': tool_id,
                    'content':   [{'text': text}],
                    'status':    status,
                }
            })
        return results

    @staticmethod
    def _extract_text(message: dict) -> str:
        for block in message.get('content', []):
            if isinstance(block, dict) and 'text' in block:
                return block['text']
        return str(message)


# ── Instantiate agent ─────────────────────────────────────────────────────────

agent = KostOpsAgent(
    system_prompt = SYSTEM_PROMPT,
    tools = [
        get_today_date,
        get_cost_and_usage,
        get_cost_forecast,
        get_cost_comparison,
        get_anomalies,
        describe_anomaly_monitors,
        get_dimension_values,
        get_tag_values,
        get_savings_plans_purchase_recommendation,
        get_rightsizing_recommendations,
        get_budget_list,
        get_budget_performance,
        get_cost_optimization_hub_recommendations,
        get_spend_by_service,
        get_spend_by_account,
        get_spend_last_13_months,
        get_daily_spend_trend,
        get_top_cost_drivers,
        list_unattached_ebs_volumes,
        list_old_snapshots,
        list_nonprod_instances,
        save_finding,
        list_findings,
        get_finding,
    ],
)

logger.info(f"[startup] agent ready at {_elapsed()}")

# ── AgentCore HTTP server (stdlib only — no pydantic, no Rust .so) ────────────
#
# bedrock_agentcore (FastAPI + pydantic_core) was removed because
# pydantic_core's 4.1 MB ARM64 .so exceeds AgentCore's 30s cold-start
# initialization timeout. Pure stdlib http.server starts in < 100ms.
#
# Protocol:
#   GET  /ping          → 200 {"status": "Healthy"}
#   POST /invocations   → 200 {"output": "<reply>"}

class _AgentCoreHandler(BaseHTTPRequestHandler):
    """HTTP handler implementing the AgentCore Runtime protocol."""

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
        if self.path == '/invocations':
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

            logger.info(f"Invocation | message_len={len(message)}")
            try:
                reply = agent(message)
                logger.info(f"Invocation done | reply_len={len(reply)}")
                self._send_json(200, {'output': reply})
            except Exception as e:
                logger.exception("Agent invocation failed")
                self._send_json(500, {'output': f'Agent error: {e}'})
        else:
            self._send_json(404, {'error': 'not found'})


class _ThreadedHTTPServer(ThreadingMixIn, HTTPServer):
    """Handle each request in a separate thread."""
    daemon_threads = True
    allow_reuse_address = True


# ── Start server (module level — runs whether imported or executed) ───────────
logger.info(f"[startup] starting HTTP server on 0.0.0.0:8080 at {_elapsed()}")
_server = _ThreadedHTTPServer(('0.0.0.0', 8080), _AgentCoreHandler)
logger.info(f"[startup] HTTP server ready at {_elapsed()} — serving AgentCore requests")
_server.serve_forever()

# bundle-bust: boto3-included 20260409T014353Z
