"""Agent loop — Phase 1.5 wires in the tool execution path.

A single turn:

  user message arrives
  → eager-save the user message (`docs/005 §1.1`)
  → load conversation history
  → ③ scope classifier — cheap call, EP llm_calls(role=scope_classifier)
  → ④ sizer — cheap call, EP llm_calls(role=sizer); picks the primary model
  → ⑥ primary call loop (`docs/005 §5.5`):
        repeat:
          stream a primary call to the provider
          EP assistant turn (role=assistant) with any tool_calls populated
          EP llm_calls (role=primary) for this iteration
          if no tool_calls: exit loop
          for each tool_use: execute via the tool registry
          EP tool turn (role=tool) with the tool_results populated
          append the assistant + tool turns to the in-memory history
        until the model returns text only
  → ⑦ failure detector — deterministic, no LLM call
  → ⑧ conditional critic — runs only when ⑦ flagged
        EP critic-marked assistant row + llm_calls(role=critic)
  → emit final TurnComplete

Behaviour loading, the agent router, and the subagent path are still
later steps in `docs/005 §3 ⑤, ⑩`. The Phase-1.5 critic does NOT yet
re-run the primary loop on a rewrite / escalate verdict — that's
Phase 2.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any
from uuid import UUID

import asyncpg

from .classifiers import (
    classify_intent,
    classify_scope,
    pick_model,
    render_action_list,
)
from .classifiers.failure import FallbackResult, classify_failure
from .critic import run_critic
from .db import acquire
from .failure_detector import (
    HistoryMessage,
    aggregate_weight,
)
from .failure_detector import detect as detect_failure
from .failure_detector import detect_pre_primary as detect_failure_pre_primary
from .identity import Identity, current_agent_id, current_identity
from .persistence import (
    cost_summary_for_turn,
    ensure_default_agent_context,
    insert_assistant_message,
    insert_llm_call,
    insert_plugin_llm_call,
    insert_tool_message,
    insert_user_message,
    load_conversation_messages,
    load_full_conversation_messages,
    update_message_metadata,
    upsert_user,
)
from .pricing import compute_cost_usd
from .providers.base import (
    AssistantBlock,
    AssistantChunk,
    Provider,
    ToolResultBlock,
    ToolUseBlock,
    UserMessage,
)
from .tools import ToolContext, ToolError, ToolRegistry
from .turn_header import EIDAN_BASE_IDENTITY, build_turn_header, compose_system_prompt

_MAX_TOOL_ITERATIONS = 12  # `docs/005 §5.5` "loop bounds"

# Aggregate weight at or above which the cross-turn detector's verdict
# is upgraded to an LLM call (`docs/009 §6.2`, §7.2 default). Sum of
# matched §3.2 signal weights crossing this value opens the
# classifier-fallback path.
_FAILURE_CLASSIFIER_THRESHOLD = 0.8


def _project_history_tail(
    full_rows: list[dict],
) -> list[HistoryMessage]:
    """Project the metadata-aware history rows into the slim shape the
    cross-turn detector consumes, EXCLUDING the just-inserted user
    message at the tail.

    ``load_full_conversation_messages`` returns rows ordered by
    ``created_at ASC``; the last row is the user message we just
    persisted at step ②. The detector receives the prefix and uses
    ``user_text`` (threaded separately) as the "current" anchor.
    """
    if not full_rows:
        return []
    prefix = full_rows[:-1]
    out: list[HistoryMessage] = []
    for row in prefix:
        role = row.get("role")
        if role not in ("user", "assistant"):
            continue
        content = row.get("content") or ""
        metadata = row.get("metadata") or {}
        if isinstance(metadata, str):
            # asyncpg leaves jsonb columns as either dict or str
            # depending on codec; fall back to empty dict on parse fail.
            try:
                import json as _json

                metadata = _json.loads(metadata)
            except (ValueError, TypeError):
                metadata = {}
        out.append(
            HistoryMessage(
                role=role,
                content=str(content),
                metadata=dict(metadata) if isinstance(metadata, dict) else {},
            )
        )
    return out


@dataclass(frozen=True, slots=True)
class TurnContext:
    """Per-turn context the loop carries.

    Mirrors the shape pinned in `001 §2.2` / `005 §4`, restricted to what
    Phase 1 actually uses. Identity, conversation, optional system prompt,
    and the subagent linkage fields.

    ``system_prompt`` is the **caller-supplied persona override** for this
    turn — the seam a plugin / sub-agent uses to replace the operator's
    saved persona without touching the agent_context row. The loop's
    resolution chain is::

        effective_persona = ctx.system_prompt
                            OR agent_context.user_overrides.system_prompt
                            OR agent_context.code_defaults.system_prompt
                            OR None

    The hardcoded baseline identity (``EIDAN_BASE_IDENTITY``) always
    renders before whichever persona wins — neither the operator nor a
    plugin can erase "I'm Eidan, not Claude".

    ``depth`` and ``parent_message_id`` carry the subagent invocation
    linkage from ``docs/008``. User-initiated turns have ``depth=0`` and
    ``parent_message_id=None``; a subagent spawned by a parent turn
    inherits ``depth=parent.depth + 1`` and ``parent_message_id`` set
    to the parent's anchor message id. The loop stamps
    ``metadata.parent_message_id`` onto the subagent's inbound user
    message so the audit trail reads cleanly without a schema change.
    """

    identity: Identity
    conversation_id: UUID
    system_prompt: str | None = None
    depth: int = 0
    parent_message_id: UUID | None = None


@dataclass(frozen=True, slots=True)
class TurnComplete:
    """Terminal event yielded after the final chunk.

    Carries the IDs of the rows the loop wrote, so the caller (REPL,
    eventually UI) can correlate streaming output with persisted state.
    ``assistant_message_id`` is the *final* assistant text turn — the
    one the UI renders — not any intermediate tool_use turn.
    """

    user_message_id: UUID
    assistant_message_id: UUID


async def run_turn(
    *,
    pool: asyncpg.Pool,
    provider: Provider,
    model: str,
    ctx: TurnContext,
    user_text: str,
    sent_at_utc: datetime,
    user_tz: str,
    tool_registry: ToolRegistry | None = None,
    max_turn_cost_usd: float | None = None,
) -> AsyncIterator[AssistantChunk | TurnComplete]:
    """Drive one turn end-to-end. Yields chunks, then a TurnComplete.

    Each provider call gets its own ``llm_calls`` row (scope_classifier,
    sizer, then one ``primary`` per iteration), eager-persisted before
    the next step depends on it (`docs/010 §3`). The classifier rows
    reference the inbound user message, and so do every primary
    iteration's row — so a turn can be reassembled from telemetry alone.

    ``sent_at_utc`` and ``user_tz`` are stamped by the surface (REPL,
    HTTP composer) and feed the per-turn TZ header (issue #51) every
    provider call within the iteration shares as its system-prompt
    prefix. They also land on the user-message row's metadata for
    replay.
    """
    user_uuid = UUID(ctx.identity.user_id)
    registry = tool_registry or ToolRegistry()
    # Set the ambient identity for this turn so any tool handler the
    # primary loop invokes can read it without the loop having to pass
    # identity through the Tool.handler signature. ContextVar is
    # task-local; another turn in the same task overwrites this value
    # on its own ``set()``. No reset needed for correctness — tests
    # that exercise tools directly outside a turn set the contextvar
    # themselves.
    current_identity.set(ctx.identity)

    # Build the per-turn TZ header once. Every provider call inside the
    # iteration sees the same header so the model never gets a
    # contradicting clock.
    turn_header = build_turn_header(
        sent_at_utc=sent_at_utc,
        user_tz=user_tz,
    )

    async with acquire(pool, ctx.identity) as conn:
        # First-sight upsert. Idempotent; the trigger handles updated_at
        # on email churn.
        await upsert_user(
            conn,
            user_id=user_uuid,
            email=ctx.identity.email,
        )

        # Resolve the active agent_context row before any write — every
        # message + llm_call row for this turn carries its id, and tool
        # handlers that need a non-null ``agent_id`` (e.g. capture's
        # ``note`` → ``eidan.notes``) read it from the contextvar set
        # below. Lazily creates the user's default row on first turn.
        agent_uuid, agent_persona = await ensure_default_agent_context(
            conn, user_id=user_uuid
        )

        # Eager-save the inbound message before any provider work.
        # Stamp TZ metadata so a replay reconstructs the same header
        # the model originally saw. Subagent turns also stamp
        # ``parent_message_id`` + ``depth`` so a query against this
        # message's metadata recovers the parent linkage from
        # ``docs/008``.
        msg_metadata: dict[str, Any] = {
            "sent_at_utc": sent_at_utc.isoformat(),
            "user_tz": user_tz,
        }
        if ctx.depth > 0:
            msg_metadata["depth"] = ctx.depth
        if ctx.parent_message_id is not None:
            msg_metadata["parent_message_id"] = str(ctx.parent_message_id)
        user_message_id = await insert_user_message(
            conn,
            user_id=user_uuid,
            conversation_id=ctx.conversation_id,
            agent_id=agent_uuid,
            content=user_text,
            metadata=msg_metadata,
        )

        # Build the context window. Phase 1.5: full history, no truncation.
        history = await load_conversation_messages(
            conn, conversation_id=ctx.conversation_id
        )

        # Load the metadata-aware tail for the cross-turn detector
        # (step ②.5). Includes the just-inserted user message at the
        # end; we strip it before handing the list to the detector
        # (the current message is threaded in separately as
        # ``user_text``). Tool rows fall out at projection time so the
        # detector sees only user/assistant dialogue.
        full_rows = await load_full_conversation_messages(
            conn, conversation_id=ctx.conversation_id
        )

    # Publish the active agent_id for tool handlers that need it (paired
    # with ``current_identity`` above). Single ContextVar.set is sufficient
    # — overwritten by the next turn's set() in the same task.
    current_agent_id.set(agent_uuid)

    # `docs/010 §3.1` row 5 — closure handed to plugin tool handlers
    # via ``ToolContext.report_llm_call``. A plugin that invokes an LLM
    # outside the host's Provider abstraction (vendor CLI, paid HTTP
    # API, embedding upstream) calls this after the call completes;
    # the host computes ``cost_usd`` from its price table (the SINGLE
    # source of truth, ``docs/010 §2.1``) and writes the row before
    # returning, so EP holds and the per-turn / per-conversation /
    # per-day caps (`docs/010 §4`) include the spend uniformly with
    # in-loop spend on the very next iteration's pre-call check.
    async def _report_llm_call(
        *,
        provider: str,
        model: str,
        role: str = "plugin_tool",
        input_tokens: int = 0,
        output_tokens: int = 0,
        cache_read_tokens: int = 0,
        cache_creation_tokens: int = 0,
        started_at: datetime,
        finished_at: datetime | None = None,
        request_id: str | None = None,
        error: str | None = None,
        error_type: str | None = None,
        metadata: dict | None = None,
    ) -> None:
        # `eidan.llm_calls_tokens_chk` (the DB CHECK constraint) rejects
        # negative counts, but a plugin author who tripped it would see
        # an opaque asyncpg ``CheckViolationError`` wrapped as a generic
        # tool failure. Validate at the boundary so the message names
        # the offending axis and the plugin path stays loud.
        for axis_name, axis_value in (
            ("input_tokens", input_tokens),
            ("output_tokens", output_tokens),
            ("cache_read_tokens", cache_read_tokens),
            ("cache_creation_tokens", cache_creation_tokens),
        ):
            if axis_value < 0:
                raise ToolError(
                    f"report_llm_call: {axis_name}={axis_value} is negative; "
                    "token counts must be >= 0"
                )
        cost = compute_cost_usd(
            model,
            input_tokens=input_tokens,
            output_tokens=output_tokens,
            cache_read_tokens=cache_read_tokens,
            cache_creation_tokens=cache_creation_tokens,
        )
        async with acquire(pool, ctx.identity) as inner_conn:
            await insert_plugin_llm_call(
                inner_conn,
                user_id=user_uuid,
                conversation_id=ctx.conversation_id,
                message_id=user_message_id,
                agent_id=agent_uuid,
                role=role,
                provider=provider,
                model=model,
                input_tokens=input_tokens,
                output_tokens=output_tokens,
                cache_read_tokens=cache_read_tokens,
                cache_creation_tokens=cache_creation_tokens,
                cost_usd=cost,
                started_at=started_at,
                finished_at=finished_at,
                request_id=request_id,
                error=error,
                error_type=error_type,
                metadata=metadata or {},
            )

    tool_ctx = ToolContext(
        user_id=user_uuid,
        conversation_id=ctx.conversation_id,
        message_id=user_message_id,
        agent_id=agent_uuid,
        report_llm_call=_report_llm_call,
    )

    history_tail = _project_history_tail(full_rows)

    # ②.5 Pre-primary failure detector (`docs/009 §3.2`). Deterministic,
    # purely from the conversation tail — no LLM call. Cheap and runs
    # every turn so the loop can either fold the verdict into the final
    # message's metadata (low-confidence case) or trip the classifier-
    # fallback below (high-confidence case).
    pre_primary_result = detect_failure_pre_primary(
        user_text=user_text,
        history=history_tail,
    )
    pre_primary_weight = aggregate_weight(pre_primary_result)
    fallback_verdict: FallbackResult | None = None
    if pre_primary_weight >= _FAILURE_CLASSIFIER_THRESHOLD:
        # The deterministic rules suggest the previous answer(s)
        # missed. Pay one Haiku-class call to confirm before opening
        # the primary loop.
        fallback_verdict, fallback_call = await classify_failure(
            provider=provider,
            user_text=user_text,
            history=history_tail,
            matched_signals=[s.name for s in pre_primary_result.signals],
            system_prefix=turn_header,
        )
        async with acquire(pool, ctx.identity) as conn:
            await insert_llm_call(
                conn,
                user_id=user_uuid,
                conversation_id=ctx.conversation_id,
                message_id=user_message_id,
                agent_id=agent_uuid,
                role="failure_classifier",
                result=fallback_call,
            )

    # ③ Scope classifier — cheap call, results logged but otherwise unused
    # in this phase. Behaviour loading off the result lands in a follow-up.
    scope_result, scope_call = await classify_scope(
        provider=provider, user_text=user_text, system_prefix=turn_header
    )
    async with acquire(pool, ctx.identity) as conn:
        await insert_llm_call(
            conn,
            user_id=user_uuid,
            conversation_id=ctx.conversation_id,
            message_id=user_message_id,
            agent_id=agent_uuid,
            role="scope_classifier",
            result=scope_call,
        )

    # ④ Sizer — picks the primary call's model. Falls back to the
    # operator-configured default when the sizer's output is unparseable.
    # ``sizer_call`` is ``None`` when the sizer is disabled via
    # ``EIDAN_SIZER_ENABLED=0`` (non-Anthropic providers) — no provider
    # call happened so there is no telemetry row to write.
    sizer_result, sizer_call = await pick_model(
        provider=provider,
        user_text=user_text,
        scope=scope_result,
        system_prefix=turn_header,
    )
    if sizer_call is not None:
        async with acquire(pool, ctx.identity) as conn:
            await insert_llm_call(
                conn,
                user_id=user_uuid,
                conversation_id=ctx.conversation_id,
                message_id=user_message_id,
                agent_id=agent_uuid,
                role="sizer",
                result=sizer_call,
            )

    # ④.5 Intent classifier — names the actions the user wants performed
    # before the primary tries to perform them (issue #59). Output is
    # rendered into the primary's system prompt and (when piece C lands)
    # passed to the post-primary verifier.
    intent_result, intent_call = await classify_intent(
        provider=provider,
        user_text=user_text,
        scope=scope_result,
        system_prefix=turn_header,
    )
    async with acquire(pool, ctx.identity) as conn:
        await insert_llm_call(
            conn,
            user_id=user_uuid,
            conversation_id=ctx.conversation_id,
            message_id=user_message_id,
            agent_id=agent_uuid,
            role="intent_classifier",
            result=intent_call,
        )

    primary_model = sizer_result.model or model
    # Compose system prompt: TZ header → EIDAN_BASE_IDENTITY → action
    # list → effective persona. The persona is ``ctx.system_prompt`` when
    # the caller supplied one (sub-agent / plugin override path); otherwise
    # the persona pulled from the user's agent_context row
    # (``user_overrides → code_defaults → None``). The baseline identity
    # is always rendered first so a per-call persona can shift role without
    # being able to drop "I'm Eidan".
    action_block = render_action_list(intent_result.intended)
    effective_persona = ctx.system_prompt or agent_persona
    user_prompt_segment = (
        action_block + (effective_persona or "") if action_block else effective_persona
    )
    primary_system = compose_system_prompt(
        header=turn_header,
        identity=EIDAN_BASE_IDENTITY,
        user_prompt=user_prompt_segment,
    )

    messages = [UserMessage(role=role, content=content) for role, content in history]
    tools_surface = registry.surface() or None

    final_assistant_id: UUID | None = None
    final_text = ""
    final_tool_uses: list[ToolUseBlock] = []
    iterations_used = 0
    budget_exceeded = False
    # tool_uses_seen tracks the total tool_use blocks across all primary
    # iterations in the turn (not just the final one). The detector's
    # says-vs-did check (issue #60) uses this — if the intent classifier
    # named verifiable actions and the model emitted zero tool_uses across
    # the whole turn, the model has likely said "done" without doing
    # anything.
    tool_uses_seen = 0

    for _ in range(_MAX_TOOL_ITERATIONS):
        iterations_used += 1
        text_buffer: list[str] = []
        tool_uses: list[ToolUseBlock] = []

        stream: AsyncIterator[AssistantBlock] = provider.stream_turn(
            model=primary_model,
            messages=messages,
            system=primary_system,
            tools=tools_surface,
        )
        async for block in stream:
            if isinstance(block, AssistantChunk):
                text_buffer.append(block.text)
                yield block
            elif isinstance(block, ToolUseBlock):
                tool_uses.append(block)

        result = await provider.last_call_result()

        async with acquire(pool, ctx.identity) as conn:
            assistant_message_id = await insert_assistant_message(
                conn,
                user_id=user_uuid,
                conversation_id=ctx.conversation_id,
                parent_message_id=user_message_id,
                agent_id=agent_uuid,
                content=result.message.content,
                provider=result.message.provider,
                model=result.message.model,
                tool_calls=tuple(tool_uses),
            )
            await insert_llm_call(
                conn,
                user_id=user_uuid,
                conversation_id=ctx.conversation_id,
                message_id=user_message_id,
                agent_id=agent_uuid,
                role="primary",
                result=result,
            )

        final_assistant_id = assistant_message_id
        final_text = result.message.content
        final_tool_uses = list(tool_uses)
        tool_uses_seen += len(tool_uses)

        if not tool_uses:
            break

        # Per-turn budget cap (`docs/010 §2`). After every iteration's
        # cost row lands, sum the running total for this user_message_id
        # and stop the loop before the next provider call when it
        # crosses the cap. The assistant turn we just persisted is the
        # terminal artefact for the turn; the synthesis step writes a
        # ``budget_exceeded`` marker into the existing message metadata
        # so the UI debugger can show why we stopped.
        if max_turn_cost_usd is not None and max_turn_cost_usd > 0:
            async with acquire(pool, ctx.identity) as conn:
                summary = await cost_summary_for_turn(
                    conn,
                    user_id=user_uuid,
                    message_id=user_message_id,
                )
            if float(summary.get("cost_usd") or 0.0) >= max_turn_cost_usd:
                budget_exceeded = True
                break

        if registry.is_empty():
            # Defensive: with an empty registry we don't pass `tools=`
            # to the provider, so this branch shouldn't normally fire.
            # If a model emits tool_use anyway, refuse to execute and
            # end the loop — the assistant turn we just persisted is
            # the terminal artefact for the turn.
            break

        # Mirror the assistant turn into the in-memory history so the
        # next provider call sees its own tool_use blocks before the
        # corresponding tool_result blocks.
        messages.append(
            UserMessage(
                role="assistant",
                content=result.message.content,
                tool_calls=tuple(tool_uses),
            )
        )

        tool_results: list[ToolResultBlock] = []
        for tu in tool_uses:
            try:
                output = await registry.execute(tu.name, tu.input, tool_ctx)
                tool_results.append(
                    ToolResultBlock(tool_use_id=tu.id, content=output)
                )
            except ToolError as exc:
                tool_results.append(
                    ToolResultBlock(
                        tool_use_id=tu.id,
                        content=str(exc),
                        is_error=True,
                    )
                )

        async with acquire(pool, ctx.identity) as conn:
            await insert_tool_message(
                conn,
                user_id=user_uuid,
                conversation_id=ctx.conversation_id,
                parent_message_id=assistant_message_id,
                agent_id=agent_uuid,
                tool_results=tuple(tool_results),
            )

        messages.append(
            UserMessage(role="tool", tool_results=tuple(tool_results))
        )

    assert final_assistant_id is not None  # loop always runs ≥ 1 iteration

    # ⑦ Failure detector — deterministic, no LLM call. Phase 1.5 ships the
    # signal subset enumerated in `failure_detector.py`; the rest of
    # `docs/009` is deferred. Issue #60 added the says-vs-did signal,
    # so the detector also reads the intent classifier's output and the
    # tool_use count from the whole turn.
    detector = detect_failure(
        user_text=user_text,
        final_text=final_text,
        final_tool_calls=final_tool_uses,
        iterations_used=iterations_used,
        max_iterations=_MAX_TOOL_ITERATIONS,
        intended_actions=intent_result.intended,
        tool_uses_seen=tool_uses_seen,
    )

    # ⑧ Conditional critic — runs only when the detector flagged a signal.
    # Phase 1.5 records the verdict on the primary assistant message's
    # metadata; the only verdict the loop *acts* on at this phase is
    # ``rewrite`` paired with the says-vs-did signal (issue #60), which
    # opens a bounded retry. Other rewrite / escalate verdicts are
    # recorded but not acted on — Phase 2 broadens this.
    critic_message_id: UUID | None = None
    critic_result_verdict: str | None = None
    if detector.should_critique:
        critic_result, critic_call = await run_critic(
            provider=provider,
            user_text=user_text,
            primary_text=final_text,
            signals=detector.signals,
            system_prefix=turn_header,
        )
        async with acquire(pool, ctx.identity) as conn:
            critic_message_id = await insert_assistant_message(
                conn,
                user_id=user_uuid,
                conversation_id=ctx.conversation_id,
                parent_message_id=final_assistant_id,
                agent_id=agent_uuid,
                content=critic_result.reason,
                provider=critic_call.message.provider,
                model=critic_call.message.model,
                metadata={"critic": True, "verdict": critic_result.verdict},
            )
            await insert_llm_call(
                conn,
                user_id=user_uuid,
                conversation_id=ctx.conversation_id,
                message_id=critic_message_id,
                agent_id=agent_uuid,
                role="critic",
                result=critic_call,
            )
            await update_message_metadata(
                conn,
                message_id=final_assistant_id,
                metadata={
                    "failure": {"signals": [s.name for s in detector.signals]},
                    "critic": {
                        "verdict": critic_result.verdict,
                        "reason": critic_result.reason,
                    },
                },
            )
        critic_result_verdict = critic_result.verdict

    # ⑧.5 Retry-once branch (issue #60 follow-up).
    #
    # When the says-vs-did signal fired AND the critic asked for a
    # rewrite, open ONE more primary iteration with a tightened
    # wrap-up addendum. If that iteration emits tool_uses, execute
    # them and do one final iteration for terminal text. Bounded to
    # at most 2 retry iterations — we don't spiral on repeated
    # discrepancies.
    signal_names = {s.name for s in detector.signals}
    if (
        "actions_declared_not_executed" in signal_names
        and critic_result_verdict == "rewrite"
    ):
        tightened_addendum = (
            "\n\n---\n"
            "You previously said the action was complete but the system "
            "observed no tool call. The action was NOT done. Use the "
            "registered tools to do it NOW. Do not just describe the "
            "action in text — emit the appropriate tool_use block(s)."
        )
        retry_system = primary_system + tightened_addendum

        # Mirror the prior assistant turn so the retry call sees its
        # own "I'm done" claim alongside the addendum.
        messages.append(
            UserMessage(
                role="assistant",
                content=final_text,
                tool_calls=(),
            )
        )

        retry_tool_uses: list[ToolUseBlock] = []
        async for block in provider.stream_turn(
            model=primary_model,
            messages=messages,
            system=retry_system,
            tools=tools_surface,
        ):
            if isinstance(block, AssistantChunk):
                yield block
            elif isinstance(block, ToolUseBlock):
                retry_tool_uses.append(block)

        retry_result = await provider.last_call_result()

        async with acquire(pool, ctx.identity) as conn:
            retry_assistant_id = await insert_assistant_message(
                conn,
                user_id=user_uuid,
                conversation_id=ctx.conversation_id,
                parent_message_id=critic_message_id,
                agent_id=agent_uuid,
                content=retry_result.message.content,
                provider=retry_result.message.provider,
                model=retry_result.message.model,
                tool_calls=tuple(retry_tool_uses),
                metadata={"retry": "actions_declared_not_executed"},
            )
            await insert_llm_call(
                conn,
                user_id=user_uuid,
                conversation_id=ctx.conversation_id,
                message_id=user_message_id,
                agent_id=agent_uuid,
                role="primary",
                result=retry_result,
            )

        tool_uses_seen += len(retry_tool_uses)
        final_assistant_id = retry_assistant_id
        final_text = retry_result.message.content
        final_tool_uses = list(retry_tool_uses)

        # If the retry actually used a tool, execute it and do ONE
        # more iteration so the model emits terminal text after
        # seeing the tool result. This is the only fork into a second
        # retry iteration — strictly bounded.
        if retry_tool_uses and not registry.is_empty():
            messages.append(
                UserMessage(
                    role="assistant",
                    content=retry_result.message.content,
                    tool_calls=tuple(retry_tool_uses),
                )
            )

            tool_results: list[ToolResultBlock] = []
            for tu in retry_tool_uses:
                try:
                    output = await registry.execute(tu.name, tu.input, tool_ctx)
                    tool_results.append(
                        ToolResultBlock(tool_use_id=tu.id, content=output)
                    )
                except ToolError as exc:
                    tool_results.append(
                        ToolResultBlock(
                            tool_use_id=tu.id,
                            content=str(exc),
                            is_error=True,
                        )
                    )

            async with acquire(pool, ctx.identity) as conn:
                await insert_tool_message(
                    conn,
                    user_id=user_uuid,
                    conversation_id=ctx.conversation_id,
                    parent_message_id=retry_assistant_id,
                    agent_id=agent_uuid,
                    tool_results=tuple(tool_results),
                )

            messages.append(
                UserMessage(role="tool", tool_results=tuple(tool_results))
            )

            # Terminal iteration — collects the model's final text after
            # tool results land. We deliberately DON'T pass tools= here
            # so the model can't open a second tool fan-out.
            async for block in provider.stream_turn(
                model=primary_model,
                messages=messages,
                system=retry_system,
                tools=None,
            ):
                if isinstance(block, AssistantChunk):
                    yield block

            terminal_result = await provider.last_call_result()

            async with acquire(pool, ctx.identity) as conn:
                terminal_id = await insert_assistant_message(
                    conn,
                    user_id=user_uuid,
                    conversation_id=ctx.conversation_id,
                    parent_message_id=retry_assistant_id,
                    agent_id=agent_uuid,
                    content=terminal_result.message.content,
                    provider=terminal_result.message.provider,
                    model=terminal_result.message.model,
                    metadata={"retry": "actions_declared_not_executed_terminal"},
                )
                await insert_llm_call(
                    conn,
                    user_id=user_uuid,
                    conversation_id=ctx.conversation_id,
                    message_id=user_message_id,
                    agent_id=agent_uuid,
                    role="primary",
                    result=terminal_result,
                )

            final_assistant_id = terminal_id
            final_text = terminal_result.message.content
            final_tool_uses = []  # terminal turn carries no tool_use blocks

    if budget_exceeded:
        # Tag the assistant message so the UI debugger + post-hoc
        # analysis can see *why* the loop stopped without diffing the
        # iteration count against the configured cap.
        async with acquire(pool, ctx.identity) as conn:
            await update_message_metadata(
                conn,
                message_id=final_assistant_id,
                metadata={
                    "budget_exceeded": {
                        "cap_usd": max_turn_cost_usd,
                        "iterations": iterations_used,
                    },
                },
            )

    # Stash the cross-turn detector's verdict (signals + classifier
    # fallback when it fired). This runs unconditionally — even when
    # no within-turn signals fired and the critic stayed home — so the
    # operator's debugger can see *why* the loop chose to escalate (or
    # not) on this turn (`docs/009 §10`). Within-turn signals are
    # already written by the critic branch above; the merge in
    # update_message_metadata is shallow so the two blocks coexist
    # rather than overwrite.
    pre_primary_payload: dict[str, Any] = {}
    if pre_primary_result.signals:
        pre_primary_payload["signals"] = [
            s.name for s in pre_primary_result.signals
        ]
        pre_primary_payload["weight"] = round(pre_primary_weight, 3)
    if fallback_verdict is not None:
        pre_primary_payload["classifier"] = {
            "verdict": fallback_verdict.verdict,
            "reason": fallback_verdict.reason,
        }
    if pre_primary_payload:
        async with acquire(pool, ctx.identity) as conn:
            await update_message_metadata(
                conn,
                message_id=final_assistant_id,
                metadata={"failure_pre_primary": pre_primary_payload},
            )

    # Mark the final assistant turn as cleanly completed (audit §11
    # orphan-cleanup fix). The boot-time scanner reads this — any
    # assistant message older than the orphan grace period without
    # this marker is flagged crashed_before_completion so the UI can
    # show a faded "interrupted" indicator. The marker is written
    # AFTER every other write path (critic, failure, retry, budget
    # exceeded) so any code path that produced a final_assistant_id
    # via the normal flow lands here.
    async with acquire(pool, ctx.identity) as conn:
        await update_message_metadata(
            conn,
            message_id=final_assistant_id,
            metadata={
                "completed_at": datetime.now(tz=UTC).isoformat(),
            },
        )

    yield TurnComplete(
        user_message_id=user_message_id,
        assistant_message_id=final_assistant_id,
    )


async def run_agent_initiated_turn(
    *,
    pool: asyncpg.Pool,
    provider: Provider,
    model: str,
    user_id: UUID,
    agent_name: str,
    prompt_text: str,
    conversation_id: UUID | None = None,
    conversation_title: str | None = None,
    user_tz: str = "UTC",
    sent_at_utc: datetime | None = None,
    tool_registry: ToolRegistry | None = None,
    max_turn_cost_usd: float | None = None,
    user_email: str | None = None,
) -> AsyncIterator[AssistantChunk | TurnComplete]:
    """Drive a turn that an agent (cron behaviour, Sentry tick, plugin) initiates
    without an inbound user JWT.

    Resolves to the same :func:`run_turn` everything else uses,
    with one difference: the identity is synthetic (built via
    :meth:`Identity.synthetic_for_agent`) so the loop's RLS
    session-variable contract still holds. Tool handlers reading
    current_identity.get() see identity.aal == 'agent' and
    identity.raw_claims['agent_name'] so they can refuse paths
    that should only be open to real users (e.g. a tool that egresses
    user data needs explicit consent — agent-initiated calls don't
    have consent the user hasn't pre-granted).

    Conversation handling:

    - conversation_id given → land the turn under that
      conversation. Caller is responsible for choosing one the
      operator considers "agent log"-shaped.
    - conversation_id not given → create a fresh one with
      title = conversation_title or '[${agent_name}] tick'. The
      operator can rename it via the UI.

    user_email is optional — if known (e.g. the sentry plugin
    resolved it from `eidan.users`) it lands on the synthetic
    identity for completeness. Loop-side code uses the user_id;
    email is informational.
    """
    from .persistence import create_conversation

    identity = Identity.synthetic_for_agent(
        str(user_id),
        agent_name=agent_name,
        email=user_email,
    )

    if conversation_id is None:
        title = conversation_title or f"[{agent_name}] tick"
        async with acquire(pool, identity) as conn:
            conversation_id = await create_conversation(
                conn, user_id=user_id, title=title
            )

    ctx = TurnContext(
        identity=identity,
        conversation_id=conversation_id,
    )
    sent_at = sent_at_utc or datetime.now(tz=UTC)

    async for event in run_turn(
        pool=pool,
        provider=provider,
        model=model,
        ctx=ctx,
        user_text=prompt_text,
        sent_at_utc=sent_at,
        user_tz=user_tz,
        tool_registry=tool_registry,
        max_turn_cost_usd=max_turn_cost_usd,
    ):
        yield event
