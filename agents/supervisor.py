"""
agents/supervisor.py
--------------------
Supervisor — classifies intent, enforces role, and dispatches to specialists.

For MVP the supervisor has ONE specialist registered (Visibility). Keeping
the dispatch layer in place now pays off in Phase 1+ when Budget Agent,
Optimization Agent, and Analytics Agent land — they plug in as additional
entries in the SPECIALISTS table and the dispatcher becomes smarter without
touching the HTTP entrypoint.

Design rules for the supervisor:

  1. ROLE GATE BEFORE DISPATCH. If the classified intent is a mutation and
     the caller is not `admin`, short-circuit with a read-only response.
     Write tools never run for viewers, ever.
  2. NO DIRECT MUTATIONS. The supervisor itself never calls boto3/DynamoDB.
     Specialist write tools POST to the KostOps API with the caller's JWT
     so the API authorizer re-validates role and the mutation emits a
     `source=CHAT` audit row.
  3. DEFAULT TO VISIBILITY. When intent is ambiguous, prefer the read-only
     specialist. Over-triggering a write specialist is worse than missing a
     nuanced question.

The MVP classifier is intentionally trivial — a literal default to Visibility.
Phase 1 will wire in a Claude Haiku keyword rubric once Budget Agent lands
and we have >1 valid target.
"""

from __future__ import annotations

import logging
from typing import Callable, Dict, Optional

from . import visibility

logger = logging.getLogger(__name__)


# Specialist registry. Each entry is callable(message, ctx) -> str.
# `write` indicates the specialist includes mutation tools and therefore
# requires the caller to hold the `admin` Cognito group.
SPECIALISTS: Dict[str, Dict] = {
    'visibility': {
        'handler': visibility.handle,
        'write':   False,
    },
    # 'budget':       {'handler': budget.handle,       'write': True},   # Phase 1
    # 'optimization': {'handler': optimization.handle, 'write': False},  # Phase 4
    # 'analytics':    {'handler': analytics.handle,    'write': True},   # Phase 5
}


def classify(message: str, ctx: dict | None = None) -> str:
    """
    Decide which specialist to dispatch to.

    MVP: always return 'visibility'. Phase 1 will replace this with a
    Haiku-based intent classifier once multiple specialists exist.
    """
    return 'visibility'


def is_admin(ctx: dict | None) -> bool:
    """Return True iff the caller is in the `admin` Cognito group."""
    if not ctx:
        return False
    groups = ctx.get('groups') or []
    if isinstance(groups, str):
        # Cognito sometimes serialises as "admin viewer" or "[admin viewer]"
        cleaned = groups.strip('[]')
        groups  = [g.strip() for g in cleaned.replace(',', ' ').split() if g.strip()]
    return 'admin' in set(groups)


def dispatch(message: str, ctx: dict | None = None) -> str:
    """
    Entry point for the HTTP layer. `ctx` may carry:
      - claims: full Cognito JWT claims dict
      - groups: list[str] of Cognito group names
      - sub:    caller's Cognito sub
      - token:  caller's raw ID token (for write tools to pass through)
      - page:   {'path': ..., 'scopeId': ...} — optional UI context

    Invariants:
      - Specialist name is looked up in SPECIALISTS; unknown → visibility.
      - Mutation specialists are gated on `admin` membership here; they are
        also gated at the API authorizer. Both checks must pass.
    """
    if message and message.strip() == '__ping__':
        return 'pong'

    ctx = ctx or {}
    intent = classify(message, ctx)
    spec   = SPECIALISTS.get(intent) or SPECIALISTS['visibility']

    if spec.get('write') and not is_admin(ctx):
        logger.info(f"supervisor | deny write intent={intent} sub={ctx.get('sub', '')[:8]}")
        return (
            "That request would change data, which requires an admin role. "
            "I can still answer read-only questions — ask me about spend, "
            "findings, or forecasts, or ping an admin to make the change."
        )

    handler: Callable = spec['handler']
    try:
        return handler(message, ctx)
    except TypeError:
        # Backwards-compat: specialists that don't accept ctx yet
        return handler(message)
