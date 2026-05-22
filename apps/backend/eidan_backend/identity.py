"""Identity — post-validation identity record + ambient task-local state.

The bearer-token middleware (``http/auth.py``) decodes the RS256 JWT
against the host's cached public key (`docs/011 §11`), constructs an
:class:`Identity` from the claims, and pins it on
``request.state.identity``. Downstream code (loop, persistence, tools)
reads the identity from there; agent tools that don't see the request
object pull it via :func:`get_current_identity` from the ambient
:data:`current_identity` ``ContextVar``.
"""

from __future__ import annotations

from contextvars import ContextVar
from dataclasses import dataclass
from typing import Any
from uuid import UUID


class AuthError(Exception):
    """Raised on auth failure. The ``code`` belongs to the closed set in
    ``docs/011 §10.2`` and drives the 401/403 envelope via
    :func:`http.errors.auth_error_response`.
    """

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


@dataclass(frozen=True, slots=True)
class Identity:
    """The post-validation identity record carried through a turn."""

    user_id: str
    email: str | None
    session_id: str | None
    aal: str
    raw_claims: dict[str, Any]

    @classmethod
    def synthetic_for_agent(
        cls,
        user_id: str,
        *,
        agent_name: str,
        email: str | None = None,
    ) -> Identity:
        """Build a synthetic identity for an agent-initiated turn.

        Used by the cron/schedule path (`docs/005 §10` background-only
        turns) and the sentry plugin when it spawns a turn against a
        known user without an inbound JWT. The shape matches a
        JWT-validated identity so the rest of the loop — RLS session
        variables, tool handlers reading current_identity — stays
        unchanged.

        ``aal`` is fixed to ``'agent'`` so a route handler that wants
        to know "is this a real user request or an agent-initiated
        one?" can read ``identity.aal == 'agent'``. ``raw_claims``
        carries ``synthetic = True`` and the calling agent's name so
        audit queries can filter by it.
        """
        return cls(
            user_id=user_id,
            email=email,
            session_id=None,
            aal="agent",
            raw_claims={
                "synthetic": True,
                "agent_name": agent_name,
                "sub": user_id,
            },
        )


# Ambient identity for the current async task. The agent loop sets this
# before invoking a registered tool so the tool's handler can read the
# acting user's identity without an extra parameter on every signature.
# Plugins that own tools read it via :func:`get_current_identity`; the
# loop sets it via ``current_identity.set(identity)`` paired with a
# matching ``reset`` in a try/finally.
#
# Why a contextvar rather than threading identity through every API:
# tool handler signatures (``async def(payload: dict) -> str``) are the
# wire shape a model speaks to. Bolting identity onto every handler
# would force every plugin author to accept it. The contextvar keeps
# the wire surface stable while routing identity end-to-end.
current_identity: ContextVar[Identity | None] = ContextVar(
    "eidan.current_identity", default=None
)


def get_current_identity() -> Identity | None:
    """Read the ambient identity for the current task. ``None`` outside
    a turn (e.g. during plugin install, or in tests that didn't set it)."""
    return current_identity.get()


# Ambient agent_context.id for the current turn — set by the loop right
# after it resolves the user's active agent_context row, alongside
# ``current_identity``. Tool handlers (e.g. the capture plugin's `note`,
# which needs a non-null ``agent_id`` for the row) read it without
# changing the handler's wire signature. Same single-task semantics as
# ``current_identity``: a fresh turn's ``set()`` shadows any prior value.
current_agent_id: ContextVar[UUID | None] = ContextVar(
    "eidan.current_agent_id", default=None
)


def get_current_agent_id() -> UUID | None:
    """Read the ambient agent_context.id for the current task.

    ``None`` outside a turn (e.g. during plugin install). Plugin tools
    that require it should raise a typed error rather than fall back to
    a sentinel write.
    """
    return current_agent_id.get()
