"""Deterministic pattern detectors for the sentry tick.

Each detector reads a slice of state and returns zero or more
:class:`DetectedPattern` rows. The tick body persists them as
``plugin_sentry.sentry_ticks`` + escalates the higher-severity ones
into ``eidan.escalations``.

Phase 1 ships three detectors:

- ``overdue_events`` — any ``eidan.events`` past its ``due_at`` with
  status='pending'. One pattern per overdue event so the UI inbox
  surfaces each individually.
- ``idle_too_long`` — no user message in the last
  ``EIDAN_SENTRY_IDLE_THRESHOLD_HOURS`` (default 48). Suggests a
  check-in.
- ``scope_drift`` — more than
  ``EIDAN_SENTRY_SCOPE_DRIFT_CEILING`` (default 7) pending events
  in the next 30 days. Flags overcommitment.

The Phi-3 / Ollama-driven open-ended pattern matcher from the
SENTRY spec lands once the local-model adapter ships. Until then,
deterministic detectors give a meaningful tick.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import UUID

import asyncpg

# Detector configuration knobs. Operators can override via the env
# vars below; the defaults reflect the SENTRY spec's example values.
DEFAULT_IDLE_THRESHOLD_HOURS = 48
DEFAULT_SCOPE_DRIFT_CEILING = 7
DEFAULT_SCOPE_DRIFT_WINDOW_DAYS = 30


@dataclass(frozen=True, slots=True)
class DetectedPattern:
    """One pattern hit. ``severity`` maps onto the
    :class:`eidan_backend.escalations.EscalationSeverity` enum; the
    sentry tick translates these directly into rows on
    ``eidan.escalations`` for the operator inbox."""

    name: str
    severity: str   # 'low' | 'medium' | 'high'
    reason_class: str  # one of the EscalationReason enum values
    summary: str
    evidence: tuple[str, ...] = ()
    metadata: dict[str, Any] = field(default_factory=dict)


async def detect_overdue_events(
    conn: asyncpg.Connection,
    *,
    user_id: UUID,
) -> list[DetectedPattern]:
    """Pending events whose ``due_at`` is in the past."""
    now = datetime.now(tz=UTC)
    rows = await conn.fetch(
        """
        SELECT id, type, title, due_at
        FROM eidan.events
        WHERE user_id = $1
          AND status = 'pending'
          AND deleted_at IS NULL
          AND due_at IS NOT NULL
          AND due_at < $2
        ORDER BY due_at ASC
        LIMIT 50
        """,
        user_id,
        now,
    )
    return [
        DetectedPattern(
            name="overdue_event",
            severity="medium",
            reason_class="missing_input",
            summary=(
                f"{row['type']} {row['title']!r} was due "
                f"{_format_relative(now - row['due_at'])} ago and is "
                "still pending. Suggest revisiting or marking done."
            ),
            evidence=(f"event:{row['id']}",),
            metadata={
                "event_id": str(row["id"]),
                "due_at": row["due_at"].isoformat(),
                "type": row["type"],
            },
        )
        for row in rows
    ]


async def detect_idle_too_long(
    conn: asyncpg.Connection,
    *,
    user_id: UUID,
    threshold_hours: int = DEFAULT_IDLE_THRESHOLD_HOURS,
) -> list[DetectedPattern]:
    """No user message in the last ``threshold_hours``.

    Fires once when the threshold crosses, not repeatedly per tick —
    the sentry tick dedupes by checking for a pending escalation of
    the same ``name`` already in ``eidan.escalations`` before
    re-emitting.
    """
    now = datetime.now(tz=UTC)
    threshold = now - timedelta(hours=threshold_hours)
    row = await conn.fetchrow(
        """
        SELECT MAX(created_at) AS last_user_at
        FROM eidan.messages
        WHERE user_id = $1
          AND role = 'user'
          AND deleted_at IS NULL
        """,
        user_id,
    )
    last_seen = row["last_user_at"] if row else None
    if last_seen is None:
        return []  # never spoken — nothing to be idle from
    if last_seen >= threshold:
        return []
    delta = now - last_seen
    return [
        DetectedPattern(
            name="idle_too_long",
            severity="low",
            reason_class="other",
            summary=(
                f"It's been {_format_relative(delta)} since the last "
                "user message. Consider a gentle check-in."
            ),
            evidence=(),
            metadata={
                "last_user_message_at": last_seen.isoformat(),
                "threshold_hours": threshold_hours,
            },
        )
    ]


async def detect_scope_drift(
    conn: asyncpg.Connection,
    *,
    user_id: UUID,
    ceiling: int = DEFAULT_SCOPE_DRIFT_CEILING,
    window_days: int = DEFAULT_SCOPE_DRIFT_WINDOW_DAYS,
) -> list[DetectedPattern]:
    """More than ``ceiling`` pending events scheduled in the next
    ``window_days``."""
    now = datetime.now(tz=UTC)
    horizon = now + timedelta(days=window_days)
    row = await conn.fetchrow(
        """
        SELECT COUNT(*) AS pending_count
        FROM eidan.events
        WHERE user_id = $1
          AND status = 'pending'
          AND deleted_at IS NULL
          AND due_at IS NOT NULL
          AND due_at BETWEEN $2 AND $3
        """,
        user_id,
        now,
        horizon,
    )
    count = int(row["pending_count"]) if row else 0
    if count <= ceiling:
        return []
    return [
        DetectedPattern(
            name="scope_drift",
            severity="low",
            reason_class="over_capacity",
            summary=(
                f"{count} pending events queued in the next "
                f"{window_days} days (ceiling: {ceiling}). The "
                "operator may be overcommitting."
            ),
            evidence=(),
            metadata={
                "pending_count": count,
                "ceiling": ceiling,
                "window_days": window_days,
            },
        )
    ]


async def run_all_detectors(
    conn: asyncpg.Connection,
    *,
    user_id: UUID,
    idle_threshold_hours: int = DEFAULT_IDLE_THRESHOLD_HOURS,
    scope_drift_ceiling: int = DEFAULT_SCOPE_DRIFT_CEILING,
    scope_drift_window_days: int = DEFAULT_SCOPE_DRIFT_WINDOW_DAYS,
) -> list[DetectedPattern]:
    """Run every Phase-1 detector against ``user_id`` and return the
    flat hit list. Order: overdue → idle → scope_drift, which is the
    order the UI inbox lists them when they all fire on the same tick.
    """
    out: list[DetectedPattern] = []
    out.extend(await detect_overdue_events(conn, user_id=user_id))
    out.extend(
        await detect_idle_too_long(
            conn, user_id=user_id, threshold_hours=idle_threshold_hours
        )
    )
    out.extend(
        await detect_scope_drift(
            conn,
            user_id=user_id,
            ceiling=scope_drift_ceiling,
            window_days=scope_drift_window_days,
        )
    )
    return out


def _format_relative(delta: timedelta) -> str:
    """Render a timedelta as a short human-readable string.

    The model gets the value via the pattern's `summary`; we keep
    the format compact so the escalation message stays scannable.
    """
    seconds = int(delta.total_seconds())
    if seconds < 60:
        return f"{seconds}s"
    if seconds < 3600:
        return f"{seconds // 60}m"
    if seconds < 86400:
        return f"{seconds // 3600}h"
    days = seconds // 86400
    return f"{days}d"


__all__ = [
    "DEFAULT_IDLE_THRESHOLD_HOURS",
    "DEFAULT_SCOPE_DRIFT_CEILING",
    "DEFAULT_SCOPE_DRIFT_WINDOW_DAYS",
    "DetectedPattern",
    "detect_idle_too_long",
    "detect_overdue_events",
    "detect_scope_drift",
    "run_all_detectors",
]
