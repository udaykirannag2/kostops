"""
KostOps Visibility Agent
------------------------
Deployed on Amazon Bedrock AgentCore Runtime.

Uses boto3.converse() directly instead of strands-agents.
This eliminates Rust extension cold-start overhead:
  removed: pydantic_core (4.1 MB .so), yaml (2.6 MB .so), rpds (1.0 MB .so)
  result:  startup < 5s vs > 30s with strands-agents

Agent loop:
  1. Send message + tool schemas to Claude via bedrock-runtime.converse()
  2. If stopReason == 'tool_use': call the tool, feed result back
  3. Repeat until stopReason == 'end_turn'
  4. Return final text response

Tool schemas are auto-generated from:
  - Function name         → tool name
  - First docstring line  → tool description
  - Type annotations      → parameter types
  - Parameters with no default → required list
"""

import os
import json
import time
import inspect
import logging
import threading
import boto3
from typing import get_type_hints, Optional, List, Dict, Any
from bedrock_agentcore import BedrockAgentCoreApp

# ── Startup timing — helps diagnose cold-start issues ────────────────────────
_t0 = time.time()
def _elapsed() -> str:
    return f"{time.time() - _t0:.1f}s"

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)
logger.info(f"[startup] bedrock_agentcore imported at {_elapsed()}")

# ── Tool imports (use @tool stub from strands/__init__.py — no pydantic) ─────
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
You are KostOps — an AWS cost visibility and optimization agent.

ACCOUNT CONTEXT:
- You run in a LINKED account inside an AWS Organization
- Billing data (Cost Explorer, Compute Optimizer, Budgets) comes from the PAYER account via cross-account role
- Resource data (EC2, CloudWatch) comes from this LINKED account
- CUR/Athena data comes from a replicated bucket in this linked account

TOOL CATEGORIES:

1. Billing tools — payer account credentials via sts:AssumeRole:
   get_cost_and_usage, get_cost_forecast, get_cost_comparison
   get_anomalies, describe_anomaly_monitors
   get_rightsizing_recommendations, get_savings_plans_purchase_recommendation
   get_budget_list, get_budget_performance
   get_cost_optimization_hub_recommendations

2. CUR / Athena tools — linked account (replicated payer data):
   get_spend_by_service, get_spend_by_account, get_spend_last_13_months
   get_daily_spend_trend, get_top_cost_drivers

3. EC2 resource discovery — linked account:
   list_unattached_ebs_volumes, list_old_snapshots, list_nonprod_instances

4. Findings persistence — DynamoDB:
   save_finding, list_findings, get_finding

RULES:
- Never invent numbers — every figure must come from a tool call
- Cost Explorer API costs $0.01/call — batch queries, never repeat identical calls
- Always save new findings via save_finding so they appear in the React UI
- Keep answers concise — engineers want facts and numbers

WORKFLOWS:
"Why did costs go up?"
  1. get_cost_comparison (spike period vs prior)
  2. get_anomalies (same period)
  3. get_daily_spend_trend from Athena
  4. Return 3-sentence summary with actual dollar amounts

"What should I fix this week?"
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
    """Convert a Python type annotation to a JSON Schema type string."""
    if annotation is inspect.Parameter.empty:
        return 'string'

    # Handle Optional[X] → X
    origin = getattr(annotation, '__origin__', None)
    args   = getattr(annotation, '__args__', ())

    if origin is type(None):
        return 'string'

    # typing.Union (covers Optional)
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
    """Build a Bedrock Converse API toolSpec dict from a Python function."""
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
    """
    Minimal agent loop using boto3.converse().

    No strands-agents, no pydantic — just boto3 (pre-installed in AgentCore
    runtime) plus a tool-use loop that matches what strands does internally.
    """

    MAX_ROUNDS = 20   # guard against infinite tool-use loops

    def __init__(self, tools: list, system_prompt: str):
        self._tool_map    = {fn.__name__: fn for fn in tools}
        self._tool_config = {'tools': [_make_tool_spec(fn) for fn in tools]}
        self._system      = [{'text': system_prompt}]
        self._model_id    = os.environ.get(
            'BEDROCK_MODEL_ID',
            'anthropic.claude-sonnet-4-5-20250929-v1:0',
        )
        self._region = os.environ.get('AWS_REGION', 'us-east-1')
        # Lazy client — created on first call (not at import time)
        self._bedrock: Optional[Any] = None

    def _client(self):
        if self._bedrock is None:
            self._bedrock = boto3.client('bedrock-runtime', region_name=self._region)
        return self._bedrock

    def __call__(self, message: str, **kwargs) -> str:
        """
        Run the agent loop for one user message.
        kwargs absorbs any extra args BedrockAgentCoreApp might pass (e.g. session_id).
        """
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
                # max_tokens, stop_sequence, content_filtered, etc.
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
        # Billing (payer account via sts:AssumeRole)
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
        # CUR / Athena (linked account, replicated payer data)
        get_spend_by_service,
        get_spend_by_account,
        get_spend_last_13_months,
        get_daily_spend_trend,
        get_top_cost_drivers,
        # EC2 resource discovery (linked account)
        list_unattached_ebs_volumes,
        list_old_snapshots,
        list_nonprod_instances,
        # Findings persistence (DynamoDB)
        save_finding,
        list_findings,
        get_finding,
    ],
)

logger.info(f"[startup] agent ready at {_elapsed()}")

# ── AgentCore Runtime wrapper ─────────────────────────────────────────────────
#
# BedrockAgentCoreApp() takes NO positional/keyword agent argument.
# The agent is wired in via the @app.entrypoint decorator below.
# Passing agent=agent raises TypeError which crashes the container immediately,
# causing the "initialization time exceeded" error on every invocation.
#
app = BedrockAgentCoreApp()
logger.info(f"[startup] BedrockAgentCoreApp created at {_elapsed()}")


@app.entrypoint
def handle(payload: dict, context=None) -> dict:
    """
    AgentCore Runtime entry point.

    Called by BedrockAgentCoreApp for every POST /invocations request.
    payload = {'inputText': '<user message>'}   (sent by chat_handler.py)
    Returns {'output': '<agent reply>'}          (read by chat_handler.py)
    """
    message = (payload or {}).get('inputText', '').strip()

    if not message:
        return {'output': 'No message provided.'}

    logger.info(f"Entrypoint called | message_len={len(message)}")
    reply = agent(message)
    logger.info(f"Entrypoint done   | reply_len={len(reply)}")
    return {'output': reply}


logger.info(f"[startup] entrypoint registered at {_elapsed()}")

# ── Start the HTTP server ─────────────────────────────────────────────────────
#
# app.run() is called at module level (NOT inside `if __name__ == '__main__'`)
# because AgentCore Runtime may IMPORT this file as a module rather than
# running it as a script. If it's inside __main__, app.run() is never called
# when the runtime imports the module, so the HTTP server never starts.
#
# host='0.0.0.0' is required: AgentCore Runtime containers may not set
# /.dockerenv or DOCKER_CONTAINER, causing app.run() to default to 127.0.0.1
# (loopback only). The AgentCore platform reaches the container from outside
# and cannot connect to loopback, causing every health check to time out.

import sys as _sys

if '--local' in _sys.argv:
    # Local REPL mode — skip the HTTP server
    print("KostOps running locally. Type 'exit' to quit.\n")
    while True:
        _user_input = input("You: ").strip()
        if _user_input.lower() in ("exit", "quit"):
            break
        _response = agent(_user_input)
        print(f"\nKostOps: {_response}\n")
else:
    logger.info(f"[startup] calling app.run() at {_elapsed()}")
    app.run(host='0.0.0.0')
