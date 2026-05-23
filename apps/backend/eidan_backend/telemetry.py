# SPDX-License-Identifier: AGPL-3.0-or-later
"""Per-node telemetry — heartbeat loop + activity event emitter.

Every backend process owns one :class:`TelemetryEmitter`. It writes
to two tables created in
``migrations/versions/20260523_000001_init_node_telemetry.py``:

- ``eidan.node_heartbeats`` — one row per node, UPSERTed every 30
  seconds while the process is alive. The dashboard reads this to
  show "which nodes are online right now".
- ``eidan.node_events`` — append-only activity stream. The emitter
  exposes :meth:`emit_event` for bootstrap, the behaviour
  dispatcher, plugins, and the sentry tick to record milestones.

Failure handling matches potem (``apps/pi-node/pi_node/heartbeat.py``
and ``apps/pi-node/pi_node/executor.py:_append_node_event``):
**telemetry never breaks job execution.** Both writes catch every
exception and log it; the next 30s heartbeat retries on its own, an
event-write that lost is just lost.

Each ``emit_event`` call also fires a structured ``logging`` line
with the same fields, so ``journalctl -u eidan-backend`` and
``fly logs`` carry the same trail as the DB. Operators who want
external aggregation (BetterStack, Loki, Datadog) bolt a handler
onto the root logger — no telemetry-side change needed.
"""

from __future__ import annotations

import asyncio
import json
import logging
from typing import Any
from uuid import UUID

import asyncpg

from .node_identity import NodeIdentity

logger = logging.getLogger(__name__)

HEARTBEAT_INTERVAL_SECONDS = 30


# ---------------------------------------------------------------------------
# Per-node advisory-lock key for seq allocation
# ---------------------------------------------------------------------------
#
# eidan.node_events.seq is per-node and allocated by SELECT MAX(seq)+1.
# In practice one node = one process, so there's no contention, but
# the advisory-lock pattern is defensive against future multi-emitter
# scenarios (multiple workers on the same Pi, say). We pick a constant
# class id high enough that it doesn't collide with Alembic's locks
# (which use specific known ids) or potem-style "hash of identifier"
# advisory keys.
_SEQ_ADVISORY_CLASS = 0x65_69_64_61  # ASCII 'e', 'i', 'd', 'a' — distinctive


def _node_id_hash(node_id: str) -> int:
    """Stable 32-bit hash of node_id, signed-int range for asyncpg.

    asyncpg passes pg_advisory_lock(int, int) parameters as int4.
    Python's built-in hash() is platform/process-dependent (seeded),
    so we use a deterministic CRC-like fold. The exact value doesn't
    matter — only that it's stable for the same node_id across
    process restarts.
    """
    h = 0
    for ch in node_id.encode("utf-8"):
        h = ((h << 5) - h + ch) & 0xFFFFFFFF
    # Convert to signed int32 so asyncpg doesn't reject as out-of-range.
    if h >= 0x80000000:
        h -= 0x1_0000_0000
    return h


# ---------------------------------------------------------------------------
# TelemetryEmitter
# ---------------------------------------------------------------------------


class TelemetryEmitter:
    """Owns the heartbeat loop and the event-emission helper.

    Construction does **not** start the loop. Call :meth:`start` to
    schedule the heartbeat task on the running loop; call
    :meth:`stop` from the FastAPI shutdown branch to cancel it
    cleanly. :meth:`emit_event` is safe to call before or after
    :meth:`start`.

    A failed heartbeat or event write is logged and swallowed. The
    process keeps running.
    """

    def __init__(
        self,
        pool: asyncpg.Pool,
        identity: NodeIdentity,
        *,
        heartbeat_interval_seconds: int = HEARTBEAT_INTERVAL_SECONDS,
    ) -> None:
        self._pool = pool
        self._identity = identity
        self._interval = heartbeat_interval_seconds
        self._task: asyncio.Task[None] | None = None
        self._stopping = asyncio.Event()

    @property
    def identity(self) -> NodeIdentity:
        return self._identity

    # ----- heartbeat loop ---------------------------------------------------

    async def start(self) -> None:
        """Emit one heartbeat eagerly, then schedule the loop.

        Emitting eagerly (before returning) means the
        ``node_heartbeats`` row exists by the time the first event
        write fires. The event table's FK to ``node_heartbeats``
        would otherwise raise 23503 on the first emission of a
        fresh process. potem's flyHeartbeat does the same; the Pi
        emitter, which doesn't have an FK, doesn't bother.
        """
        await self._upsert_heartbeat()
        self._task = asyncio.create_task(
            self._run_loop(), name="eidan-telemetry-heartbeat"
        )
        logger.info(
            "telemetry: heartbeat loop started for node %s",
            self._identity.node_id,
            extra={
                "event": "telemetry.heartbeat_started",
                "node_id": self._identity.node_id,
                "node_type": self._identity.node_type,
                "interval_seconds": self._interval,
            },
        )

    async def stop(self) -> None:
        """Cancel the heartbeat task. Idempotent.

        Does not mark the heartbeat row 'offline' — a clean
        shutdown is indistinguishable from a kill -9 at the read
        path's "last_seen older than threshold" check. The
        dashboard renders 'offline' for any row whose last_seen is
        more than 2× the heartbeat interval old.
        """
        if self._task is None or self._task.done():
            return
        self._stopping.set()
        self._task.cancel()
        try:
            await self._task
        except (asyncio.CancelledError, Exception):  # noqa: BLE001 — best-effort teardown
            pass
        logger.info(
            "telemetry: heartbeat loop stopped",
            extra={
                "event": "telemetry.heartbeat_stopped",
                "node_id": self._identity.node_id,
            },
        )

    async def _run_loop(self) -> None:
        """Heartbeat task body. Cancelled via :meth:`stop`."""
        while not self._stopping.is_set():
            try:
                await asyncio.wait_for(
                    self._stopping.wait(), timeout=self._interval
                )
                # If wait_for returns rather than times out, stop was set.
                return
            except asyncio.TimeoutError:
                pass
            await self._upsert_heartbeat()

    async def _upsert_heartbeat(self) -> None:
        try:
            async with self._pool.acquire() as conn:
                await conn.execute(
                    """
                    INSERT INTO eidan.node_heartbeats
                      (node_id, node_type, status, last_seen, metadata)
                    VALUES ($1, $2, 'online', NOW(), $3::jsonb)
                    ON CONFLICT (node_id) DO UPDATE
                      SET status    = 'online',
                          last_seen = NOW(),
                          metadata  = EXCLUDED.metadata,
                          node_type = EXCLUDED.node_type
                    """,
                    self._identity.node_id,
                    self._identity.node_type,
                    json.dumps(self._identity.metadata),
                )
        except Exception:  # noqa: BLE001 — telemetry must never crash the loop
            logger.exception(
                "telemetry: heartbeat upsert failed — will retry in %ds",
                self._interval,
                extra={
                    "event": "telemetry.heartbeat_failed",
                    "node_id": self._identity.node_id,
                },
            )

    # ----- event emission ---------------------------------------------------

    async def emit_event(
        self,
        event_type: str,
        payload: dict[str, Any] | None = None,
        *,
        conversation_id: UUID | str | None = None,
    ) -> None:
        """Append one row to ``eidan.node_events``.

        Fire-and-forget. A DB error here logs and returns — callers
        do not need to wrap in try/except.

        ``event_type`` is free-form lowercase dotted (matches potem:
        ``tool_status``, ``boot``, ``shutdown``, ``plugin.activate``).
        ``payload`` is whatever JSON-serialisable dict captures the
        context; the dashboard renders the type + a one-line summary
        and lets you drill into the payload on demand.
        """
        payload = payload or {}
        conv_id = self._coerce_uuid(conversation_id)

        # Mirror to stdout logs first — even if the DB write fails,
        # the line shows up in journalctl / fly logs.
        logger.info(
            "telemetry: %s",
            event_type,
            extra={
                "event": event_type,
                "node_id": self._identity.node_id,
                "node_type": self._identity.node_type,
                "conversation_id": str(conv_id) if conv_id else None,
                "payload": payload,
            },
        )

        try:
            async with self._pool.acquire() as conn:
                # Per-node advisory lock: SELECT MAX(seq)+1 + INSERT
                # is two statements that would race if a single node
                # had multiple concurrent emitters. The lock is held
                # for the full transaction and released on commit.
                async with conn.transaction():
                    await conn.execute(
                        "SELECT pg_advisory_xact_lock($1, $2)",
                        _SEQ_ADVISORY_CLASS,
                        _node_id_hash(self._identity.node_id),
                    )
                    seq_row = await conn.fetchrow(
                        """
                        SELECT COALESCE(MAX(seq), 0) + 1 AS seq
                          FROM eidan.node_events
                         WHERE node_id = $1
                        """,
                        self._identity.node_id,
                    )
                    seq = seq_row["seq"]
                    await conn.execute(
                        """
                        INSERT INTO eidan.node_events
                          (node_id, seq, type, payload, conversation_id)
                        VALUES ($1, $2, $3, $4::jsonb, $5)
                        """,
                        self._identity.node_id,
                        seq,
                        event_type,
                        json.dumps(payload),
                        conv_id,
                    )
        except Exception:  # noqa: BLE001 — telemetry must never crash the caller
            logger.exception(
                "telemetry: emit_event %s failed",
                event_type,
                extra={
                    "event": "telemetry.emit_failed",
                    "type": event_type,
                    "node_id": self._identity.node_id,
                },
            )

    @staticmethod
    def _coerce_uuid(value: UUID | str | None) -> UUID | None:
        if value is None:
            return None
        if isinstance(value, UUID):
            return value
        return UUID(value)
