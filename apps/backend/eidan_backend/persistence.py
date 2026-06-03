"""Persistence helpers — the writes the agent loop performs on every turn.

Per docs/005 §1.1 every user message, every assistant turn, and every
`llm_calls` row is persisted *before* the result is forwarded to the
next step ("eager persistence"). This module wraps those writes so the
loop reads as a linear sequence and the SQL stays in one place.

Phase 1 ships only the writes the minimal loop needs (no tool turns, no
critic, no subagent attribution).
"""

from __future__ import annotations

import dataclasses
import json
import os
from datetime import UTC, datetime
from typing import Any
from uuid import UUID, uuid4

import asyncpg

from .providers.base import ProviderCallResult, ToolResultBlock, ToolUseBlock

# Default agent slug used by the loop to provision a per-user agent_context
# row on first turn. Matches what plugins look up when they need the
# operator's primary agent (e.g. capture's `note` tool, which requires a
# non-null agent_id on the row).
DEFAULT_AGENT_SLUG = "default"
_DEFAULT_AGENT_DISPLAY_NAME = "Eidan"
_DEFAULT_AGENT_DESCRIPTION = (
    "Default agent. Edit user_overrides.system_prompt to set a persona; "
    "the hardcoded baseline identity (EIDAN_BASE_IDENTITY) always renders "
    "first regardless."
)


def _ensure_aware_utc(value: datetime) -> datetime:
    """Treat a naive datetime as UTC. Aware values pass through unchanged.

    Plugin code may build timestamps with ``datetime.utcnow()`` (naive)
    or ``datetime.now(UTC)`` (aware). Mixing the two raises
    ``TypeError`` on subtraction, so callers that compute durations
    coerce inputs through this helper first.
    """
    if value.tzinfo is None:
        return value.replace(tzinfo=UTC)
    return value


def decode_jsonb(value: Any) -> dict[str, Any]:
    """Normalise a jsonb column read.

    asyncpg returns jsonb as ``str`` by default (no codec is registered on
    the pool, see ``db.create_pool``). Handle both the string-on-the-wire
    case and the already-decoded case so this helper is robust to a future
    codec install.
    """
    if value is None:
        return {}
    if isinstance(value, str):
        decoded = json.loads(value)
        return decoded if isinstance(decoded, dict) else {}
    if isinstance(value, dict):
        return value
    return {}


async def upsert_user(
    conn: asyncpg.Connection,
    *,
    user_id: UUID,
    email: str | None,
) -> None:
    """Idempotent insert keyed on the JWT ``sub`` claim (eidan.users.id).

    Called on first sight of a JWT. The trigger keeps updated_at honest
    on subsequent re-asserts (e.g. an email change at the auth surface).
    """
    await conn.execute(
        """
        INSERT INTO eidan.users (id, email)
        VALUES ($1, $2)
        ON CONFLICT (id) DO UPDATE
            SET email = EXCLUDED.email
            WHERE eidan.users.email IS DISTINCT FROM EXCLUDED.email
        """,
        user_id,
        email,
    )


async def ensure_default_agent_context(
    conn: asyncpg.Connection,
    *,
    user_id: UUID,
    agent_slug: str = DEFAULT_AGENT_SLUG,
) -> tuple[UUID, str | None]:
    """Idempotent upsert + read of the user's per-slug agent_context row.

    Returns ``(agent_id, persona_prompt)``. The persona prompt is the
    effective ``user_overrides.system_prompt → code_defaults.system_prompt
    → None`` fallback chain — the operator-customisable persona layer
    only. The immutable baseline identity
    (``turn_header.EIDAN_BASE_IDENTITY``) is composed separately by the
    loop and is not derivable from this row.

    Uses INSERT ... ON CONFLICT DO NOTHING + a follow-up SELECT inside the
    same transaction so the BEFORE UPDATE trigger on ``updated_at`` does
    not fire on every turn (a plain ``ON CONFLICT DO UPDATE`` would churn
    the column even with a no-op SET clause).
    """
    await conn.execute(
        """
        INSERT INTO eidan.agent_context
            (user_id, agent_slug, display_name, description,
             code_defaults, user_overrides)
        VALUES
            ($1, $2, $3, $4, '{}'::jsonb, '{}'::jsonb)
        ON CONFLICT (user_id, agent_slug) DO NOTHING
        """,
        user_id,
        agent_slug,
        _DEFAULT_AGENT_DISPLAY_NAME,
        _DEFAULT_AGENT_DESCRIPTION,
    )
    row = await conn.fetchrow(
        """
        SELECT id, code_defaults, user_overrides
        FROM eidan.agent_context
        WHERE user_id = $1 AND agent_slug = $2
        """,
        user_id,
        agent_slug,
    )
    assert row is not None, (
        "ensure_default_agent_context: row missing after upsert"
    )
    code_defaults = decode_jsonb(row["code_defaults"])
    user_overrides = decode_jsonb(row["user_overrides"])
    persona = (
        user_overrides.get("system_prompt")
        or code_defaults.get("system_prompt")
        or None
    )
    return row["id"], persona


async def create_conversation(
    conn: asyncpg.Connection,
    *,
    user_id: UUID,
    title: str | None = None,
) -> UUID:
    row = await conn.fetchrow(
        """
        INSERT INTO eidan.conversations (user_id, title)
        VALUES ($1, $2)
        RETURNING id
        """,
        user_id,
        title,
    )
    assert row is not None
    return row["id"]


async def insert_user_message(
    conn: asyncpg.Connection,
    *,
    user_id: UUID,
    conversation_id: UUID,
    content: str,
    agent_id: UUID | None = None,
    metadata: dict | None = None,
) -> UUID:
    """Eager-save the inbound user message before the provider call.

    ``metadata`` carries per-message context the loop needs at replay
    time. Issue #51 stamps ``sent_at_utc`` and ``user_tz`` here so a
    later replay reconstructs the same TZ header the model originally
    saw. ``agent_id`` stamps the active agent_context for the turn so
    later analytics can attribute the turn to the persona that handled
    it; ``None`` is permitted (column is nullable) for legacy callers.
    """
    message_id = uuid4()
    metadata_json = json.dumps(metadata or {})
    # ``agent_id`` is the LAST positional arg so existing tests that
    # inspect ``args[i]`` by position remain stable. Same convention
    # holds in ``insert_assistant_message`` / ``insert_tool_message``
    # / ``insert_llm_call``.
    await conn.execute(
        """
        INSERT INTO eidan.messages
            (id, user_id, conversation_id, role, content, metadata, agent_id)
        VALUES
            ($1, $2, $3, 'user', $4, $5::jsonb, $6)
        """,
        message_id,
        user_id,
        conversation_id,
        content,
        metadata_json,
        agent_id,
    )
    return message_id


async def insert_assistant_message(
    conn: asyncpg.Connection,
    *,
    user_id: UUID,
    conversation_id: UUID,
    parent_message_id: UUID | None,
    content: str,
    provider: str,
    model: str,
    agent_id: UUID | None = None,
    tool_calls: tuple[ToolUseBlock, ...] = (),
    metadata: dict | None = None,
) -> UUID:
    """Eager-save the assistant turn once the stream completes.

    ``tool_calls`` is the structured block list per `docs/003 §3` —
    persisted as JSON alongside the text content so replay can
    reconstruct the multi-block turn shape. ``metadata`` carries
    out-of-band markers (`critic`, `failure`, ...) the loop wants to
    attach to the row at write time. ``agent_id`` is the
    agent_context.id this turn was handled by.
    """
    message_id = uuid4()
    tool_calls_json = json.dumps(
        [
            {"id": t.id, "name": t.name, "input": t.input}
            for t in tool_calls
        ]
    )
    metadata_json = json.dumps(metadata or {})
    await conn.execute(
        """
        INSERT INTO eidan.messages
            (id, user_id, conversation_id, parent_message_id,
             role, content, tool_calls, provider, model, metadata,
             agent_id)
        VALUES
            ($1, $2, $3, $4, 'assistant', $5, $6::jsonb, $7, $8, $9::jsonb, $10)
        """,
        message_id,
        user_id,
        conversation_id,
        parent_message_id,
        content,
        tool_calls_json,
        provider,
        model,
        metadata_json,
        agent_id,
    )
    return message_id


async def update_message_metadata(
    conn: asyncpg.Connection,
    *,
    message_id: UUID,
    metadata: dict,
) -> None:
    """Merge ``metadata`` into the existing row's ``metadata`` jsonb.

    Used by the post-primary critic path (`docs/005 §5.8`) to stamp
    ``{ "critic": ..., "failure": ... }`` onto the final assistant
    message after it has been persisted but before the turn completes.
    """
    await conn.execute(
        """
        UPDATE eidan.messages
        SET metadata = COALESCE(metadata, '{}'::jsonb) || $2::jsonb
        WHERE id = $1
        """,
        message_id,
        json.dumps(metadata),
    )


async def record_behaviour_dlq_entry(
    conn: asyncpg.Connection,
    *,
    behaviour_id: str,
    trigger_kind: str,
    idempotency_key: str,
    error: BaseException,
    metadata: dict[str, Any] | None = None,
) -> None:
    """Write one ``eidan.behaviour_dlq`` row for a swallowed
    dispatcher exception (`docs/001 §5.3`).

    Best-effort: the function never raises. Any failure to write the
    DLQ row falls back to ``logger.exception`` (caller's logger; we
    do not own one here). The reason is that this helper runs from
    inside the dispatcher's broad-except block, which itself exists
    to keep the scheduler alive — re-raising here would re-introduce
    the very crash the DLQ is meant to capture.

    ``error_message`` is trimmed to 4000 characters: long stack
    traces in deeply-nested handlers can blow the message-row write
    budget, and the operator inbox doesn't need more than that to
    identify a pattern.
    """
    message = str(error)
    if len(message) > 4000:
        message = message[:3997] + "..."
    await conn.execute(
        """
        INSERT INTO eidan.behaviour_dlq
            (id, behaviour_id, trigger_kind, idempotency_key,
             error_class, error_message, metadata)
        VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
        """,
        uuid4(),
        behaviour_id,
        trigger_kind,
        idempotency_key,
        type(error).__name__,
        message,
        json.dumps(metadata or {}),
    )


async def flag_orphaned_assistant_messages(
    conn: asyncpg.Connection,
    *,
    grace_seconds: int = 60,
) -> int:
    """Stamp ``metadata.crashed_before_completion = true`` on every
    assistant-role message that looks interrupted (audit §11 fix).

    The loop writes ``metadata.completed_at`` on the final assistant
    message just before yielding ``TurnComplete``. Any assistant
    row older than ``grace_seconds`` without that marker, without
    an existing crash flag, and without ``budget_exceeded`` (the
    one clean shape that also lacks ``completed_at`` because the
    loop short-circuits before reaching it) is treated as the
    debris of a crashed previous process.

    Returns the number of rows flagged. Safe to call at every boot;
    the WHERE clause makes the operation idempotent — a row that
    was already flagged stays flagged with the same stamp.
    """
    result = await conn.execute(
        """
        UPDATE eidan.messages
        SET metadata = COALESCE(metadata, '{}'::jsonb)
                       || '{"crashed_before_completion": true}'::jsonb
        WHERE role = 'assistant'
          AND deleted_at IS NULL
          AND created_at < NOW() - make_interval(secs => $1)
          AND NOT (metadata ? 'completed_at')
          AND NOT (metadata ? 'crashed_before_completion')
          AND NOT (metadata ? 'budget_exceeded')
        """,
        grace_seconds,
    )
    # asyncpg returns 'UPDATE <n>' for the command tag; parse the count.
    parts = result.rsplit(" ", 1) if isinstance(result, str) else []
    if len(parts) == 2 and parts[1].isdigit():
        return int(parts[1])
    return 0


async def insert_tool_message(
    conn: asyncpg.Connection,
    *,
    user_id: UUID,
    conversation_id: UUID,
    parent_message_id: UUID | None,
    tool_results: tuple[ToolResultBlock, ...],
    agent_id: UUID | None = None,
) -> UUID:
    """Eager-save a tool-role turn carrying one or more tool_result blocks.

    A tool turn has no ``content`` — its payload lives entirely in
    ``tool_results``. Per `docs/005 §5.5` the turn is written *before*
    the next primary iteration so a crash mid-loop leaves an honest
    transcript. ``agent_id`` stamps the active agent_context for the
    turn so a replay can attribute the tool ping-pong to the same
    persona that owned the surrounding assistant turn.
    """
    message_id = uuid4()
    results_json = json.dumps(
        [
            {
                "tool_use_id": r.tool_use_id,
                "content": r.content,
                "is_error": r.is_error,
            }
            for r in tool_results
        ]
    )
    await conn.execute(
        """
        INSERT INTO eidan.messages
            (id, user_id, conversation_id, parent_message_id,
             role, tool_results, agent_id)
        VALUES
            ($1, $2, $3, $4, 'tool', $5::jsonb, $6)
        """,
        message_id,
        user_id,
        conversation_id,
        parent_message_id,
        results_json,
        agent_id,
    )
    return message_id


#: How many characters of an inbound user message to persist alongside
#: a call. The introspection panel (#152) renders this as a glance — full
#: replay is owned by the message rows, not the llm_calls row.
USER_TEXT_EXCERPT_LIMIT = 240


def _node_identity_for_metadata() -> dict[str, str]:
    """Resolve the node identity that should ride on every per-call
    metadata blob so the introspection panel (#169) can show
    "this turn ran on kasha" without scraping logs.

    Reads ``EIDAN_NODE_ID`` / ``EIDAN_NODE_TYPE`` set by the deploy
    pipeline (topology.yml → pi.py / fly.py). Keys are omitted when
    the env is unset — the UI then renders no chip rather than a
    placeholder. The autodetect fallback that lives in
    :mod:`eidan_backend.node_identity` is intentionally NOT used
    here: that would tie the metadata write to the host's hostname,
    which is opaque on fly machines. The operator-provided env is
    the canonical answer.
    """
    out: dict[str, str] = {}
    node_id = os.environ.get("EIDAN_NODE_ID", "").strip()
    if node_id:
        out["node_id"] = node_id
    node_type = os.environ.get("EIDAN_NODE_TYPE", "").strip()
    if node_type:
        out["node_type"] = node_type
    return out


def capture_call_inputs(
    call: ProviderCallResult,
    *,
    system_prompt: str,
    user_text: str | None = None,
    extra: dict[str, Any] | None = None,
) -> ProviderCallResult:
    """Return a copy of ``call`` whose ``metadata`` carries the inputs
    the model saw. Classifier + primary call sites use this so the
    persisted row keeps "what did we send" alongside the existing
    "what came back" telemetry — see #152 / docs/014.

    The excerpt is clipped to :data:`USER_TEXT_EXCERPT_LIMIT` so a long
    user message can't bloat every per-call row.

    Per #169, the node identity (``EIDAN_NODE_ID`` / ``EIDAN_NODE_TYPE``)
    is also stashed when the env is set, so the introspection panel
    can render a chip for which node executed the turn.
    """
    blob: dict[str, Any] = {**call.metadata}
    blob["system_prompt"] = system_prompt
    if user_text is not None:
        blob["user_text_excerpt"] = user_text[:USER_TEXT_EXCERPT_LIMIT]
    blob.update(_node_identity_for_metadata())
    if extra:
        blob.update(extra)
    return dataclasses.replace(call, metadata=blob)


async def insert_llm_call(
    conn: asyncpg.Connection,
    *,
    user_id: UUID,
    conversation_id: UUID,
    message_id: UUID,
    role: str,
    result: ProviderCallResult,
    agent_id: UUID | None = None,
    metadata: dict[str, Any] | None = None,
) -> None:
    """Write the per-call telemetry row. Immutable; no soft-delete.

    Persists whatever the call site recorded into ``metadata``. When
    the explicit ``metadata`` kwarg is omitted, the row picks up
    ``result.metadata`` instead — the classifier / primary call has
    typically stashed the system prompt + a user-text excerpt there
    so the introspection panel (`docs/014` + #152) can later render
    "what the model actually saw" without a separate kwarg dance at
    every call site."""
    finished_at = result.finished_at or datetime.now(UTC)
    latency_ms = int(
        (finished_at - result.started_at).total_seconds() * 1000
    )
    row_metadata = metadata if metadata is not None else result.metadata
    await conn.execute(
        """
        INSERT INTO eidan.llm_calls
            (user_id, conversation_id, message_id, role,
             provider, model,
             input_tokens, output_tokens,
             cache_read_tokens, cache_creation_tokens,
             cost_usd, latency_ms,
             started_at, finished_at, request_id, agent_id,
             metadata)
        VALUES
            ($1, $2, $3, $4,
             $5, $6,
             $7, $8,
             $9, $10,
             $11, $12,
             $13, $14, $15, $16,
             $17)
        """,
        user_id,
        conversation_id,
        message_id,
        role,
        result.message.provider,
        result.message.model,
        result.input_tokens,
        result.output_tokens,
        result.cache_read_tokens,
        result.cache_creation_tokens,
        result.cost_usd,
        latency_ms,
        result.started_at,
        finished_at,
        result.request_id,
        agent_id,
        json.dumps(row_metadata or {}, default=str),
    )


async def insert_plugin_llm_call(
    conn: asyncpg.Connection,
    *,
    user_id: UUID,
    conversation_id: UUID | None,
    message_id: UUID | None,
    agent_id: UUID | None,
    role: str,
    provider: str,
    model: str,
    input_tokens: int,
    output_tokens: int,
    cache_read_tokens: int,
    cache_creation_tokens: int,
    cost_usd: float,
    started_at: datetime,
    finished_at: datetime | None,
    request_id: str | None,
    error: str | None,
    error_type: str | None,
    metadata: dict | None,
) -> None:
    """Write one ``eidan.llm_calls`` row on behalf of a plugin tool.

    Variant of :func:`insert_llm_call` for the plugin-emitted path
    (`docs/010 §3.1` row 5 / issue #16). The shape of the row is
    identical — same four token axes, same ``cost_usd`` semantics
    (frozen at write time, `docs/010 §2.1`), same ``role`` /
    ``error_type`` columns. The split exists only because the
    upstream caller is a plugin, not a :class:`ProviderCallResult`-
    producing in-process adapter, so the argument shape differs.

    EP holds: the INSERT commits before the function returns
    (`docs/010 §3`). A plugin that re-invokes the upstream writes a
    new row — never updates an old one (§2.1 "Retries are separate
    rows").

    Datetime normalisation: a plugin may hand us naive datetimes
    (``datetime.utcnow()``) or aware ones (``datetime.now(UTC)``).
    Mixing the two would raise ``TypeError`` on subtraction, so we
    coerce both to UTC-aware here before computing latency. The
    upstream column is ``timestamptz``, so the asyncpg adapter
    expects aware values anyway. ``finished`` is clamped to
    ``started_at`` so a clock skew never produces a negative
    ``latency_ms``.
    """
    started_at = _ensure_aware_utc(started_at)
    finished = _ensure_aware_utc(finished_at) if finished_at else datetime.now(UTC)
    if finished < started_at:
        finished = started_at
    latency_ms = int((finished - started_at).total_seconds() * 1000)
    metadata_json = json.dumps(metadata or {})
    await conn.execute(
        """
        INSERT INTO eidan.llm_calls
            (user_id, conversation_id, message_id, role,
             provider, model,
             input_tokens, output_tokens,
             cache_read_tokens, cache_creation_tokens,
             cost_usd, latency_ms,
             started_at, finished_at, request_id, agent_id,
             error, error_type, metadata)
        VALUES
            ($1, $2, $3, $4,
             $5, $6,
             $7, $8,
             $9, $10,
             $11, $12,
             $13, $14, $15, $16,
             $17, $18, $19::jsonb)
        """,
        user_id,
        conversation_id,
        message_id,
        role,
        provider,
        model,
        input_tokens,
        output_tokens,
        cache_read_tokens,
        cache_creation_tokens,
        cost_usd,
        latency_ms,
        started_at,
        finished,
        request_id,
        agent_id,
        error,
        error_type,
        metadata_json,
    )


async def load_conversation_messages(
    conn: asyncpg.Connection,
    *,
    conversation_id: UUID,
) -> list[tuple[str, str]]:
    """Replay a conversation as a list of (role, content) tuples.

    Used to build the provider call's context window. Phase 1 reads the
    full conversation; sizing / truncation are Phase 1.5 (`005 §5.4`).
    """
    rows = await conn.fetch(
        """
        SELECT role, content
        FROM eidan.messages
        WHERE conversation_id = $1
          AND deleted_at IS NULL
          AND content IS NOT NULL
        ORDER BY created_at ASC
        """,
        conversation_id,
    )
    return [(row["role"], row["content"]) for row in rows]


async def list_conversations(
    conn: asyncpg.Connection,
    *,
    user_id: UUID,
    limit: int = 50,
) -> list[dict]:
    """List a user's most recent conversations.

    Used by ``GET /api/conversations`` (`docs/014 §3`). Soft-deleted
    rows are filtered; sorting is newest-first per
    ``idx_conversations_user_recent``.
    """
    rows = await conn.fetch(
        """
        SELECT id, title, created_at, updated_at
        FROM eidan.conversations
        WHERE user_id = $1
          AND deleted_at IS NULL
        ORDER BY created_at DESC
        LIMIT $2
        """,
        user_id,
        limit,
    )
    return [
        {
            "id": row["id"],
            "title": row["title"],
            "created_at": row["created_at"],
            "updated_at": row["updated_at"],
        }
        for row in rows
    ]


async def conversation_belongs_to(
    conn: asyncpg.Connection,
    *,
    conversation_id: UUID,
    user_id: UUID,
) -> bool:
    """Verify a conversation exists and is owned by ``user_id``."""
    row = await conn.fetchrow(
        """
        SELECT 1
        FROM eidan.conversations
        WHERE id = $1
          AND user_id = $2
          AND deleted_at IS NULL
        """,
        conversation_id,
        user_id,
    )
    return row is not None


async def update_conversation_title(
    conn: asyncpg.Connection,
    *,
    conversation_id: UUID,
    user_id: UUID,
    title: str | None,
    only_if_null: bool = False,
) -> str | None:
    """Set or clear a conversation's title.

    Returns the stored title after the write (``None`` when cleared or
    when the row didn't match the optional ``only_if_null`` guard).

    ``only_if_null=True`` is the auto-title idempotency gate per issue
    #48 — the auto-title behaviour fires at-most-once per conversation
    by predicating the write on ``title IS NULL`` so a second turn
    cannot overwrite a title the operator has since edited.
    """
    if only_if_null:
        row = await conn.fetchrow(
            """
            UPDATE eidan.conversations
            SET title = $3
            WHERE id = $1
              AND user_id = $2
              AND deleted_at IS NULL
              AND title IS NULL
            RETURNING title
            """,
            conversation_id,
            user_id,
            title,
        )
    else:
        row = await conn.fetchrow(
            """
            UPDATE eidan.conversations
            SET title = $3
            WHERE id = $1
              AND user_id = $2
              AND deleted_at IS NULL
            RETURNING title
            """,
            conversation_id,
            user_id,
            title,
        )
    return row["title"] if row is not None else None


async def count_conversation_messages(
    conn: asyncpg.Connection,
    *,
    conversation_id: UUID,
) -> int:
    """Count non-deleted messages in a conversation.

    Used by the auto-title hook to detect "first agent turn just
    landed" (count == 2: one user + one assistant).
    """
    value = await conn.fetchval(
        """
        SELECT COUNT(*)
        FROM eidan.messages
        WHERE conversation_id = $1
          AND deleted_at IS NULL
        """,
        conversation_id,
    )
    return int(value or 0)


async def first_turn_pair(
    conn: asyncpg.Connection,
    *,
    conversation_id: UUID,
) -> tuple[str, str] | None:
    """Return ``(first_user_text, first_assistant_text)`` for a
    conversation, or ``None`` if the pair isn't there yet.

    Skips empty / null content rows so a turn that produced only tool
    calls doesn't poison the title summary. Used by the auto-title
    hook and ``POST /api/conversations/{id}/regenerate_title``.
    """
    user_row = await conn.fetchrow(
        """
        SELECT content
        FROM eidan.messages
        WHERE conversation_id = $1
          AND role = 'user'
          AND deleted_at IS NULL
          AND content IS NOT NULL
          AND content <> ''
        ORDER BY created_at ASC
        LIMIT 1
        """,
        conversation_id,
    )
    assistant_row = await conn.fetchrow(
        """
        SELECT content
        FROM eidan.messages
        WHERE conversation_id = $1
          AND role = 'assistant'
          AND deleted_at IS NULL
          AND content IS NOT NULL
          AND content <> ''
        ORDER BY created_at ASC
        LIMIT 1
        """,
        conversation_id,
    )
    if user_row is None or assistant_row is None:
        return None
    return user_row["content"], assistant_row["content"]


async def latest_user_message_id(
    conn: asyncpg.Connection,
    *,
    user_id: UUID,
) -> UUID | None:
    """Most recent user-role message id for ``user_id``.

    Used by the per-turn cost summary endpoint (`docs/010 §6.4`) when the
    caller does not pass an explicit ``message_id``. The "turn anchor"
    is the inbound user message id per `docs/010 §2.1`.
    """
    row = await conn.fetchrow(
        """
        SELECT id
        FROM eidan.messages
        WHERE user_id = $1
          AND role = 'user'
          AND deleted_at IS NULL
        ORDER BY created_at DESC
        LIMIT 1
        """,
        user_id,
    )
    return row["id"] if row is not None else None


async def cost_summary_for_turn(
    conn: asyncpg.Connection,
    *,
    user_id: UUID,
    message_id: UUID,
) -> dict:
    """Aggregate spend across every llm_call attached to ``message_id``.

    Matches the canonical per-turn rollup query in `docs/010 §8.1`. The
    extra ``user_id`` predicate guards against a client passing another
    user's message id — the caller is the authoritative owner.
    """
    row = await conn.fetchrow(
        """
        SELECT COALESCE(SUM(cost_usd), 0)       AS cost_usd,
               COALESCE(SUM(input_tokens), 0)   AS input_tokens,
               COALESCE(SUM(output_tokens), 0)  AS output_tokens,
               MIN(started_at)                  AS started_at
        FROM eidan.llm_calls
        WHERE user_id = $1
          AND message_id = $2
        """,
        user_id,
        message_id,
    )
    return _coerce_cost_row(row)


async def cost_summary_since(
    conn: asyncpg.Connection,
    *,
    user_id: UUID,
    since: datetime,
) -> dict:
    """Aggregate spend for ``user_id`` since ``since``.

    Used for the session counter (since-JWT-iat) and the rolling-day
    counter (since now()-24h) per `docs/010 §6.3` and `§8.3`. The two
    callers differ only in the timestamp they pass.
    """
    row = await conn.fetchrow(
        """
        SELECT COALESCE(SUM(cost_usd), 0)       AS cost_usd,
               COALESCE(SUM(input_tokens), 0)   AS input_tokens,
               COALESCE(SUM(output_tokens), 0)  AS output_tokens,
               MIN(started_at)                  AS first_started_at
        FROM eidan.llm_calls
        WHERE user_id = $1
          AND started_at >= $2
        """,
        user_id,
        since,
    )
    summary = _coerce_cost_row(row, started_at_key="first_started_at")
    summary["started_at"] = since
    return summary


def _coerce_cost_row(
    row: asyncpg.Record | None,
    *,
    started_at_key: str = "started_at",
) -> dict:
    if row is None:
        return {
            "cost_usd": 0.0,
            "input_tokens": 0,
            "output_tokens": 0,
            "started_at": None,
        }
    return {
        "cost_usd": float(row["cost_usd"] or 0),
        "input_tokens": int(row["input_tokens"] or 0),
        "output_tokens": int(row["output_tokens"] or 0),
        "started_at": row[started_at_key],
    }


async def load_full_conversation_messages(
    conn: asyncpg.Connection,
    *,
    conversation_id: UUID,
) -> list[dict]:
    """Load a conversation's messages with the columns the UI renders.

    Used by ``GET /api/conversations/{id}/messages`` (`docs/014 §4.2`).
    Includes tool turns and metadata so the thread can fold the tool
    ping-pong under the assistant message that issued it.
    """
    rows = await conn.fetch(
        """
        SELECT id, role, content, tool_calls, tool_results,
               parent_message_id, provider, model, metadata, created_at
        FROM eidan.messages
        WHERE conversation_id = $1
          AND deleted_at IS NULL
        ORDER BY created_at ASC
        """,
        conversation_id,
    )
    return [
        {
            "id": row["id"],
            "role": row["role"],
            "content": row["content"],
            "tool_calls": row["tool_calls"],
            "tool_results": row["tool_results"],
            "parent_message_id": row["parent_message_id"],
            "provider": row["provider"],
            "model": row["model"],
            "metadata": row["metadata"],
            "created_at": row["created_at"],
        }
        for row in rows
    ]
