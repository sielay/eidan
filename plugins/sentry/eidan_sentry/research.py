# SPDX-License-Identifier: AGPL-3.0-or-later
"""Sentry's governed research loop — #186 approach (a) / `docs/027`.

When ``EIDAN_SENTRY_RESEARCH_LOOP`` is on, a high-severity pattern
triggers a **bounded, governed** investigation instead of a single
turn: sentry spawns a sequence of agent turns in one conversation, each
building on the last, under a :class:`LoopGovernor` (iteration /
wall-clock / cost budget + no-progress detection). The loop stops when
the governor bails — budget reached, or the agent goes in circles — and
sentry records an escalation pointing the operator at the investigation
conversation.

Approach (a): no sufficiency critic yet (that's slice 2), so a step
never self-declares ``done`` — every loop ends by surfacing its findings
and the human is the "enough" judge. Model-agnostic: the turns run on
whatever ``EIDAN_SENTRY_MODEL`` the node provides (e.g. Ollama/phi3 on a
Pi). **Default-off** — multi-turn LLM costs real money.
"""

from __future__ import annotations

import hashlib
import logging
import os
from typing import Any
from uuid import UUID

import asyncpg
from eidan_backend.escalations import (
    Escalation,
    escalation_for_loop_stop,
    record_escalation,
)
from eidan_backend.loop import TurnComplete
from eidan_backend.loop_governor import (
    LoopBudget,
    LoopGovernor,
    StepResult,
    run_governed_loop,
)
from eidan_backend.persistence import cost_summary_for_turn, create_conversation
from eidan_backend.providers.base import AssistantChunk

from .patterns import DetectedPattern

logger = logging.getLogger(__name__)

DEFAULT_LOOP_MAX_ITERATIONS = 3
DEFAULT_LOOP_MAX_WALL_CLOCK_S = 300.0

# The agent ends its final message with this token when it has concluded
# (docs/027's slice-1 "agent declares done" completion signal). A step
# that carries it stops the loop cleanly — a conclusion, not a bail — so
# no escalation is raised. An independent second-voice critic that can
# overrule a premature/false DONE is the slice-2 refinement on top.
_DONE_TOKEN = "[DONE]"


def research_loop_enabled() -> bool:
    """Off by default; opt in via ``EIDAN_SENTRY_RESEARCH_LOOP=1``.
    Multi-turn LLM investigation costs real money — the operator
    chooses, the same way ``EIDAN_SENTRY_HIGH_INITIATES_TURN`` gates the
    single-turn path."""
    raw = os.environ.get("EIDAN_SENTRY_RESEARCH_LOOP", "0")
    return raw not in ("0", "false", "no", "")


def _int_env(name: str, default: int) -> int:
    try:
        return int(os.environ[name])
    except (KeyError, ValueError):
        return default


def _float_env(name: str, default: float | None) -> float | None:
    try:
        return float(os.environ[name])
    except (KeyError, ValueError):
        return default


def loop_budget() -> LoopBudget:
    return LoopBudget(
        max_iterations=_int_env(
            "EIDAN_SENTRY_LOOP_MAX_ITERATIONS", DEFAULT_LOOP_MAX_ITERATIONS
        ),
        max_wall_clock_s=_float_env(
            "EIDAN_SENTRY_LOOP_MAX_WALL_CLOCK_S", DEFAULT_LOOP_MAX_WALL_CLOCK_S
        ),
        max_cost_usd=_float_env("EIDAN_SENTRY_LOOP_MAX_COST_USD", None),
    )


async def _count_notes(conn: asyncpg.Connection, conversation_id: UUID) -> int:
    return (
        await conn.fetchval(
            "SELECT count(*) FROM eidan.notes "
            "WHERE conversation_id = $1 AND deleted_at IS NULL",
            conversation_id,
        )
        or 0
    )


def _research_prompt(pattern: DetectedPattern, step_index: int) -> str:
    done = (
        f" When you have concluded and recorded your findings/recommendation, "
        f"end your final message with the exact token {_DONE_TOKEN} and nothing "
        f"after it."
    )
    if step_index == 0:
        meta = " ".join(f"{k}={v}" for k, v in sorted(pattern.metadata.items()))
        return (
            "[sentry] Investigate this high-severity pattern and write a note "
            "with what you find. Use your tools.\n"
            f"Pattern: {pattern.name}\n"
            f"Details: {meta}" + done
        )
    return (
        "[sentry] Continue the investigation above. If you have concluded, "
        "write a brief note with your conclusion and recommended action." + done
    )


async def run_pattern_research(
    *,
    spawn_turn: Any,
    conn: asyncpg.Connection,
    user_id: UUID,
    pattern: DetectedPattern,
) -> None:
    """Run a bounded governed investigation of a high-severity pattern in
    one conversation, then escalate the outcome. Best-effort — never
    raises into the tick; the pattern's own escalation already captured
    the signal."""
    try:
        conv_id = await create_conversation(
            conn, user_id=user_id, title=f"[sentry] research: {pattern.name}"
        )
        governor = LoopGovernor(budget=loop_budget())

        async def step(i: int) -> StepResult:
            notes_before = await _count_notes(conn, conv_id)
            text_parts: list[str] = []
            anchor: UUID | None = None
            stream = spawn_turn(
                user_id=user_id,
                agent_name="sentry",
                prompt_text=_research_prompt(pattern, i),
                conversation_id=conv_id,
            )
            async for ev in stream:
                if isinstance(ev, AssistantChunk):
                    text_parts.append(ev.text)
                elif isinstance(ev, TurnComplete):
                    anchor = ev.user_message_id
            cost = 0.0
            if anchor is not None:
                summary = await cost_summary_for_turn(
                    conn, user_id=user_id, message_id=anchor
                )
                cost = float(summary.get("cost_usd") or 0.0)
            notes_after = await _count_notes(conn, conv_id)
            text = "".join(text_parts)
            fingerprint = hashlib.sha256(text.encode()).hexdigest()
            return StepResult(
                fingerprint=fingerprint,
                cost_usd=cost,
                produced_new_memory=notes_after > notes_before,
                done=_DONE_TOKEN in text,  # agent self-declared completion
                payload=anchor,
            )

        outcome = await run_governed_loop(governor=governor, step=step)
        if not outcome.bailed:
            # The agent concluded (stopped_by == "done") — a result, not a
            # blocker. The investigation conversation + notes are the
            # artifact; the pattern's own escalation already pinged the
            # operator, so don't raise a second, misleading one.
            logger.info(
                "[sentry] research loop for %s concluded after %d step(s)",
                pattern.name,
                outcome.steps,
            )
            return
        severity, reason = escalation_for_loop_stop(outcome.verdict.cause)
        await record_escalation(
            conn,
            escalation=Escalation(
                severity=severity,
                reason_class=reason,
                user_id=user_id,
                suggested_action=(
                    f"sentry investigated '{pattern.name}' over {outcome.steps} "
                    f"turn(s) and stopped "
                    f"({outcome.verdict.cause or outcome.stopped_by}); "
                    "review the investigation conversation."
                ),
                conversation_id=conv_id,
                metadata={
                    "pattern": pattern.name,
                    "stopped_by": outcome.stopped_by,
                    "cause": outcome.verdict.cause,
                    "steps": outcome.steps,
                },
            ),
        )
        logger.info(
            "[sentry] research loop for %s bailed after %d step(s): %s",
            pattern.name,
            outcome.steps,
            outcome.verdict.cause,
        )
    except Exception as exc:  # noqa: BLE001 — best-effort, never break the tick
        logger.info(
            "[sentry] research loop failed for pattern %s: %s", pattern.name, exc
        )
