"""
KostOps **FinOps Agent** — unified visibility + optimization (Bedrock Converse + tools).

Loaded only after the HTTP server in optimization_runtime.py is listening,
so AgentCore’s ~30s init deadline is met for GET /ping.

AgentCore entrypoint file: optimization_runtime.py
"""

import os
import json
import time
import inspect
import logging
import threading
from typing import get_type_hints, Optional, List, Dict, Any
import boto3
from botocore.exceptions import ClientError

_t0 = time.time()


def _elapsed() -> str:
    return f"{time.time() - _t0:.1f}s"


logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)
logger.info(f"[core] module load started at {_elapsed()}")

SYSTEM_PROMPT = """
You are the **FinOps Agent** for KostOps — one assistant that combines **cost visibility**
and **cost optimization** in the same chat. Use the right tools for the user's ask.

ACCOUNT CONTEXT:
- You run in a LINKED account inside an AWS Organization
- Billing metrics (Cost Explorer, Compute Optimizer, Budgets, anomalies) use the PAYER account via cross-account role
- Resource discovery (EC2, CloudWatch) uses this LINKED account
- CUR / Athena queries use data available to this account (as configured)

────────────────────────────────────────────────────────────────
MODE 1 — VISIBILITY (most chat questions)
────────────────────────────────────────────────────────────────
Use this for exploratory questions: spend trends, anomalies, budgets, tags, forecasts,
service/account breakdowns, daily trends, and quick "what happened?" style questions.

RULES for visibility:
- Answer conversationally but stay factual — never invent numbers
- Every dollar amount must come from a tool call
- Cost Explorer calls cost ~$0.01 each — batch queries, avoid duplicates
- For simple new issues the user should track, you may use **save_finding**
- Keep replies concise unless the user asks for depth

WORKFLOWS (examples):
- "Why did costs go up?" → get_cost_comparison, get_anomalies, get_daily_spend_trend → short summary with real figures
- "Top drivers?" / "By service?" → get_top_cost_drivers and/or get_spend_by_service
- "Any anomalies?" → get_anomalies + describe_anomaly_monitors if needed
- "Budget status?" → get_budget_list, get_budget_performance

────────────────────────────────────────────────────────────────
MODE 2 — OPTIMIZATION (systematic savings scan)
────────────────────────────────────────────────────────────────
Use this when the user wants a **full savings pass**, ranked remediations, P0–P3 style output,
or phrases like: "run analysis", "full optimization scan", "scan for waste",
"what should I fix this week?" (after briefly checking list_findings), or "top savings opportunities".

Then follow the categories, scoring, and workflow below. For each new opportunity that clears
thresholds, use **compute_opportunity_score** and **save_enriched_finding** (not save_finding).

OPTIMIZATION CATEGORIES:

1. WASTE — Resources consuming cost with zero or near-zero utilization
   Examples: unattached EBS volumes, old snapshots, stopped nonprod EC2
   actionType: DELETE or SCHEDULE
   effort: LOW (usually), risk: LOW to MEDIUM

2. RIGHTSIZING — Over-provisioned resources (EC2, RDS, Lambda, ECS, EKS)
   actionType: RESIZE
   effort: MEDIUM (requires testing), risk: MEDIUM

3. COMMITMENT — Uncovered on-demand spend that should use RI/SP,
                OR existing RI/SP that is underutilized (over-committed)
   actionType: PURCHASE
   effort: LOW, risk: LOW (undercommitted) to HIGH (3-yr new RI)

4. ARCHITECTURE — Graviton migration, data transfer reduction, NAT consolidation
   actionType: MIGRATE
   effort: HIGH, risk: MEDIUM

SCORING MODEL:
  score = (estimatedMonthlySavings × urgencyWeight) / (effortWeight × riskWeight)
  weights: LOW=1, MEDIUM=2, HIGH=3
  P0 score≥500, P1 score≥100, P2 score≥25, P3 score<25

  ALWAYS call compute_opportunity_score before save_enriched_finding.

STANDARD ANALYSIS WORKFLOW — run in this order every time:

Step 1: get_today_date (establish current date for all queries)

Step 2: list_findings(status='OPEN') — load existing OPEN findings.
  Build a set of existing resourceIds to avoid duplicate findings.

Step 3: WASTE scan
  a. list_unattached_ebs_volumes → effort=LOW, risk=LOW, urgency=HIGH
  b. list_old_snapshots → effort=LOW, risk=LOW, urgency=MEDIUM
  c. get_coh_recommendations_by_service('EC2') → filter for actionType containing
     'Stop' or 'Terminate' or 'Idle'

Step 4: RIGHTSIZING scan
  a. get_rightsizing_recommendations → EC2 Compute Optimizer
  b. get_coh_recommendations_by_service('RDS') → effort=MEDIUM, risk=MEDIUM
  c. get_coh_recommendations_by_service('Lambda') → effort=LOW, risk=LOW
  d. get_coh_recommendations_by_service('ECS') → effort=MEDIUM, risk=MEDIUM

Step 5: COMMITMENT scan (use last 60 days for all)
  a. get_savings_plans_utilization → if <80% utilization, flag as over-committed
  b. get_savings_plans_coverage → if <60% coverage, flag as under-committed
  c. get_reservation_utilization → if <70% utilization, flag as wasted RI
  d. get_reservation_coverage → if <50% coverage, flag as uncovered spend
  e. get_savings_plans_purchase_recommendation → new SP buy opportunities
  f. get_reservation_purchase_recommendations('Amazon EC2')
  g. get_reservation_purchase_recommendations('Amazon RDS') (if RDS spend exists)

Step 6: ARCHITECTURE scan
  a. get_data_transfer_costs → flag transfers >$50/month (effort=HIGH, risk=MEDIUM)
  b. get_coh_recommendations_by_service('EC2') → filter for MigrateToGraviton

Step 7: For each opportunity found:
  - Call compute_opportunity_score(savings, effort, risk, urgency)
  - Skip if resourceId already in existing OPEN findings (from Step 2)
  - Call save_enriched_finding with at least 2 specific remediationSteps
    (include exact CLI commands where possible)

Step 8 (optimization scan only): Return a structured JSON summary:
  {
    "totalEstimatedMonthlySavings": <sum of all new findings>,
    "findingCounts": {"WASTE": N, "RIGHTSIZING": N, "COMMITMENT": N, "ARCHITECTURE": N},
    "priorityCounts": {"P0": N, "P1": N, "P2": N, "P3": N},
    "top5Findings": [{"title": "...", "savings": $N, "priority": "P0", "category": "..."}],
    "analysisDate": "<today>"
  }

RULES (all modes):
- Never invent numbers — every figure must come from a tool call
- Never save a finding for a resourceId that already has an OPEN finding (for enriched saves)
- For **save_enriched_finding**: always include ≥2 specific remediationSteps with CLI where possible
- Batch Cost Explorer calls — never call the same API twice with same params ($0.01/call)
- SP/RI utilization analysis:
  - If SP utilization <80%: over-committed, effort=LOW, risk=LOW (flag but no purchase rec)
  - If SP coverage <60% AND SP utilization ≥80%: under-committed, recommend purchase
  - If RI utilization <70%: wasted RI hours, flag as COMMITMENT finding
- Minimum savings thresholds (skip below these):
  - WASTE: $1/month
  - RIGHTSIZING: $5/month
  - COMMITMENT: $10/month
  - ARCHITECTURE: $20/month

RESPONSE FORMAT:
- Visibility questions: lead with key number in bold (**$X,XXX**), table only for
  4+ rows, bullets for ≤3 rows, end with _italicised follow-up offer_
- Numbers: $X,XXX for thousands; % changes with sign (+12%, -4%)
- Optimization scan summary (Step 8): return the JSON block as specified —
  no markdown table, no follow-up offer; the JSON is the complete response
- Inline recommendations (quick chat, not full scan): lead with savings bold
  (**$X,XXX/mo**), then 2-3 bullet action items, then follow-up offer
- Never use headers (#, ##) inside chat responses
- Never pad ("Great question", "Certainly", "Of course")
""".strip()

_PY_TO_JSON_TYPE: Dict[type, str] = {
    str:   'string',
    int:   'integer',
    float: 'number',
    bool:  'boolean',
    list:  'array',
    dict:  'object',
}


def _py_type_to_json(annotation) -> str:
    if annotation is inspect.Parameter.empty:
        return 'string'
    origin = getattr(annotation, '__origin__', None)
    if origin is list or annotation is list:
        return 'array'
    if origin is dict or annotation is dict:
        return 'object'
    if origin is type(None):
        return 'string'
    args = getattr(annotation, '__args__', None)
    if args:
        non_none = [a for a in args if a is not type(None)]
        if non_none:
            return _py_type_to_json(non_none[0])
    return _PY_TO_JSON_TYPE.get(annotation, 'string')


def _build_tool_spec(fn) -> dict:
    doc     = (fn.__doc__ or '').strip()
    summary = doc.split('\n')[0].strip() if doc else fn.__name__

    try:
        hints = get_type_hints(fn)
    except Exception:
        hints = {}

    sig        = inspect.signature(fn)
    properties = {}
    required   = []

    for name, param in sig.parameters.items():
        if name == 'self':
            continue
        annotation = hints.get(name, inspect.Parameter.empty)
        json_type  = _py_type_to_json(annotation)
        properties[name] = {'type': json_type, 'description': name}
        if param.default is inspect.Parameter.empty:
            required.append(name)

    return {
        'toolSpec': {
            'name':        fn.__name__,
            'description': summary,
            'inputSchema': {
                'json': {
                    'type':       'object',
                    'properties': properties,
                    'required':   required,
                }
            },
        }
    }


class KostOpsOptimizationAgent:
    """Bedrock Converse loop backing the product-facing **FinOps Agent** (unified chat)."""

    MAX_ROUNDS = 30

    def __init__(self, tools: list, system_prompt: str):
        self._tools      = {fn.__name__: fn for fn in tools}
        self._tool_specs = [_build_tool_spec(fn) for fn in tools]
        self._system     = [{'text': system_prompt}]
        self._model_id   = os.environ.get(
            'BEDROCK_MODEL_ID',
            'us.anthropic.claude-sonnet-4-5-20250929-v1:0',
        )
        self._region = os.environ.get('AWS_REGION', 'us-east-1')
        self._bedrock: Optional[Any] = None

    def _client(self):
        if self._bedrock is None:
            self._bedrock = boto3.client('bedrock-runtime', region_name=self._region)
        return self._bedrock

    def __call__(self, message: str, **kwargs) -> str:
        messages = [{'role': 'user', 'content': [{'text': message}]}]

        for round_num in range(self.MAX_ROUNDS):
            logger.info(f"[agent] round {round_num + 1}/{self.MAX_ROUNDS}")

            try:
                resp = self._client().converse(
                    modelId=    self._model_id,
                    system=     self._system,
                    messages=   messages,
                    toolConfig= {'tools': self._tool_specs},
                )
            except ClientError as e:
                code = e.response.get('Error', {}).get('Code', '')
                msg  = e.response.get('Error', {}).get('Message', str(e))
                logger.error(f"Bedrock Converse failed: {code} — {msg}")
                return f"Bedrock error ({code}): {msg}"

            output_msg  = resp['output']['message']
            stop_reason = resp['stopReason']
            messages.append(output_msg)

            if stop_reason == 'end_turn':
                return self._extract_text(output_msg)

            if stop_reason == 'tool_use':
                tool_results = self._run_tools(output_msg)
                if not tool_results:
                    return (
                        'Agent error: the model requested tools but no tool calls were recognized. '
                        'If this persists, check CloudWatch logs for the raw assistant message content.'
                    )
                messages.append({'role': 'user', 'content': tool_results})
                continue

            logger.warning(f"[agent] unexpected stopReason: {stop_reason}")
            return f"Analysis stopped: {stop_reason}"

        return "Optimization agent reached maximum analysis depth. Partial results may have been saved."

    def _extract_text(self, message: dict) -> str:
        texts = []
        for block in message.get('content', []):
            if isinstance(block, dict) and 'text' in block:
                texts.append(block['text'])
        return '\n'.join(texts) or '(no response)'

    def _run_tools(self, message: dict) -> list:
        """Bedrock Converse returns tool calls as content blocks with key `toolUse`, not `type: tool_use`."""
        results = []
        for block in message.get('content', []):
            if not isinstance(block, dict):
                continue

            tool_use = block.get('toolUse') or block.get('tool_use')
            if tool_use:
                tool_name  = tool_use['name']
                tool_id    = tool_use['toolUseId']
                tool_input = tool_use.get('input') or {}
            elif block.get('type') == 'tool_use':
                tool_name  = block['name']
                tool_id    = block['toolUseId']
                tool_input = block.get('input') or {}
            else:
                continue

            fn = self._tools.get(tool_name)
            if fn is None:
                logger.warning(f"[tools] unknown tool: {tool_name}")
                results.append({
                    'toolResult': {
                        'toolUseId': tool_id,
                        'content':   [{'text': f'Unknown tool: {tool_name}'}],
                        'status':    'error',
                    }
                })
                continue

            try:
                logger.info(f"[tools] calling {tool_name}({list(tool_input.keys())})")
                result = fn(**tool_input)
                payload = json.dumps(result, default=str) if not isinstance(result, str) else result
                if not payload:
                    payload = '(empty result)'
                results.append({
                    'toolResult': {
                        'toolUseId': tool_id,
                        'content':   [{'text': payload}],
                        'status':    'success',
                    }
                })
            except Exception as e:
                logger.exception(f"[tools] {tool_name} failed: {e}")
                results.append({
                    'toolResult': {
                        'toolUseId': tool_id,
                        'content':   [{'text': f'Tool {tool_name} error: {e}'}],
                        'status':    'error',
                    }
                })

        if not results:
            logger.error(
                '[tools] assistant returned tool_use but no toolUse blocks were parsed. '
                'Raw content: %s',
                message.get('content'),
            )

        return results


_agent: Optional[KostOpsOptimizationAgent] = None
_agent_lock = threading.Lock()


def _get_agent() -> KostOpsOptimizationAgent:
    global _agent
    if _agent is not None:
        return _agent
    with _agent_lock:
        if _agent is not None:
            return _agent
        logger.info(f"[lazy] importing tools at {_elapsed()}")
        from tools.billing_tools import (
            get_today_date,
            get_cost_and_usage,
            get_cost_forecast,
            get_cost_comparison,
            get_anomalies,
            describe_anomaly_monitors,
            get_dimension_values,
            get_tag_values,
            get_budget_list,
            get_budget_performance,
            get_cost_optimization_hub_recommendations,
            get_rightsizing_recommendations,
            get_savings_plans_purchase_recommendation,
        )
        from tools.optimization_tools import (
            get_reservation_utilization,
            get_reservation_coverage,
            get_reservation_purchase_recommendations,
            get_savings_plans_utilization,
            get_savings_plans_coverage,
            get_coh_recommendations_by_service,
            get_coh_recommendation_detail,
            get_data_transfer_costs,
            compute_opportunity_score,
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
            save_enriched_finding,
            list_findings,
            list_findings_by_type,
            get_finding,
            update_finding_score,
        )

        # Visibility + optimization: one agent, full tool surface for chat.
        _agent = KostOpsOptimizationAgent(
            tools=[
                get_today_date,
                get_cost_and_usage,
                get_cost_forecast,
                get_cost_comparison,
                get_anomalies,
                describe_anomaly_monitors,
                get_dimension_values,
                get_tag_values,
                get_budget_list,
                get_budget_performance,
                get_cost_optimization_hub_recommendations,
                get_rightsizing_recommendations,
                get_savings_plans_purchase_recommendation,
                get_savings_plans_utilization,
                get_savings_plans_coverage,
                get_reservation_utilization,
                get_reservation_coverage,
                get_reservation_purchase_recommendations,
                get_coh_recommendations_by_service,
                get_coh_recommendation_detail,
                get_spend_by_service,
                get_spend_by_account,
                get_spend_last_13_months,
                get_daily_spend_trend,
                get_top_cost_drivers,
                get_data_transfer_costs,
                list_unattached_ebs_volumes,
                list_old_snapshots,
                list_nonprod_instances,
                list_findings,
                list_findings_by_type,
                get_finding,
                save_finding,
                save_enriched_finding,
                update_finding_score,
                compute_opportunity_score,
            ],
            system_prompt=SYSTEM_PROMPT,
        )
        logger.info(f"[lazy] agent ready at {_elapsed()}")
        return _agent
