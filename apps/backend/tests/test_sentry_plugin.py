"""Sentry plugin tests (audit note #10).

Phase 1 covers the deterministic detectors + the loop body that
persists tick rows and emits escalations. The schedule-trigger
wiring (cron + advisory locks) is shared infrastructure tested in
``test_behaviours.py``; this file focuses on Sentry's own logic.

The plugin's Python package isn't part of the backend package, so
the test imports it via ``importlib.util.spec_from_file_location``
— same pattern the example-behaviour smoke test already uses.
"""

from __future__ import annotations

import importlib.util
import sys
from datetime import UTC, datetime, timedelta
from pathlib import Path
from uuid import UUID, uuid4

import pytest
from eidan_backend.db import create_pool
from eidan_backend.persistence import upsert_user

from .conftest import build_identity

_REPO_ROOT = Path(__file__).resolve().parents[3]
_SENTRY_DIR = _REPO_ROOT / "plugins" / "sentry" / "eidan_sentry"


def _load_sentry_package():
    """Import ``eidan_sentry`` from the plugin directory as a top-level
    package without installing it into the venv. Mirrors the pattern
    in ``test_behaviours._load_example_plugin``."""
    package = "eidan_sentry"
    if package in sys.modules:
        return sys.modules[package]
    spec = importlib.util.spec_from_file_location(
        package,
        _SENTRY_DIR / "__init__.py",
        submodule_search_locations=[str(_SENTRY_DIR)],
    )
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[package] = module
    spec.loader.exec_module(module)
    from importlib import import_module

    import_module("eidan_sentry.patterns")
    import_module("eidan_sentry.loop")
    import_module("eidan_sentry.plugin")
    return module


async def _seed_user(pool, identity) -> UUID:
    user_uuid = UUID(identity.user_id)
    async with pool.acquire() as conn:
        async with conn.transaction():
            await upsert_user(
                conn, user_id=user_uuid, email=identity.email
            )
    return user_uuid


async def _create_plugin_schema(pool) -> None:
    """Sentry's tables live under ``plugin_sentry``. The plugin
    migration runner creates the schema in production; tests stand
    it up by hand against the eidan_db fixture."""
    async with pool.acquire() as conn:
        await conn.execute("CREATE SCHEMA IF NOT EXISTS plugin_sentry")
        # Run the migration body manually (without alembic) so the
        # test can exercise the loop without invoking the full
        # migration runner. The shape mirrors the migration file.
        await conn.execute(
            """
            CREATE TABLE IF NOT EXISTS plugin_sentry.sentry_ticks (
                id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
                tick_id              text NOT NULL,
                user_id              uuid NOT NULL,
                started_at           timestamptz NOT NULL,
                completed_at         timestamptz NOT NULL,
                pattern_names        text[] NOT NULL DEFAULT '{}',
                escalations_queued   integer NOT NULL DEFAULT 0,
                UNIQUE (tick_id, user_id)
            )
            """
        )
        await conn.execute(
            """
            CREATE TABLE IF NOT EXISTS plugin_sentry.sentry_nudges (
                id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
                user_id         uuid NOT NULL,
                pattern_name    text NOT NULL,
                day             date NOT NULL,
                severity        text NOT NULL,
                summary         text NOT NULL,
                evidence        jsonb NOT NULL DEFAULT '[]'::jsonb,
                metadata        jsonb NOT NULL DEFAULT '{}'::jsonb,
                sent_at         timestamptz,
                dismissed_at    timestamptz,
                created_at      timestamptz NOT NULL DEFAULT now(),
                CONSTRAINT sentry_nudges_severity_chk
                  CHECK (severity IN ('low','medium','high')),
                CONSTRAINT sentry_nudges_unique_per_day
                  UNIQUE (user_id, pattern_name, day)
            )
            """
        )


# ---- detectors ----------------------------------------------------------


@pytest.mark.asyncio
async def test_detect_overdue_events_fires_per_event(eidan_db: str) -> None:
    _load_sentry_package()
    from eidan_sentry.patterns import detect_overdue_events

    identity = build_identity()
    pool = await create_pool(eidan_db)
    try:
        user_uuid = await _seed_user(pool, identity)
        async with pool.acquire() as conn:
            await conn.execute(
                """
                INSERT INTO eidan.events (id, user_id, type, title, due_at, status)
                VALUES
                  ($1, $2, 'reminder', 'past-A', NOW() - INTERVAL '1 day', 'pending'),
                  ($3, $2, 'reminder', 'past-B', NOW() - INTERVAL '2 hours', 'pending'),
                  ($4, $2, 'reminder', 'future', NOW() + INTERVAL '1 hour', 'pending')
                """,
                uuid4(),
                user_uuid,
                uuid4(),
                uuid4(),
            )
            patterns = await detect_overdue_events(conn, user_id=user_uuid)

        titles = [p.metadata.get("type") + ":" + (p.summary.split("'")[1]) for p in patterns]
        assert len(patterns) == 2
        assert all(p.severity == "medium" for p in patterns)
        assert all(p.reason_class == "missing_input" for p in patterns)
        assert "past-A" in titles[0] or "past-A" in titles[1]
        assert "past-B" in titles[0] or "past-B" in titles[1]
    finally:
        await pool.close()


@pytest.mark.asyncio
async def test_detect_idle_too_long(eidan_db: str) -> None:
    _load_sentry_package()
    from eidan_sentry.patterns import detect_idle_too_long

    identity = build_identity()
    pool = await create_pool(eidan_db)
    try:
        user_uuid = await _seed_user(pool, identity)
        # Insert a conversation and a stale user message
        conv_id = uuid4()
        async with pool.acquire() as conn:
            await conn.execute(
                "INSERT INTO eidan.conversations (id, user_id) VALUES ($1, $2)",
                conv_id,
                user_uuid,
            )
            await conn.execute(
                """
                INSERT INTO eidan.messages
                    (id, user_id, conversation_id, role, content, created_at)
                VALUES ($1, $2, $3, 'user', 'old', $4)
                """,
                uuid4(),
                user_uuid,
                conv_id,
                datetime.now(tz=UTC) - timedelta(hours=72),
            )

            patterns = await detect_idle_too_long(
                conn, user_id=user_uuid, threshold_hours=48
            )
        assert len(patterns) == 1
        assert patterns[0].name == "idle_too_long"
        assert patterns[0].severity == "low"

        # Now post a fresh message — detector should silence.
        async with pool.acquire() as conn:
            await conn.execute(
                """
                INSERT INTO eidan.messages
                    (id, user_id, conversation_id, role, content)
                VALUES ($1, $2, $3, 'user', 'fresh')
                """,
                uuid4(),
                user_uuid,
                conv_id,
            )
            patterns2 = await detect_idle_too_long(
                conn, user_id=user_uuid, threshold_hours=48
            )
        assert patterns2 == []
    finally:
        await pool.close()


@pytest.mark.asyncio
async def test_detect_scope_drift(eidan_db: str) -> None:
    _load_sentry_package()
    from eidan_sentry.patterns import detect_scope_drift

    identity = build_identity()
    pool = await create_pool(eidan_db)
    try:
        user_uuid = await _seed_user(pool, identity)
        async with pool.acquire() as conn:
            for i in range(10):
                await conn.execute(
                    """
                    INSERT INTO eidan.events
                        (id, user_id, type, title, due_at, status)
                    VALUES
                        ($1, $2, 'reminder', $3,
                         NOW() + INTERVAL '1 day' + ($4 || ' minutes')::interval,
                         'pending')
                    """,
                    uuid4(),
                    user_uuid,
                    f"event-{i}",
                    str(i),
                )

            patterns = await detect_scope_drift(
                conn, user_id=user_uuid, ceiling=7, window_days=30
            )
        assert len(patterns) == 1
        assert patterns[0].name == "scope_drift"
        assert patterns[0].metadata["pending_count"] == 10
    finally:
        await pool.close()


# ---- end-to-end tick ----------------------------------------------------


@pytest.mark.asyncio
async def test_run_sentry_tick_persists_and_escalates(eidan_db: str) -> None:
    """One overdue event lands a tick row, a nudge row, and an
    eidan.escalations row (because overdue_event is severity=medium).
    """
    _load_sentry_package()
    from eidan_sentry.loop import run_sentry_tick

    identity = build_identity()
    pool = await create_pool(eidan_db)
    try:
        await _create_plugin_schema(pool)
        user_uuid = await _seed_user(pool, identity)
        event_id = uuid4()
        async with pool.acquire() as conn:
            await conn.execute(
                """
                INSERT INTO eidan.events (id, user_id, type, title, due_at, status)
                VALUES ($1, $2, 'reminder', 'past-due', NOW() - INTERVAL '1 day', 'pending')
                """,
                event_id,
                user_uuid,
            )

        summary = await run_sentry_tick(pool, tick_id="test-tick-1")
        assert summary[str(user_uuid)] == ["overdue_event"]

        async with pool.acquire() as conn:
            tick_count = await conn.fetchval(
                "SELECT COUNT(*) FROM plugin_sentry.sentry_ticks WHERE user_id = $1",
                user_uuid,
            )
            nudge_count = await conn.fetchval(
                "SELECT COUNT(*) FROM plugin_sentry.sentry_nudges WHERE user_id = $1",
                user_uuid,
            )
            esc_count = await conn.fetchval(
                """
                SELECT COUNT(*) FROM eidan.escalations
                WHERE user_id = $1 AND metadata->>'source' = 'sentry'
                """,
                user_uuid,
            )
        assert tick_count == 1
        assert nudge_count == 1
        assert esc_count == 1
    finally:
        await pool.close()


@pytest.mark.asyncio
async def test_run_sentry_tick_dedupes_per_day(eidan_db: str) -> None:
    """Running the tick twice in the same day with the same state
    produces one nudge row (unique constraint) and one escalation
    (the loop's pre-flight check). The second tick's row still lands
    on sentry_ticks (different tick_id)."""
    _load_sentry_package()
    from eidan_sentry.loop import run_sentry_tick

    identity = build_identity()
    pool = await create_pool(eidan_db)
    try:
        await _create_plugin_schema(pool)
        user_uuid = await _seed_user(pool, identity)
        async with pool.acquire() as conn:
            await conn.execute(
                """
                INSERT INTO eidan.events (id, user_id, type, title, due_at, status)
                VALUES ($1, $2, 'reminder', 'past-due', NOW() - INTERVAL '1 day', 'pending')
                """,
                uuid4(),
                user_uuid,
            )

        await run_sentry_tick(pool, tick_id="test-tick-A")
        await run_sentry_tick(pool, tick_id="test-tick-B")

        async with pool.acquire() as conn:
            tick_count = await conn.fetchval(
                "SELECT COUNT(*) FROM plugin_sentry.sentry_ticks WHERE user_id = $1",
                user_uuid,
            )
            nudge_count = await conn.fetchval(
                "SELECT COUNT(*) FROM plugin_sentry.sentry_nudges WHERE user_id = $1",
                user_uuid,
            )
            esc_count = await conn.fetchval(
                """
                SELECT COUNT(*) FROM eidan.escalations
                WHERE user_id = $1 AND metadata->>'source' = 'sentry'
                """,
                user_uuid,
            )
        assert tick_count == 2  # two distinct tick_ids
        assert nudge_count == 1  # deduped by (user, pattern, day)
        assert esc_count == 1    # deduped by the pre-flight check
    finally:
        await pool.close()


@pytest.mark.asyncio
async def test_sentry_disabled_skips_tick(
    eidan_db: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    """EIDAN_SENTRY_ENABLED=0 returns an empty summary without
    touching the DB. Lets operators silence the tick in tests / CI."""
    _load_sentry_package()
    from eidan_sentry.loop import run_sentry_tick

    monkeypatch.setenv("EIDAN_SENTRY_ENABLED", "0")
    pool = await create_pool(eidan_db)
    try:
        summary = await run_sentry_tick(pool, tick_id="skip-1")
        assert summary == {}
    finally:
        await pool.close()


def test_is_enabled_defaults_off_on_fly(monkeypatch: pytest.MonkeyPatch) -> None:
    """Issue #53: with EIDAN_SENTRY_ENABLED unset, Fly machines
    (detected via FLY_MACHINE_ID) default to off so the 5-minute
    tick doesn't burn LLM cost the operator didn't opt into."""
    _load_sentry_package()
    from eidan_sentry.loop import _is_enabled

    monkeypatch.delenv("EIDAN_SENTRY_ENABLED", raising=False)
    monkeypatch.setenv("FLY_MACHINE_ID", "1234abcd")
    assert _is_enabled() is False


def test_is_enabled_defaults_on_elsewhere(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """With no env signals, the default is on — matches the
    pre-#53 behaviour for Pi / k8s / Heroku / local nodes."""
    _load_sentry_package()
    from eidan_sentry.loop import _is_enabled

    monkeypatch.delenv("EIDAN_SENTRY_ENABLED", raising=False)
    monkeypatch.delenv("FLY_MACHINE_ID", raising=False)
    assert _is_enabled() is True


def test_is_enabled_explicit_pin_overrides_fly_default(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Operator pin wins on Fly — an explicit ``EIDAN_SENTRY_ENABLED=1``
    opts the machine in even when the auto-default would be off."""
    _load_sentry_package()
    from eidan_sentry.loop import _is_enabled

    monkeypatch.setenv("FLY_MACHINE_ID", "1234abcd")
    monkeypatch.setenv("EIDAN_SENTRY_ENABLED", "1")
    assert _is_enabled() is True


@pytest.mark.asyncio
async def test_notify_called_for_medium_severity(eidan_db: str) -> None:
    """When a medium- or high-severity pattern fires AND a notify
    callable is wired, the loop pushes the nudge out-of-band and
    stamps sent_at on the row. The escalation still lands in the
    inbox as the durable record."""
    _load_sentry_package()
    from eidan_sentry.loop import run_sentry_tick

    identity = build_identity()
    pool = await create_pool(eidan_db)
    try:
        await _create_plugin_schema(pool)
        user_uuid = await _seed_user(pool, identity)
        async with pool.acquire() as conn:
            await conn.execute(
                """
                INSERT INTO eidan.events (id, user_id, type, title, due_at, status)
                VALUES ($1, $2, 'reminder', 'past-due', NOW() - INTERVAL '1 day', 'pending')
                """,
                uuid4(),
                user_uuid,
            )

        captured: list[tuple[str, str, dict]] = []

        async def fake_notify(
            channel: str,
            text: str,
            *,
            user_id=None,
            metadata=None,
        ):
            captured.append((channel, text, metadata or {}))

        await run_sentry_tick(pool, tick_id="notify-1", notify=fake_notify)

        assert len(captured) == 1
        channel, text, meta = captured[0]
        assert channel == "telegram"
        assert "overdue_event" in text
        assert meta["pattern_name"] == "overdue_event"
        assert meta["severity"] == "medium"

        async with pool.acquire() as conn:
            sent_at = await conn.fetchval(
                """
                SELECT sent_at FROM plugin_sentry.sentry_nudges
                WHERE user_id = $1 AND pattern_name = 'overdue_event'
                """,
                user_uuid,
            )
        assert sent_at is not None
    finally:
        await pool.close()


@pytest.mark.asyncio
async def test_notify_not_called_for_low_severity(eidan_db: str) -> None:
    """Low-severity patterns (idle_too_long, scope_drift) stay in
    the inbox only — they don't earn an out-of-band nudge. The
    `notify` callable should not be invoked for them."""
    _load_sentry_package()
    from eidan_sentry.loop import run_sentry_tick

    identity = build_identity()
    pool = await create_pool(eidan_db)
    try:
        await _create_plugin_schema(pool)
        user_uuid = await _seed_user(pool, identity)
        # Idle for > 48h via a stale user message
        conv_id = uuid4()
        async with pool.acquire() as conn:
            await conn.execute(
                "INSERT INTO eidan.conversations (id, user_id) VALUES ($1, $2)",
                conv_id,
                user_uuid,
            )
            await conn.execute(
                """
                INSERT INTO eidan.messages
                  (id, user_id, conversation_id, role, content, created_at)
                VALUES ($1, $2, $3, 'user', 'old', NOW() - INTERVAL '5 days')
                """,
                uuid4(),
                user_uuid,
                conv_id,
            )

        captured: list = []

        async def fake_notify(
            channel: str, text: str, *, user_id=None, metadata=None
        ):
            captured.append((channel, text))

        await run_sentry_tick(pool, tick_id="notify-low", notify=fake_notify)

        # idle_too_long is the pattern that should fire; severity=low,
        # so notify must NOT have been called.
        assert captured == []
    finally:
        await pool.close()


@pytest.mark.asyncio
async def test_notify_failure_lands_followup_escalation(
    eidan_db: str,
) -> None:
    """When notify raises, the loop writes a low-severity
    `external_failure` escalation so the operator sees the missed
    nudge."""
    _load_sentry_package()
    from eidan_sentry.loop import run_sentry_tick

    identity = build_identity()
    pool = await create_pool(eidan_db)
    try:
        await _create_plugin_schema(pool)
        user_uuid = await _seed_user(pool, identity)
        async with pool.acquire() as conn:
            await conn.execute(
                """
                INSERT INTO eidan.events (id, user_id, type, title, due_at, status)
                VALUES ($1, $2, 'reminder', 'past-due', NOW() - INTERVAL '1 day', 'pending')
                """,
                uuid4(),
                user_uuid,
            )

        async def failing_notify(
            channel: str, text: str, *, user_id=None, metadata=None
        ):
            raise RuntimeError("telegram api down")

        await run_sentry_tick(
            pool, tick_id="notify-fail", notify=failing_notify
        )

        async with pool.acquire() as conn:
            failure_count = await conn.fetchval(
                """
                SELECT COUNT(*) FROM eidan.escalations
                WHERE user_id = $1
                  AND reason_class = 'external_failure'
                  AND metadata->>'kind' = 'notify_failure'
                """,
                user_uuid,
            )
            # Count only the original pattern escalation; the
            # notify-failure follow-up *also* carries pattern_name +
            # source=sentry in its metadata, so the query needs to
            # exclude rows tagged with the notify_failure ``kind``.
            pattern_count = await conn.fetchval(
                """
                SELECT COUNT(*) FROM eidan.escalations
                WHERE user_id = $1
                  AND metadata->>'pattern_name' = 'overdue_event'
                  AND metadata->>'source' = 'sentry'
                  AND COALESCE(metadata->>'kind', '') <> 'notify_failure'
                """,
                user_uuid,
            )
            sent_at = await conn.fetchval(
                """
                SELECT sent_at FROM plugin_sentry.sentry_nudges
                WHERE user_id = $1 AND pattern_name = 'overdue_event'
                """,
                user_uuid,
            )
        # Both: the original pattern escalation AND the
        # notify-failure follow-up.
        assert pattern_count == 1
        assert failure_count == 1
        # sent_at stays NULL because the notify never succeeded.
        assert sent_at is None
    finally:
        await pool.close()


@pytest.mark.asyncio
async def test_spawn_turn_invoked_for_high_severity_when_enabled(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """`docs/022 §4` / audit nice-to-have: high-severity patterns
    also kick off an agent-initiated turn when the operator opts in
    via ``EIDAN_SENTRY_HIGH_INITIATES_TURN=1``. Off by default so
    operators don't get billed for surprise model calls.

    Unit test only — no DB needed. We invoke the helper directly
    with a fake pattern + fake spawn_turn callable and assert the
    bind through is shaped the way ``run_agent_initiated_turn``
    expects.
    """
    _load_sentry_package()
    from eidan_sentry.loop import _try_spawn_turn
    from eidan_sentry.patterns import DetectedPattern

    pattern = DetectedPattern(
        name="hot_pattern",
        severity="high",
        reason_class="unrecoverable_error",
        summary="something needs attention now",
        evidence=("trace:1",),
        metadata={"count": 9},
    )

    received: list[dict] = []

    async def fake_stream():
        # Drain-loop body — the helper iterates this until exhaustion.
        for _ in range(0):
            yield {}

    def fake_spawn_turn(**kwargs):
        received.append(kwargs)
        return fake_stream()

    user_uuid = uuid4()
    await _try_spawn_turn(
        spawn_turn=fake_spawn_turn,
        user_id=user_uuid,
        pattern=pattern,
    )

    assert len(received) == 1
    call = received[0]
    assert call["user_id"] == user_uuid
    assert call["agent_name"] == "sentry"
    assert "hot_pattern" in call["prompt_text"]
    assert "something needs attention now" in call["prompt_text"]
    assert "count: 9" in call["prompt_text"]
    assert call["conversation_title"] == "[sentry] hot_pattern"


@pytest.mark.asyncio
async def test_spawn_turn_swallows_provider_errors() -> None:
    """A misbehaving provider must not bring down the tick — the
    escalation row already captured the signal, the spawned turn is
    the bonus path."""
    _load_sentry_package()
    from eidan_sentry.loop import _try_spawn_turn
    from eidan_sentry.patterns import DetectedPattern

    pattern = DetectedPattern(
        name="hot",
        severity="high",
        reason_class="external_failure",
        summary="x",
    )

    def boom(**kwargs):
        raise RuntimeError("provider unreachable")

    # Should not raise.
    await _try_spawn_turn(
        spawn_turn=boom,
        user_id=uuid4(),
        pattern=pattern,
    )


@pytest.mark.asyncio
async def test_notify_dedupe_skips_already_nudged_today(
    eidan_db: str,
) -> None:
    """Second tick same day → the nudge row was already inserted
    (and notified) on the first; the unique constraint blocks the
    second insert, so `inserted` returns False, so the second
    notify is suppressed. Operators get one nudge per pattern per
    day, not one per tick."""
    _load_sentry_package()
    from eidan_sentry.loop import run_sentry_tick

    identity = build_identity()
    pool = await create_pool(eidan_db)
    try:
        await _create_plugin_schema(pool)
        user_uuid = await _seed_user(pool, identity)
        async with pool.acquire() as conn:
            await conn.execute(
                """
                INSERT INTO eidan.events (id, user_id, type, title, due_at, status)
                VALUES ($1, $2, 'reminder', 'past-due', NOW() - INTERVAL '1 day', 'pending')
                """,
                uuid4(),
                user_uuid,
            )

        captured: list = []

        async def fake_notify(
            channel: str, text: str, *, user_id=None, metadata=None
        ):
            captured.append(channel)

        await run_sentry_tick(pool, tick_id="dedupe-A", notify=fake_notify)
        await run_sentry_tick(pool, tick_id="dedupe-B", notify=fake_notify)
        # First tick nudges; second tick's `_persist_nudge` returns
        # False from the ON CONFLICT branch, so notify is not
        # called again.
        assert captured == ["telegram"]
    finally:
        await pool.close()
