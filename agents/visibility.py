"""
agents/visibility.py
--------------------
The Visibility Agent — read-only spend / forecast / findings Q&A.

This is the Strands-style agent that shipped as KostOps' original
`visibility_agent.py` entrypoint. The entrypoint itself is now
`agent_entrypoint.py`, which delegates to the supervisor, which delegates
here. Behaviour for end users is unchanged: same system prompt, same tool
list, same model.

Phase 0 keeps this migration purely structural — no tool additions, no
prompt changes — so the first deploy of the supervisor can be verified by
running the same questions users already ask today.
"""

from __future__ import annotations

import logging

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

from ._common import SpecialistAgent

logger = logging.getLogger(__name__)

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


TOOLS = [
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
]


agent = SpecialistAgent(
    name          = 'visibility',
    system_prompt = SYSTEM_PROMPT,
    tools         = TOOLS,
)


def handle(message: str, ctx: dict | None = None) -> str:
    """Supervisor-facing entrypoint. `ctx` reserved for future per-turn context."""
    return agent.handle(message)
