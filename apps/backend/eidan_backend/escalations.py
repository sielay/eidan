"""Escalation envelope — `docs/022 §3`.

Phase 1 implementation of the structured "I'm blocked" primitive an
agent / behaviour / loop step can emit when it can't make further
progress without help. Distinct from failure detection (`docs/009`):

- ``009`` decides "the primary's output is suspect, fire the critic"
  from observed signals — the audience is the loop itself.
- ``022`` decides "the agent has identified a blocker it can't resolve"
  from agent-emitted intent — the audience is upstream (operator, UI,
  future routing agent).

The wire shape mirrors §3's minimum-viable envelope; the
:func:`record_escalation` helper writes one row to ``eidan.escalations``
(see ``migrations/.../init_escalations.py``). Listing pending rows is
the UI's job via ``GET /api/escalations`` (added in
:mod:`eidan_backend.http.routes`).

Auto-resolution / severity inference / cross-instance routing stay
out of scope per §4 — the operator (or a future agent) drives the
status lifecycle by hand for now.
"""

from __future__ import annotations

import json
from collections.abc import Iterable
from dataclasses import dataclass, field
from datetime import datetime
from enum import StrEnum
from typing import TYPE_CHECKING, Any
from uuid import UUID, uuid4

if TYPE_CHECKING:
    import asyncpg


class EscalationSeverity(StrEnum):
    """Severity tier from `docs/022 §1`.

    ``LOW`` queues for the notification surface; ``MEDIUM`` interrupts
    the next turn; ``HIGH`` pages the operator out-of-band. The
    emitting agent picks the tier — we do not infer it post-hoc.
    """

    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"


class EscalationReason(StrEnum):
    """Closed-set reason class from `docs/022 §1`.

    Keeping the list short forces escalations to map onto a known
    shape rather than free text; the UI can group by reason for
    triage at a glance.
    """

    MISSING_INPUT = "missing_input"
    PERMISSION_DENIED = "permission_denied"
    EXTERNAL_FAILURE = "external_failure"
    AMBIGUOUS_INTENT = "ambiguous_intent"
    OVER_BUDGET = "over_budget"
    OVER_CAPACITY = "over_capacity"
    UNRECOVERABLE_ERROR = "unrecoverable_error"
    OTHER = "other"


@dataclass(frozen=True, slots=True)
class Escalation:
    """The §3 envelope. Persisted into ``eidan.escalations`` verbatim.

    ``evidence`` is a list of opaque references — message ids,
    llm_call ids, external trace ids — that an operator can pull on
    to understand the blocker without re-asking. The list is
    JSON-serialised on the wire; no schema enforcement on its
    contents beyond "must be a list of strings."
    """

    severity: EscalationSeverity
    reason_class: EscalationReason
    user_id: UUID
    suggested_action: str | None = None
    evidence: tuple[str, ...] = ()
    conversation_id: UUID | None = None
    agent_id: UUID | None = None
    metadata: dict[str, Any] = field(default_factory=dict)


async def record_escalation(
    conn: asyncpg.Connection,
    *,
    escalation: Escalation,
) -> UUID:
    """Write one escalation row and return its id.

    The row lands with ``status='pending'``; the operator UI / a
    future agent advances it to ``acknowledged`` / ``resolved``.
    """
    row_id = uuid4()
    await conn.execute(
        """
        INSERT INTO eidan.escalations
            (id, user_id, conversation_id, agent_id,
             severity, reason_class, suggested_action,
             evidence, metadata)
        VALUES
            ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb)
        """,
        row_id,
        escalation.user_id,
        escalation.conversation_id,
        escalation.agent_id,
        escalation.severity.value,
        escalation.reason_class.value,
        escalation.suggested_action,
        json.dumps(list(escalation.evidence)),
        json.dumps(escalation.metadata or {}),
    )
    return row_id


@dataclass(frozen=True, slots=True)
class EscalationRow:
    """The shape returned by :func:`list_escalations`. Mirrors the
    DB row 1:1 — the UI / API surface formats from this."""

    id: UUID
    user_id: UUID
    conversation_id: UUID | None
    agent_id: UUID | None
    severity: str
    reason_class: str
    suggested_action: str | None
    evidence: list[str]
    metadata: dict[str, Any]
    status: str
    created_at: datetime
    updated_at: datetime
    resolved_at: datetime | None


async def list_escalations(
    conn: asyncpg.Connection,
    *,
    user_id: UUID,
    status: str | None = "pending",
    limit: int = 50,
) -> list[EscalationRow]:
    """List a user's escalations.

    Defaults to ``status='pending'`` so the UI's escalation list
    matches the partial index. Pass ``status=None`` for all rows
    (operator-side audit), or any of the three lifecycle states.
    """
    if status is None:
        rows: Iterable[Any] = await conn.fetch(
            """
            SELECT id, user_id, conversation_id, agent_id,
                   severity, reason_class, suggested_action,
                   evidence, metadata, status,
                   created_at, updated_at, resolved_at
            FROM eidan.escalations
            WHERE user_id = $1
            ORDER BY created_at DESC
            LIMIT $2
            """,
            user_id,
            limit,
        )
    else:
        rows = await conn.fetch(
            """
            SELECT id, user_id, conversation_id, agent_id,
                   severity, reason_class, suggested_action,
                   evidence, metadata, status,
                   created_at, updated_at, resolved_at
            FROM eidan.escalations
            WHERE user_id = $1 AND status = $2
            ORDER BY created_at DESC
            LIMIT $3
            """,
            user_id,
            status,
            limit,
        )
    return [_row_to_envelope(row) for row in rows]


def _row_to_envelope(row: Any) -> EscalationRow:
    evidence = row["evidence"]
    metadata = row["metadata"]
    if isinstance(evidence, str):
        try:
            evidence = json.loads(evidence)
        except (ValueError, TypeError):
            evidence = []
    if isinstance(metadata, str):
        try:
            metadata = json.loads(metadata)
        except (ValueError, TypeError):
            metadata = {}
    return EscalationRow(
        id=row["id"],
        user_id=row["user_id"],
        conversation_id=row["conversation_id"],
        agent_id=row["agent_id"],
        severity=row["severity"],
        reason_class=row["reason_class"],
        suggested_action=row["suggested_action"],
        evidence=list(evidence) if isinstance(evidence, list) else [],
        metadata=dict(metadata) if isinstance(metadata, dict) else {},
        status=row["status"],
        created_at=row["created_at"],
        updated_at=row["updated_at"],
        resolved_at=row["resolved_at"],
    )


async def acknowledge_escalation(
    conn: asyncpg.Connection,
    *,
    escalation_id: UUID,
    user_id: UUID,
) -> bool:
    """Move ``pending`` → ``acknowledged``. Returns True if the row
    moved; False if it didn't exist, was already acknowledged, or
    belonged to another user."""
    result = await conn.execute(
        """
        UPDATE eidan.escalations
        SET status = 'acknowledged',
            updated_at = CURRENT_TIMESTAMP
        WHERE id = $1
          AND user_id = $2
          AND status = 'pending'
        """,
        escalation_id,
        user_id,
    )
    return result.endswith(" 1")


async def resolve_escalation(
    conn: asyncpg.Connection,
    *,
    escalation_id: UUID,
    user_id: UUID,
) -> bool:
    """Move row to ``resolved``. Idempotent: re-resolving a resolved
    row is a no-op that still returns True."""
    result = await conn.execute(
        """
        UPDATE eidan.escalations
        SET status = 'resolved',
            updated_at = CURRENT_TIMESTAMP,
            resolved_at = COALESCE(resolved_at, CURRENT_TIMESTAMP)
        WHERE id = $1
          AND user_id = $2
        """,
        escalation_id,
        user_id,
    )
    return result.endswith(" 1")


__all__ = [
    "Escalation",
    "EscalationReason",
    "EscalationRow",
    "EscalationSeverity",
    "acknowledge_escalation",
    "list_escalations",
    "record_escalation",
    "resolve_escalation",
]
