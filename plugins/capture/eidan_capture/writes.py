"""Write helpers for the `capture` tools.

Each function takes an asyncpg connection + the typed inputs the tool
guarantees, runs the INSERT, and returns the row's id so the tool
handler can echo it back to the model.

The `eidan.notes` table requires `agent_id NOT NULL` (`docs/003 §6` —
"every note has an author"). The agent loop now provisions the
operator's default agent_context row at the start of every turn and
publishes its id via the ``current_agent_id`` contextvar, so the
plugin reads the id off the contextvar rather than upserting its own
sentinel row.
"""

from __future__ import annotations

from typing import Any
from uuid import UUID


async def insert_knowledge(
    conn: Any,
    *,
    user_id: UUID,
    skill: str,
    title: str,
    body: str,
    source: str | None = None,
    source_type: str | None = None,
) -> UUID:
    """Curated entry → ``eidan.knowledge``.

    Conflicts on ``(user_id, skill, title)`` UPDATE the existing
    row's body / source so the same caller can re-assert without
    erroring. ``source_type`` falls through the check constraint —
    we accept ``manual`` (the default), ``chat``, ``url``, ``file``,
    ``imported``.
    """
    row = await conn.fetchrow(
        """
        INSERT INTO eidan.knowledge
            (user_id, skill, title, body, source, source_type)
        VALUES
            ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (user_id, skill, title) WHERE deleted_at IS NULL
        DO UPDATE
            SET body = EXCLUDED.body,
                source = EXCLUDED.source,
                source_type = EXCLUDED.source_type
        RETURNING id
        """,
        user_id,
        skill,
        title,
        body,
        source,
        source_type or "manual",
    )
    assert row is not None
    return row["id"]


async def insert_note(
    conn: Any,
    *,
    user_id: UUID,
    agent_id: UUID,
    content: str,
    conversation_id: UUID | None = None,
) -> UUID:
    """Working memory → ``eidan.notes``."""
    row = await conn.fetchrow(
        """
        INSERT INTO eidan.notes
            (user_id, agent_id, conversation_id, content)
        VALUES
            ($1, $2, $3, $4)
        RETURNING id
        """,
        user_id,
        agent_id,
        conversation_id,
        content,
    )
    assert row is not None
    return row["id"]


async def insert_event(
    conn: Any,
    *,
    user_id: UUID,
    type_: str,
    title: str,
    due_at_iso: str | None = None,
    occurred_at_iso: str | None = None,
    body: str | None = None,
    duration_seconds: int | None = None,
) -> UUID:
    """Calendar-like item → ``eidan.events``.

    The ``events_time_chk`` constraint forbids rows with neither
    ``due_at`` nor ``occurred_at`` — the tool handler enforces this
    before calling. ISO 8601 strings come in from the model; asyncpg
    parses them to ``timestamptz``.
    """
    row = await conn.fetchrow(
        """
        INSERT INTO eidan.events
            (user_id, type, title, body,
             due_at, occurred_at, duration_s)
        VALUES
            ($1, $2, $3, $4,
             $5::timestamptz, $6::timestamptz, $7)
        RETURNING id
        """,
        user_id,
        type_,
        title,
        body,
        due_at_iso,
        occurred_at_iso,
        duration_seconds,
    )
    assert row is not None
    return row["id"]
