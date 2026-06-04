"""Subagent spawn primitive — `docs/008 §3`.

Today the runner enters its first turn via ``run_turn`` and that's it.
This module adds the second entry — ``spawn_turn`` — for a primary
loop that wants to delegate a sub-task to a nested turn. The child
runs the same ``run_turn`` end-to-end (its own scope / sizer / primary
/ critic / failure pipeline); the parent gets back a single
:class:`SpawnResult` with the assembled text, cost rollup, and the
parent linkage for the audit trail.

Phase 1 ships the **turn** flavour only. The helper flavour from
``docs/008 §2`` (one ``Provider.start_call`` rather than a full turn)
is a follow-up — it would let the loop reuse spawn for the classifier
calls it already makes inline.

Three things land here:

- :class:`SpawnRequest` / :class:`SpawnResult` / :class:`SpawnError` —
  the wire shape from §3.1 / §3.2 / §6.2, narrowed to the fields the
  Phase-1 runner actually populates.
- :func:`spawn_turn` — the async entry point. Validates depth before
  it starts any provider work, drives the child ``run_turn``, and
  bundles the result.
- :class:`SubagentDepthExceeded` — raised when ``parent.depth >=
  MAX_SPAWN_DEPTH``. The parent's tool surface can catch this and
  surface a structured tool error rather than crashing the parent
  turn.
"""

from __future__ import annotations

import asyncio
import time
from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from datetime import UTC, datetime
from uuid import UUID

import asyncpg

from .db import acquire
from .loop import TurnComplete, TurnContext, run_turn
from .persistence import cost_summary_for_turn
from .providers.base import AssistantChunk, Provider
from .telemetry import TelemetryEmitter
from .tools import ToolRegistry

# Hard cap on subagent depth (`docs/008 §3`). User-initiated turns
# start at 0; every ``spawn_turn`` increments. A nested chain deeper
# than this is almost always a runaway tool loop, not a legitimate
# delegation pattern, so we reject before any provider work happens.
MAX_SPAWN_DEPTH = 3


@dataclass(frozen=True, slots=True)
class SpawnError:
    """Structured error envelope the parent can route as a tool error.

    Mirrors ``docs/008 §6.2``. ``code`` is the closed set the runner
    knows; ``detail`` is human-readable; ``request_id`` (when
    populated) is the child's failing provider call id so the
    operator can grep for it.
    """

    code: str
    detail: str
    request_id: str | None = None


@dataclass(frozen=True, slots=True)
class SpawnResult:
    """What the parent receives back from :func:`spawn_turn`.

    Shape pinned in ``docs/008 §3.2``, narrowed to the fields the
    turn flavour actually populates. Cost / token rollups are summed
    via :func:`cost_summary_for_turn` against the child's anchor
    user message id — every ``llm_calls`` row the child wrote
    references that id, so the parent gets a complete bill.
    """

    ok: bool
    text: str = ""
    error: SpawnError | None = None
    user_message_id: UUID | None = None
    final_message_id: UUID | None = None
    cost_usd: float = 0.0
    input_tokens: int = 0
    output_tokens: int = 0
    latency_ms: int = 0
    depth: int = 0
    metadata: dict = field(default_factory=dict)


class SubagentDepthExceeded(Exception):
    """Raised when a spawn would push ``depth`` above :data:`MAX_SPAWN_DEPTH`."""


@dataclass(frozen=True, slots=True)
class SpawnRequest:
    """Parent-supplied inputs for a single subagent invocation.

    Phase 1 carries only the fields the turn flavour reads; the rest
    of the §3.1 fields (``response_format``, ``cache``, ``tools``,
    ``timeout_s``, ``cancel_token``) land alongside the helper
    flavour in a follow-up.
    """

    user_text: str
    parent: TurnContext
    parent_message_id: UUID
    system_prompt: str | None = None
    role: str = "subagent"
    metadata: dict = field(default_factory=dict)


async def spawn_turn(
    *,
    request: SpawnRequest,
    pool: asyncpg.Pool,
    provider: Provider,
    model: str,
    sent_at_utc: datetime | None = None,
    user_tz: str = "UTC",
    tool_registry: ToolRegistry | None = None,
    max_turn_cost_usd: float | None = None,
    telemetry: TelemetryEmitter | None = None,
) -> SpawnResult:
    """Run one subagent turn end-to-end against the same primary loop.

    Validates depth, builds a child :class:`TurnContext` with depth +
    1 and the parent's anchor id pinned, drives the inner
    :func:`run_turn` to completion, and aggregates costs against the
    child's anchor message id.

    Failures surface as a :class:`SpawnResult` with ``ok=False`` and
    a populated :class:`SpawnError` — the parent decides whether to
    surface them as a tool error or absorb them. Cancellation of the
    parent's outer call propagates as ``asyncio.CancelledError``
    inside ``run_turn`` and bubbles out of this coroutine cleanly.
    """
    parent_ctx = request.parent
    child_depth = parent_ctx.depth + 1
    if child_depth > MAX_SPAWN_DEPTH:
        raise SubagentDepthExceeded(
            f"refusing to spawn at depth {child_depth} "
            f"(max {MAX_SPAWN_DEPTH}, docs/008 §3)"
        )

    child_ctx = TurnContext(
        identity=parent_ctx.identity,
        conversation_id=parent_ctx.conversation_id,
        system_prompt=request.system_prompt or parent_ctx.system_prompt,
        depth=child_depth,
        parent_message_id=request.parent_message_id,
    )

    sent_at = sent_at_utc or datetime.now(tz=UTC)
    started = time.monotonic()
    text_chunks: list[str] = []
    completion: TurnComplete | None = None

    # Emit start event
    if telemetry:
        await telemetry.emit_event(
            "agent.spawn.start",
            {
                "depth": child_depth,
                "request_text_excerpt": request.user_text[:80],
                "parent_depth": parent_ctx.depth,
            },
            conversation_id=parent_ctx.conversation_id,
        )

    try:
        async for event in run_turn(
            pool=pool,
            provider=provider,
            model=model,
            ctx=child_ctx,
            user_text=request.user_text,
            sent_at_utc=sent_at,
            user_tz=user_tz,
            tool_registry=tool_registry,
            max_turn_cost_usd=max_turn_cost_usd,
            telemetry=telemetry,
        ):
            if isinstance(event, AssistantChunk):
                text_chunks.append(event.text)
            elif isinstance(event, TurnComplete):
                completion = event
    except asyncio.CancelledError:
        # Parent cancellation — propagate up; not a SpawnError.
        raise
    except Exception as exc:  # noqa: BLE001 — every failure type belongs in SpawnError
        latency_ms = int((time.monotonic() - started) * 1000)
        if telemetry:
            await telemetry.emit_event(
                "agent.spawn.error",
                {
                    "depth": child_depth,
                    "error_code": "subagent.exception",
                    "error_detail": f"{type(exc).__name__}: {exc}"[:200],
                    "latency_ms": latency_ms,
                },
                conversation_id=parent_ctx.conversation_id,
            )
        return SpawnResult(
            ok=False,
            error=SpawnError(
                code="subagent.exception",
                detail=f"{type(exc).__name__}: {exc}",
            ),
            depth=child_depth,
            latency_ms=latency_ms,
        )

    if completion is None:
        latency_ms = int((time.monotonic() - started) * 1000)
        if telemetry:
            await telemetry.emit_event(
                "agent.spawn.error",
                {
                    "depth": child_depth,
                    "error_code": "subagent.no_completion",
                    "error_detail": "run_turn ended without a TurnComplete event",
                    "latency_ms": latency_ms,
                },
                conversation_id=parent_ctx.conversation_id,
            )
        return SpawnResult(
            ok=False,
            error=SpawnError(
                code="subagent.no_completion",
                detail="run_turn ended without a TurnComplete event",
            ),
            depth=child_depth,
            latency_ms=latency_ms,
        )

    # Cost rollup: every llm_calls row the child wrote attributes to
    # the child's anchor user_message_id; the existing rollup query
    # sums them with no schema change.
    async with acquire(pool, parent_ctx.identity) as conn:
        summary = await cost_summary_for_turn(
            conn,
            user_id=UUID(parent_ctx.identity.user_id),
            message_id=completion.user_message_id,
        )

    latency_ms = int((time.monotonic() - started) * 1000)
    cost_usd = float(summary.get("cost_usd") or 0.0)
    input_tokens = int(summary.get("input_tokens") or 0)
    output_tokens = int(summary.get("output_tokens") or 0)

    if telemetry:
        await telemetry.emit_event(
            "agent.spawn.complete",
            {
                "depth": child_depth,
                "cost_usd": cost_usd,
                "input_tokens": input_tokens,
                "output_tokens": output_tokens,
                "latency_ms": latency_ms,
                "iterations": completion.iterations,
            },
            conversation_id=parent_ctx.conversation_id,
        )

    return SpawnResult(
        ok=True,
        text="".join(text_chunks),
        user_message_id=completion.user_message_id,
        final_message_id=completion.assistant_message_id,
        cost_usd=cost_usd,
        input_tokens=input_tokens,
        output_tokens=output_tokens,
        latency_ms=latency_ms,
        depth=child_depth,
        metadata=dict(request.metadata),
    )


# Convenience generator-style API mirroring ``run_turn``'s shape so
# callers that want to stream the subagent's text deltas to their own
# parent surface can do so without buffering.
async def stream_spawn_turn(
    *,
    request: SpawnRequest,
    pool: asyncpg.Pool,
    provider: Provider,
    model: str,
    sent_at_utc: datetime | None = None,
    user_tz: str = "UTC",
    tool_registry: ToolRegistry | None = None,
    max_turn_cost_usd: float | None = None,
    telemetry: TelemetryEmitter | None = None,
) -> AsyncIterator[AssistantChunk | SpawnResult]:
    """Streaming variant — yields each ``AssistantChunk`` as it
    arrives, then a final :class:`SpawnResult` once the child turn
    completes. The non-streaming :func:`spawn_turn` is built on top of
    this same code path.
    """
    parent_ctx = request.parent
    child_depth = parent_ctx.depth + 1
    if child_depth > MAX_SPAWN_DEPTH:
        raise SubagentDepthExceeded(
            f"refusing to spawn at depth {child_depth} "
            f"(max {MAX_SPAWN_DEPTH}, docs/008 §3)"
        )

    child_ctx = TurnContext(
        identity=parent_ctx.identity,
        conversation_id=parent_ctx.conversation_id,
        system_prompt=request.system_prompt or parent_ctx.system_prompt,
        depth=child_depth,
        parent_message_id=request.parent_message_id,
    )

    sent_at = sent_at_utc or datetime.now(tz=UTC)
    started = time.monotonic()
    text_chunks: list[str] = []
    completion: TurnComplete | None = None
    failure: Exception | None = None

    # Emit start event
    if telemetry:
        await telemetry.emit_event(
            "agent.spawn.start",
            {
                "depth": child_depth,
                "request_text_excerpt": request.user_text[:80],
                "parent_depth": parent_ctx.depth,
            },
            conversation_id=parent_ctx.conversation_id,
        )

    try:
        async for event in run_turn(
            pool=pool,
            provider=provider,
            model=model,
            ctx=child_ctx,
            user_text=request.user_text,
            sent_at_utc=sent_at,
            user_tz=user_tz,
            tool_registry=tool_registry,
            max_turn_cost_usd=max_turn_cost_usd,
            telemetry=telemetry,
        ):
            if isinstance(event, AssistantChunk):
                text_chunks.append(event.text)
                yield event
            elif isinstance(event, TurnComplete):
                completion = event
    except asyncio.CancelledError:
        raise
    except Exception as exc:  # noqa: BLE001
        failure = exc

    if failure is not None:
        latency_ms = int((time.monotonic() - started) * 1000)
        if telemetry:
            await telemetry.emit_event(
                "agent.spawn.error",
                {
                    "depth": child_depth,
                    "error_code": "subagent.exception",
                    "error_detail": f"{type(failure).__name__}: {failure}"[:200],
                    "latency_ms": latency_ms,
                },
                conversation_id=parent_ctx.conversation_id,
            )
        yield SpawnResult(
            ok=False,
            error=SpawnError(
                code="subagent.exception",
                detail=f"{type(failure).__name__}: {failure}",
            ),
            depth=child_depth,
            latency_ms=latency_ms,
        )
        return

    if completion is None:
        latency_ms = int((time.monotonic() - started) * 1000)
        if telemetry:
            await telemetry.emit_event(
                "agent.spawn.error",
                {
                    "depth": child_depth,
                    "error_code": "subagent.no_completion",
                    "error_detail": "run_turn ended without a TurnComplete event",
                    "latency_ms": latency_ms,
                },
                conversation_id=parent_ctx.conversation_id,
            )
        yield SpawnResult(
            ok=False,
            error=SpawnError(
                code="subagent.no_completion",
                detail="run_turn ended without a TurnComplete event",
            ),
            depth=child_depth,
            latency_ms=int((time.monotonic() - started) * 1000),
        )
        return

    async with acquire(pool, parent_ctx.identity) as conn:
        summary = await cost_summary_for_turn(
            conn,
            user_id=UUID(parent_ctx.identity.user_id),
            message_id=completion.user_message_id,
        )

    latency_ms = int((time.monotonic() - started) * 1000)
    cost_usd = float(summary.get("cost_usd") or 0.0)
    input_tokens = int(summary.get("input_tokens") or 0)
    output_tokens = int(summary.get("output_tokens") or 0)

    if telemetry:
        await telemetry.emit_event(
            "agent.spawn.complete",
            {
                "depth": child_depth,
                "cost_usd": cost_usd,
                "input_tokens": input_tokens,
                "output_tokens": output_tokens,
                "latency_ms": latency_ms,
                "iterations": completion.iterations,
            },
            conversation_id=parent_ctx.conversation_id,
        )

    yield SpawnResult(
        ok=True,
        text="".join(text_chunks),
        user_message_id=completion.user_message_id,
        final_message_id=completion.assistant_message_id,
        cost_usd=cost_usd,
        input_tokens=input_tokens,
        output_tokens=output_tokens,
        latency_ms=latency_ms,
        depth=child_depth,
        metadata=dict(request.metadata),
    )


__all__ = [
    "MAX_SPAWN_DEPTH",
    "SpawnError",
    "SpawnRequest",
    "SpawnResult",
    "SubagentDepthExceeded",
    "spawn_turn",
    "stream_spawn_turn",
]
