"""Sentry tick body.

One tick walks every user with at least one non-deleted message in
``eidan.users`` (cheap, since this is single-operator today) and
runs the pattern detectors. Hits get persisted into
``plugin_sentry.sentry_ticks`` (one row per tick, summary metadata)
and ``plugin_sentry.sentry_nudges`` (one row per pattern, the
operator-facing artefact). High-severity hits also write an
:class:`eidan_backend.escalations.Escalation` so the inbox surfaces
them.

The tick is **deliberately idempotent at the (user, pattern_name,
day) grain** — re-running within the same day re-emits the same hit
unless the operator's state changed. That dedupe is enforced via a
unique index on the nudges table; an `ON CONFLICT DO NOTHING` write
absorbs the second insert.
"""

from __future__ import annotations

import json
import logging
import os
from datetime import UTC, date, datetime
from typing import Any
from uuid import UUID, uuid4

import asyncpg

from .patterns import (
    DEFAULT_IDLE_THRESHOLD_HOURS,
    DEFAULT_SCOPE_DRIFT_CEILING,
    DEFAULT_SCOPE_DRIFT_WINDOW_DAYS,
    DetectedPattern,
    run_all_detectors,
)
from .research import research_loop_enabled, run_pattern_research

logger = logging.getLogger(__name__)


def _is_enabled() -> bool:
    """Whether this node should run the sentry tick.

    The operator can always pin via ``EIDAN_SENTRY_ENABLED``. When
    unset, the default is node-type-aware:

    - Fly machines default to **off** — the tick is intended to call a
      model (``EIDAN_SENTRY_MODEL``) and the operator opts in
      explicitly there to avoid silent LLM cost on every Fly node.
      Detected via ``FLY_MACHINE_ID``, the same fingerprint the node
      identity detector uses (``eidan_backend.node_identity``).
    - Everywhere else (Pi, k8s, Heroku, local) defaults to **on**,
      matching the pre-#53 behaviour for long-lived nodes.
    """
    raw = os.environ.get("EIDAN_SENTRY_ENABLED")
    if raw is not None:
        return raw not in ("0", "false", "no", "")
    # Default: off on Fly, on elsewhere.
    if os.environ.get("FLY_MACHINE_ID"):
        return False
    return True


def _int_env(name: str, default: int) -> int:
    raw = os.environ.get(name)
    if not raw:
        return default
    try:
        return int(raw)
    except ValueError:
        return default


async def run_sentry_tick(
    pool: asyncpg.Pool,
    *,
    tick_id: str | None = None,
    notify: Any | None = None,
    spawn_turn: Any | None = None,
) -> dict[str, Any]:
    """Run one sentry tick across every user.

    Returns a summary dict with one entry per user (``user_id`` →
    list of detected pattern names). Used by tests; the production
    behaviour ignores the return value and relies on the persisted
    side-effects.

    ``notify`` is the host's ``ctx.notify`` callable when a channel
    adapter is configured (typically Telegram via the operator's
    ``TELEGRAM_BOT_TOKEN``). When provided, medium- and high-severity
    patterns get pushed out-of-band; the escalation still lands in
    the operator inbox as the durable record. ``None`` (no adapter
    configured) keeps the inbox-only behaviour.

    ``spawn_turn`` is the host's ``ctx.spawn_turn`` callable when a
    provider is wired. When provided AND
    ``EIDAN_SENTRY_HIGH_INITIATES_TURN`` is truthy, high-severity
    patterns also kick off an agent-initiated turn so the model can
    react in the conversation log (and trigger downstream
    behaviours) rather than only landing as an inbox row. The
    escalation is still written first as the durable audit trail.
    """
    if not _is_enabled():
        logger.info(
            "[sentry] disabled (EIDAN_SENTRY_ENABLED unset on Fly, or "
            "explicitly set to 0) — skipping tick"
        )
        return {}

    tick_id = tick_id or f"sentry-{datetime.now(tz=UTC).isoformat()}"
    idle_threshold = _int_env(
        "EIDAN_SENTRY_IDLE_THRESHOLD_HOURS", DEFAULT_IDLE_THRESHOLD_HOURS
    )
    scope_ceiling = _int_env(
        "EIDAN_SENTRY_SCOPE_DRIFT_CEILING", DEFAULT_SCOPE_DRIFT_CEILING
    )
    scope_window = _int_env(
        "EIDAN_SENTRY_SCOPE_DRIFT_WINDOW_DAYS",
        DEFAULT_SCOPE_DRIFT_WINDOW_DAYS,
    )

    summary: dict[str, list[str]] = {}
    async with pool.acquire() as conn:
        users = await _users_with_activity(conn)
        for user_id in users:
            patterns = await run_all_detectors(
                conn,
                user_id=user_id,
                idle_threshold_hours=idle_threshold,
                scope_drift_ceiling=scope_ceiling,
                scope_drift_window_days=scope_window,
            )
            await _persist_tick(
                conn,
                tick_id=tick_id,
                user_id=user_id,
                patterns=patterns,
            )
            for pattern in patterns:
                inserted = await _persist_nudge(
                    conn, user_id=user_id, pattern=pattern
                )
                if pattern.severity in ("medium", "high"):
                    await _emit_escalation(
                        conn, user_id=user_id, pattern=pattern
                    )
                    # The notify path fires only on the first emission
                    # of a pattern in a given (user, pattern, day);
                    # the unique-constraint return tells us whether
                    # this insert was the first. Operators don't want
                    # the same nudge re-delivered through the day.
                    if inserted and notify is not None:
                        await _try_notify(
                            conn,
                            notify=notify,
                            user_id=user_id,
                            pattern=pattern,
                        )
                    # High-severity escalation: when configured, also
                    # initiate an agent turn so the model can react
                    # in the conversation log. Same first-emission
                    # gate as notify — we don't want a re-tick to
                    # spawn the same turn twice in a day.
                    if (
                        inserted
                        and pattern.severity == "high"
                        and spawn_turn is not None
                        and _spawn_turn_enabled()
                    ):
                        # When the research loop is enabled, a high-severity
                        # pattern gets a bounded, governed multi-turn
                        # investigation (#186); otherwise the single-turn
                        # kickoff. Both gated by EIDAN_SENTRY_HIGH_INITIATES_TURN
                        # (cost) above.
                        if research_loop_enabled():
                            await run_pattern_research(
                                spawn_turn=spawn_turn,
                                conn=conn,
                                user_id=user_id,
                                pattern=pattern,
                            )
                        else:
                            await _try_spawn_turn(
                                spawn_turn=spawn_turn,
                                user_id=user_id,
                                pattern=pattern,
                            )
            summary[str(user_id)] = [p.name for p in patterns]
    return summary


def _spawn_turn_enabled() -> bool:
    """Off by default; the operator opts in via
    ``EIDAN_SENTRY_HIGH_INITIATES_TURN=1``.

    Default-off because spawning an agent turn costs real money and
    the operator should make an informed choice before high-severity
    patterns start billing through. The escalation row + Telegram
    nudge still surface every high-severity hit; this flag only
    decides whether the model also gets called.
    """
    raw = os.environ.get("EIDAN_SENTRY_HIGH_INITIATES_TURN", "0")
    return raw not in ("0", "false", "no", "")


async def _try_spawn_turn(
    *,
    spawn_turn: Any,
    user_id: UUID,
    pattern: DetectedPattern,
) -> None:
    """Best-effort agent-turn kickoff. Never raises — every failure
    becomes a log line, the escalation row already captured the
    pattern so the operator is not silently losing the signal.

    Drains the returned iterator so the turn completes (the loop
    persists messages eagerly, but ``TurnComplete`` is the signal
    that final-message metadata has been stamped — without
    draining, the turn could be left looking orphaned to the
    boot-time orphan-cleanup scan).
    """
    prompt = _format_spawn_prompt(pattern)
    try:
        stream = spawn_turn(
            user_id=user_id,
            agent_name="sentry",
            prompt_text=prompt,
            conversation_title=f"[sentry] {pattern.name}",
        )
        async for _ in stream:
            pass
    except Exception as exc:  # noqa: BLE001 — best-effort path
        logger.info(
            "[sentry] spawn_turn failed for pattern %s: %s",
            pattern.name,
            exc,
        )


def _format_spawn_prompt(pattern: DetectedPattern) -> str:
    """The system message the agent receives as the user-side prompt
    when Sentry initiates a turn. Pinned-tight format so the model
    knows it is reacting to a detector, not a human."""
    lines = [
        f"[sentry] high-severity pattern detected: {pattern.name}",
        "",
        pattern.summary,
    ]
    if pattern.metadata:
        lines.append("")
        lines.append("Detector metadata:")
        for key, value in sorted(pattern.metadata.items()):
            lines.append(f"  {key}: {value}")
    lines.append("")
    lines.append(
        "You were invoked by the sentry tick, not by the user. Decide "
        "whether this needs operator attention; if so, prepare a clear "
        "summary they will read in the conversation log. If not, "
        "acknowledge and stop."
    )
    return "\n".join(lines)


async def _users_with_activity(
    conn: asyncpg.Connection,
) -> list[UUID]:
    """Return every user_id with at least one message or event in
    core memory. Single-operator deployments return exactly one
    row; multi-operator runs walk everyone.
    """
    rows = await conn.fetch(
        """
        SELECT DISTINCT user_id FROM (
            SELECT user_id FROM eidan.messages WHERE deleted_at IS NULL
            UNION
            SELECT user_id FROM eidan.events WHERE deleted_at IS NULL
        ) AS active
        """
    )
    return [r["user_id"] for r in rows]


async def _persist_tick(
    conn: asyncpg.Connection,
    *,
    tick_id: str,
    user_id: UUID,
    patterns: list[DetectedPattern],
) -> None:
    """Write one row per sentry tick per user."""
    await conn.execute(
        """
        INSERT INTO plugin_sentry.sentry_ticks
            (id, tick_id, user_id, started_at, completed_at,
             pattern_names, escalations_queued)
        VALUES ($1, $2, $3, $4, $4, $5, $6)
        ON CONFLICT (tick_id, user_id) DO NOTHING
        """,
        uuid4(),
        tick_id,
        user_id,
        datetime.now(tz=UTC),
        [p.name for p in patterns],
        sum(1 for p in patterns if p.severity in ("medium", "high")),
    )


async def _persist_nudge(
    conn: asyncpg.Connection,
    *,
    user_id: UUID,
    pattern: DetectedPattern,
) -> bool:
    """Write the operator-facing nudge row.

    Dedupes at the ``(user_id, pattern_name, day)`` grain via the
    unique index on the table: re-emitting the same pattern on the
    same day is a no-op write. That keeps the operator inbox quiet
    when the underlying state hasn't changed.

    Returns ``True`` when the row was actually inserted (this
    pattern hadn't fired today yet), ``False`` when the ON CONFLICT
    branch fired. Callers use the flag to gate one-shot side
    effects like the Telegram nudge — we don't want to re-deliver
    the same out-of-band message multiple times a day.
    """
    row = await conn.fetchrow(
        """
        INSERT INTO plugin_sentry.sentry_nudges
            (id, user_id, pattern_name, day, severity, summary,
             evidence, metadata)
        VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb)
        ON CONFLICT (user_id, pattern_name, day) DO NOTHING
        RETURNING id
        """,
        uuid4(),
        user_id,
        pattern.name,
        date.today(),
        pattern.severity,
        pattern.summary,
        json.dumps(list(pattern.evidence)),
        json.dumps(pattern.metadata),
    )
    return row is not None


async def _emit_escalation(
    conn: asyncpg.Connection,
    *,
    user_id: UUID,
    pattern: DetectedPattern,
) -> None:
    """Write a row in ``eidan.escalations`` so the operator's inbox
    surfaces the pattern. Same dedupe semantics as the nudge: skip
    when an open escalation with this name + day already exists.
    """
    existing = await conn.fetchval(
        """
        SELECT 1 FROM eidan.escalations
        WHERE user_id = $1
          AND status = 'pending'
          AND metadata->>'pattern_name' = $2
          AND DATE(created_at) = $3
        LIMIT 1
        """,
        user_id,
        pattern.name,
        date.today(),
    )
    if existing:
        return

    await conn.execute(
        """
        INSERT INTO eidan.escalations
            (id, user_id, severity, reason_class, suggested_action,
             evidence, metadata)
        VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb)
        """,
        uuid4(),
        user_id,
        pattern.severity,
        pattern.reason_class,
        pattern.summary,
        json.dumps(list(pattern.evidence)),
        json.dumps({**pattern.metadata, "pattern_name": pattern.name, "source": "sentry"}),
    )


# Channel preference order. Sentry tries each in turn until one
# accepts the notification. The escalation row is the durable
# record either way; notify is a best-effort push that lets the
# operator hear about high-severity patterns without opening the
# inbox.
_NOTIFY_CHANNELS: tuple[str, ...] = ("telegram",)


async def _try_notify(
    conn: asyncpg.Connection,
    *,
    notify: Any,
    user_id: UUID,
    pattern: DetectedPattern,
) -> None:
    """Best-effort out-of-band nudge through the host's notify
    surface. Lands one ``plugin_sentry.sentry_nudges.sent_at`` stamp
    on success or one ``eidan.escalations`` follow-up on failure
    (so the operator sees "Sentry tried to telegram you about X but
    Telegram was down").

    The function never raises — every failure path is captured and
    surfaced as data the operator can read. The tick loop continues
    on to the next pattern.
    """
    text = _format_notify_text(pattern)
    last_error: str | None = None
    for channel in _NOTIFY_CHANNELS:
        try:
            await notify(
                channel,
                text,
                user_id=user_id,
                metadata={
                    "pattern_name": pattern.name,
                    "severity": pattern.severity,
                    "source": "sentry",
                },
            )
        except Exception as exc:  # noqa: BLE001 — best-effort path
            last_error = f"{channel}: {exc}"
            logger.info(
                "[sentry] notify via %s failed for pattern %s: %s",
                channel,
                pattern.name,
                exc,
            )
            continue
        # Delivered — stamp the row so the operator inbox shows
        # "delivered" status.
        await conn.execute(
            """
            UPDATE plugin_sentry.sentry_nudges
            SET sent_at = $4
            WHERE user_id = $1
              AND pattern_name = $2
              AND day = $3
              AND sent_at IS NULL
            """,
            user_id,
            pattern.name,
            date.today(),
            datetime.now(tz=UTC),
        )
        return

    # Every channel raised. Write a follow-up escalation so the
    # operator sees the missed nudge — this is the audit §10
    # safety net: "Sentry tried to telegram you and Telegram was
    # down."
    if last_error is not None:
        await conn.execute(
            """
            INSERT INTO eidan.escalations
                (id, user_id, severity, reason_class, suggested_action,
                 evidence, metadata)
            VALUES ($1, $2, 'low', 'external_failure', $3,
                    $4::jsonb, $5::jsonb)
            """,
            uuid4(),
            user_id,
            (
                f"Sentry tried to nudge you about {pattern.name!r} but "
                f"the configured notify channel failed: {last_error}. "
                "Check your notification credentials."
            ),
            json.dumps([f"sentry-nudge:{pattern.name}"]),
            json.dumps(
                {
                    "source": "sentry",
                    "pattern_name": pattern.name,
                    "kind": "notify_failure",
                    "channel_error": last_error,
                }
            ),
        )


def _format_notify_text(pattern: DetectedPattern) -> str:
    """Channel-agnostic message format. Telegram caps at 4096 chars;
    keep it tight."""
    parts = [
        f"[sentry/{pattern.severity}] {pattern.name}",
        pattern.summary,
    ]
    return "\n\n".join(p for p in parts if p)[:1500]


__all__ = ["run_sentry_tick"]
