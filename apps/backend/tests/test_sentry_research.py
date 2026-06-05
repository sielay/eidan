# SPDX-License-Identifier: AGPL-3.0-or-later
"""Sentry governed research loop (#186 approach (a)).

A high-severity pattern (with the loop enabled) drives a bounded,
governed multi-turn investigation in one conversation, then escalates
the outcome. DB-backed (the `eidan_db` fixture) with a fake spawn_turn —
"Ollama-driven" is just the model passed through, so the loop logic is
exercised without a real model.
"""

from __future__ import annotations

import importlib
import importlib.util
import sys
from pathlib import Path
from uuid import UUID, uuid4

import pytest
from eidan_backend.db import create_pool
from eidan_backend.loop import TurnComplete
from eidan_backend.persistence import upsert_user
from eidan_backend.providers.base import AssistantChunk
from eidan_backend.sufficiency import SufficiencyVerdict

from .conftest import build_identity


def _fake_assess(*, sufficient: bool):
    """A stand-in for ctx.assess_sufficiency that always returns the given
    verdict — lets a DB test drive the loop's done decision deterministically."""

    async def _assess(*, goal: str, gathered: str) -> SufficiencyVerdict:
        return SufficiencyVerdict(sufficient=sufficient, reason="test")

    return _assess

_REPO_ROOT = Path(__file__).resolve().parents[3]
_SENTRY_DIR = _REPO_ROOT / "plugins" / "sentry" / "eidan_sentry"


def _load_sentry():
    package = "eidan_sentry"
    if package not in sys.modules:
        spec = importlib.util.spec_from_file_location(
            package,
            _SENTRY_DIR / "__init__.py",
            submodule_search_locations=[str(_SENTRY_DIR)],
        )
        assert spec is not None and spec.loader is not None
        module = importlib.util.module_from_spec(spec)
        sys.modules[package] = module
        spec.loader.exec_module(module)
    return (
        importlib.import_module("eidan_sentry.research"),
        importlib.import_module("eidan_sentry.patterns"),
    )


def _fake_spawn_turn(*, texts):
    """A spawn_turn matching the bootstrap callable's shape that replays
    `texts` one per call, yielding a chunk + a TurnComplete each time."""
    calls = {"n": 0}

    def _spawn(*, user_id, agent_name, prompt_text, conversation_id=None,
               conversation_title=None):
        i = calls["n"]
        calls["n"] += 1
        text = texts[min(i, len(texts) - 1)]

        async def _gen():
            yield AssistantChunk(text=text)
            yield TurnComplete(
                user_message_id=uuid4(),
                assistant_message_id=uuid4(),
                iterations=1,
            )

        return _gen()

    return _spawn


async def _escalations_for(pool, user_id):
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            "SELECT reason_class, conversation_id, metadata "
            "FROM eidan.escalations WHERE user_id = $1",
            user_id,
        )
    return [dict(r) for r in rows]


@pytest.mark.asyncio
async def test_research_loop_bails_on_no_progress(eidan_db, monkeypatch) -> None:
    """Same intent every turn + no new notes → the no-progress detector
    fires; sentry escalates with reason no_progress, pointing at the
    investigation conversation."""
    research, patterns = _load_sentry()
    # Headroom on iterations so the *repeat* detector (3 identical) trips
    # before the iteration cap.
    monkeypatch.setenv("EIDAN_SENTRY_LOOP_MAX_ITERATIONS", "10")

    identity = build_identity()
    user_id = UUID(identity.user_id)
    pattern = patterns.DetectedPattern(
        name="idle_too_long",
        severity="high",
        reason_class="over_capacity",
        summary="no activity in 72h",
        metadata={"hours": "72"},
    )

    pool = await create_pool(eidan_db)
    try:
        async with pool.acquire() as conn:
            await upsert_user(conn, user_id=user_id, email=identity.email)
            await research.run_pattern_research(
                spawn_turn=_fake_spawn_turn(texts=["same finding"]),
                conn=conn,
                user_id=user_id,
                pattern=pattern,
            )
        esc = await _escalations_for(pool, user_id)
        assert len(esc) == 1
        assert esc[0]["reason_class"] == "no_progress"
        assert esc[0]["conversation_id"] is not None
    finally:
        await pool.close()


@pytest.mark.asyncio
async def test_research_loop_bails_on_iteration_budget(eidan_db, monkeypatch) -> None:
    """Distinct findings each turn (always 'progressing') → the loop runs
    to its iteration budget and escalates over_capacity."""
    research, patterns = _load_sentry()
    monkeypatch.setenv("EIDAN_SENTRY_LOOP_MAX_ITERATIONS", "2")

    identity = build_identity()
    user_id = UUID(identity.user_id)
    pattern = patterns.DetectedPattern(
        name="overdue_events",
        severity="high",
        reason_class="over_capacity",
        summary="3 overdue",
        metadata={},
    )

    pool = await create_pool(eidan_db)
    try:
        async with pool.acquire() as conn:
            await upsert_user(conn, user_id=user_id, email=identity.email)
            await research.run_pattern_research(
                spawn_turn=_fake_spawn_turn(texts=["a", "b", "c", "d"]),
                conn=conn,
                user_id=user_id,
                pattern=pattern,
            )
        esc = await _escalations_for(pool, user_id)
        assert len(esc) == 1
        assert esc[0]["reason_class"] == "over_capacity"
        assert esc[0]["metadata"]  # carries pattern / steps
    finally:
        await pool.close()


@pytest.mark.asyncio
async def test_research_loop_concludes_without_escalating(eidan_db, monkeypatch) -> None:
    """When the agent self-declares done ([DONE]) the loop stops cleanly —
    a conclusion, not a bail — so NO escalation is raised (the pattern's
    own escalation already pinged the operator)."""
    research, patterns = _load_sentry()
    monkeypatch.setenv("EIDAN_SENTRY_LOOP_MAX_ITERATIONS", "10")

    identity = build_identity()
    user_id = UUID(identity.user_id)
    pattern = patterns.DetectedPattern(
        name="scope_drift",
        severity="high",
        reason_class="over_capacity",
        summary="overcommitted",
        metadata={},
    )

    pool = await create_pool(eidan_db)
    try:
        async with pool.acquire() as conn:
            await upsert_user(conn, user_id=user_id, email=identity.email)
            await research.run_pattern_research(
                # First turn looks; second turn concludes with the token.
                spawn_turn=_fake_spawn_turn(
                    texts=["looking into it", "here is my conclusion [DONE]"]
                ),
                conn=conn,
                user_id=user_id,
                pattern=pattern,
            )
        esc = await _escalations_for(pool, user_id)
        assert esc == [], "a concluded investigation must not escalate"
        # but the investigation conversation was still created
        async with pool.acquire() as conn:
            convs = await conn.fetchval(
                "SELECT count(*) FROM eidan.conversations WHERE user_id = $1",
                user_id,
            )
        assert convs == 1
    finally:
        await pool.close()


@pytest.mark.asyncio
async def test_research_loop_critic_concludes(eidan_db, monkeypatch) -> None:
    """With the independent critic wired and saying SUFFICIENT, the loop
    concludes (no escalation) regardless of the agent's own text."""
    research, patterns = _load_sentry()
    monkeypatch.setenv("EIDAN_SENTRY_LOOP_MAX_ITERATIONS", "10")

    identity = build_identity()
    user_id = UUID(identity.user_id)
    pattern = patterns.DetectedPattern(
        name="overdue_events", severity="high", reason_class="over_capacity",
        summary="2 overdue", metadata={},
    )
    pool = await create_pool(eidan_db)
    try:
        async with pool.acquire() as conn:
            await upsert_user(conn, user_id=user_id, email=identity.email)
            await research.run_pattern_research(
                spawn_turn=_fake_spawn_turn(texts=["investigating"]),
                conn=conn,
                user_id=user_id,
                pattern=pattern,
                assess=_fake_assess(sufficient=True),
            )
        assert await _escalations_for(pool, user_id) == []
    finally:
        await pool.close()


@pytest.mark.asyncio
async def test_research_loop_critic_overrules_done_token(eidan_db, monkeypatch) -> None:
    """The agent emits [DONE], but the independent critic says CONTINUE —
    the critic wins, so the loop keeps going and ultimately bails on
    budget and escalates. Proves the second voice can overrule a
    premature/false self-declaration."""
    research, patterns = _load_sentry()
    monkeypatch.setenv("EIDAN_SENTRY_LOOP_MAX_ITERATIONS", "2")

    identity = build_identity()
    user_id = UUID(identity.user_id)
    pattern = patterns.DetectedPattern(
        name="idle_too_long", severity="high", reason_class="over_capacity",
        summary="quiet", metadata={},
    )
    pool = await create_pool(eidan_db)
    try:
        async with pool.acquire() as conn:
            await upsert_user(conn, user_id=user_id, email=identity.email)
            await research.run_pattern_research(
                # Each turn falsely claims done — the critic overrules.
                spawn_turn=_fake_spawn_turn(texts=["all good [DONE]"]),
                conn=conn,
                user_id=user_id,
                pattern=pattern,
                assess=_fake_assess(sufficient=False),
            )
        esc = await _escalations_for(pool, user_id)
        assert len(esc) == 1
        assert esc[0]["reason_class"] == "over_capacity"
    finally:
        await pool.close()
