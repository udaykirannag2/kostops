"""
KostOps FinOps Agent — stub entry for the bundle layout (cold start split).

- optimization_runtime.py     → AgentCore `entryPoint` (minimal; /ping fast).
- optimization_agent_core.py  → FinOps Agent: Bedrock + tools (imported on first /invocations).

Do not import this file name from runtime; it is documentation-only in the bundle.
"""

# Intentionally empty — avoids pulling heavy dependencies if something imports
# `optimization_agent` during startup.
