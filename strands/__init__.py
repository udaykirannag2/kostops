"""
strands/__init__.py — lightweight stub
--------------------------------------
The real `strands-agents` package is NOT installed in the AgentCore Runtime zip.
Removing it eliminates pydantic_core (4.1 MB Rust), yaml/_yaml (2.6 MB Rust),
and rpds (1.0 MB Rust) — saving ~8 MB of cold-start extension loading.

This stub provides the `@tool` decorator as a no-op so tool files need no changes.
The actual agent loop is implemented with boto3.converse() in visibility_agent.py.
"""


def tool(fn=None, **kwargs):
    """
    No-op @tool decorator.

    The real strands @tool registers metadata for the Strands agent loop.
    Here it's a pass-through — tool metadata is extracted from type annotations
    and docstrings by the KostOpsAgent in visibility_agent.py instead.

    Usage in tool files (unchanged):
        @tool
        def my_tool(param: str) -> str:
            ...

        @tool(name="override_name")
        def my_tool(param: str) -> str:
            ...
    """
    if fn is not None:
        # Used as @tool (no arguments)
        return fn
    # Used as @tool(...) — return the decorator
    return lambda f: f


class Agent:
    """Stub — not used. See KostOpsAgent in visibility_agent.py."""
    pass
