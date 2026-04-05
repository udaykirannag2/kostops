"""
KostOps Visibility Agent
------------------------
Built with AWS Strands Agents SDK.
Deployed on Amazon Bedrock AgentCore Runtime.

Two credential contexts:
  LINKED account (agent's own IAM role):
    - Athena / CUR queries
    - EC2 resource discovery
    - DynamoDB findings
    - CloudWatch MCP server

  PAYER account (assumed via sts:AssumeRole → kostops-cross-account-role):
    - Billing MCP server (Cost Explorer, Compute Optimizer, Budgets)
    - All consolidated billing data only exists in payer

MCP servers wired via AgentCore Gateway (agents/mcp/agent_mcp_config.json):
  billing     → payer credentials injected at startup via payer_role.py
  cloudwatch  → linked account credentials (inherited)
  aws-knowledge → public remote, no credentials
"""

import os
import logging
from strands import Agent
from strands.models import BedrockModel
from bedrock_agentcore import BedrockAgentCoreApp

from tools.payer_role import get_payer_credentials, is_configured as payer_configured
from tools.athena_tools import (
    get_spend_by_service,
    get_spend_by_account,
    get_spend_by_tag,
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

logger = logging.getLogger(__name__)

# ── Inject payer credentials into billing MCP server environment ──────────────
# The billing MCP server subprocess must run with payer account credentials
# so Cost Explorer returns consolidated org-wide data rather than linked account only.
if payer_configured():
    try:
        payer_creds = get_payer_credentials()
        # AgentCore Gateway reads these env vars and passes them to the billing MCP server
        os.environ['KOSTOPS_BILLING_MCP_AWS_ACCESS_KEY_ID']     = payer_creds['AWS_ACCESS_KEY_ID']
        os.environ['KOSTOPS_BILLING_MCP_AWS_SECRET_ACCESS_KEY'] = payer_creds['AWS_SECRET_ACCESS_KEY']
        os.environ['KOSTOPS_BILLING_MCP_AWS_SESSION_TOKEN']      = payer_creds['AWS_SESSION_TOKEN']
        logger.info("Payer account credentials injected for billing MCP server")
    except Exception as e:
        logger.warning(f"Could not assume payer role: {e}. Cost Explorer will use linked account.")
else:
    logger.warning(
        "PAYER_CROSS_ACCOUNT_ROLE not set. "
        "Billing MCP server will use linked account credentials. "
        "Cost Explorer data will be limited to this account only."
    )

# ── Model ─────────────────────────────────────────────────────────────────────
model = BedrockModel(
    model_id=os.environ.get("BEDROCK_MODEL_ID", "anthropic.claude-3-5-sonnet-20241022-v2:0"),
    region_name=os.environ.get("AWS_REGION", "us-east-1"),
)

# ── System Prompt ─────────────────────────────────────────────────────────────
SYSTEM_PROMPT = """
You are KostOps — an AWS cost visibility and optimization agent.

ACCOUNT CONTEXT:
- You run in a LINKED account inside an AWS Organization
- Billing data (Cost Explorer, Compute Optimizer, Budgets) comes from the PAYER account via cross-account role
- Resource data (EC2, CloudWatch) comes from this LINKED account
- CUR/Athena data comes from a replicated bucket in this linked account (kostops-cur-<account-id>)

TOOL CATEGORIES:

1. AWS MCP Server tools — injected by AgentCore Gateway with PAYER credentials:
   get_cost_and_usage, get_cost_forecast, get_cost_comparison
   get_anomalies, describe_anomaly_monitors
   get_rightsizing_recommendations
   get_savings_plans_purchase_recommendation
   get_budget_list, get_budget_performance
   get_cost_optimization_hub_recommendations

2. AWS MCP Server tools — CloudWatch with LINKED account credentials:
   get_metric_data, get_metric_statistics, list_metrics, describe_alarms

3. Custom KostOps tools — CUR/Athena (replicated payer data, linked account):
   get_spend_by_service, get_spend_by_account, get_spend_by_tag
   get_daily_spend_trend, get_top_cost_drivers

4. Custom KostOps tools — EC2 resource discovery (linked account):
   list_unattached_ebs_volumes, list_old_snapshots, list_nonprod_instances

5. Custom KostOps tools — Findings persistence:
   save_finding, list_findings, get_finding

RULES:
- Never invent numbers — every figure must come from a tool call
- Cost Explorer API costs $0.01/call — batch queries, never repeat identical calls within a session
- Always save new findings via save_finding so they appear in the React UI
- Keep answers concise — engineers want facts and numbers

WORKFLOWS:
"Why did costs go up?"
  1. get_cost_comparison (spike period vs prior)
  2. get_anomalies (same period)
  3. get_daily_spend_trend from Athena (daily granularity from CUR)
  4. Return 3-sentence summary with actual dollar amounts

"What should I fix this week?"
  1. list_findings (OPEN) — show cached first
  2. get_cost_optimization_hub_recommendations
  3. get_rightsizing_recommendations
  4. list_unattached_ebs_volumes + list_old_snapshots
  5. Rank by savings, save new findings, return top 5
"""

# ── Agent — custom tools only ─────────────────────────────────────────────────
# AWS MCP server tools (billing, cloudwatch, knowledge) are injected
# automatically by AgentCore Gateway at runtime via agent_mcp_config.json
agent = Agent(
    model=model,
    system_prompt=SYSTEM_PROMPT,
    tools=[
        get_spend_by_service,
        get_spend_by_account,
        get_spend_by_tag,
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

# ── AgentCore Runtime wrapper ─────────────────────────────────────────────────
app = BedrockAgentCoreApp(
    agent=agent,
    mcp_config_path=os.path.join(os.path.dirname(__file__), "mcp", "agent_mcp_config.json"),
)

if __name__ == "__main__":
    print("KostOps running locally. Type 'exit' to quit.\n")
    if not payer_configured():
        print("WARNING: Payer role not configured — Cost Explorer data will be limited.\n")
    while True:
        user_input = input("You: ").strip()
        if user_input.lower() in ("exit", "quit"):
            break
        response = agent(user_input)
        print(f"\nKostOps: {response}\n")
