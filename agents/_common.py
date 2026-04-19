"""
agents/_common.py
-----------------
Shared primitives used by every specialist agent:

  - Tool schema auto-generation from Python type hints (Strands-style)
  - A minimal boto3 `converse()` tool loop (no external SDK deps)

The supervisor module re-exports `SpecialistAgent` so each `agents/<name>.py`
can simply:

    from ._common import SpecialistAgent
    agent = SpecialistAgent(name='visibility', system_prompt=..., tools=[...])

Nothing in this file is agent-specific; each specialist supplies its own
prompt, tool list, and (optionally) model id.
"""

from __future__ import annotations

import os
import json
import inspect
import logging
from typing import Any, Callable, Dict, List, Optional, get_type_hints

import boto3

logger = logging.getLogger(__name__)


# ── Tool schema auto-generation (mirrors visibility_agent.py) ────────────────

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


def make_tool_spec(fn: Callable) -> dict:
    """Build a Bedrock toolSpec from a plain-Python function's signature."""
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
        properties[name] = {'type': _resolve_type(annotation)}
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


# ── Minimal converse() tool loop, agent-agnostic ─────────────────────────────

class SpecialistAgent:
    """
    One specialist = one system prompt + one tool list + one `converse()` loop.

    Re-entrancy: callers may instantiate once at module load and then call
    `handle(message)` per request. The underlying boto3 client is lazy-created
    and reused across invocations; `messages` is built fresh each call so state
    does not leak between turns.
    """

    MAX_ROUNDS = 20

    def __init__(self, name: str, system_prompt: str, tools: List[Callable],
                 model_id: Optional[str] = None):
        self.name           = name
        self._tool_map      = {fn.__name__: fn for fn in tools}
        self._tool_config   = {'tools': [make_tool_spec(fn) for fn in tools]}
        self._system        = [{'text': system_prompt}]
        self._model_id      = model_id or os.environ.get(
            'BEDROCK_MODEL_ID',
            'us.anthropic.claude-sonnet-4-5-20250929-v1:0',
        )
        self._region        = os.environ.get('AWS_REGION', 'us-east-1')
        self._bedrock       = None

    def _client(self):
        if self._bedrock is None:
            self._bedrock = boto3.client('bedrock-runtime', region_name=self._region)
        return self._bedrock

    def handle(self, message: str, **kwargs) -> str:
        """Run one chat turn. Returns the assistant text."""
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
                logger.error(f"[{self.name}] bedrock converse error: {e}")
                return f"Error calling Bedrock: {e}"

            output_msg  = resp['output']['message']
            stop_reason = resp['stopReason']
            messages.append(output_msg)
            logger.info(f"[{self.name} round {round_num}] stopReason={stop_reason}")

            if stop_reason == 'end_turn':
                return self._extract_text(output_msg)
            if stop_reason == 'tool_use':
                tool_results = self._run_tools(output_msg)
                messages.append({'role': 'user', 'content': tool_results})
            else:
                logger.warning(f"[{self.name}] unexpected stopReason: {stop_reason}")
                return self._extract_text(output_msg) or f"Agent stopped: {stop_reason}"

        return "Agent reached maximum tool-call depth without a final answer."

    # Allow `agent(message)` sugar for backwards compat with the old agent API.
    __call__ = handle

    def _run_tools(self, message: dict) -> list:
        results = []
        for block in message.get('content', []):
            if 'toolUse' not in block:
                continue
            tool_use = block['toolUse']
            name     = tool_use['name']
            inputs   = tool_use.get('input', {})
            tool_id  = tool_use['toolUseId']
            logger.info(f"[{self.name}] tool: {name}({list(inputs.keys())})")
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
