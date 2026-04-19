"""
agents — supervisor + specialist agents for KostOps

At MVP there is one AgentCore Runtime with a Python-level supervisor that
dispatches to one of four specialists:

  visibility    — read-only spend / forecast / findings Q&A (migrated from
                  the original visibility_agent.py entrypoint).
  budget        — (Phase 1+) scopes, budgets, forecasts, CSV I/O, allocation,
                  variance analysis.
  optimization  — (Phase 4) rightsizing, SP/RI, anomalies, waste.
  analytics     — (Phase 5) report + dashboard definitions, schedules, alerts,
                  chat-authored dashboards.

Later, each specialist can be lifted into its own AgentCore Runtime with no
changes inside the specialist module — the supervisor switches from local
function calls to `bedrock-agentcore:InvokeAgentRuntime`.

See ARCHITECTURE.md §11 and the plan file for the full rollout.
"""
