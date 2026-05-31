# SPDX-License-Identifier: AGPL-3.0-or-later
"""Integration tests for :class:`TelemetryEmitter`.

Exercises the heartbeat UPSERT, event-emit + seq allocation, and
the failure-swallow contract against a real Postgres via the
``eidan_db`` session fixture (see ``apps/backend/tests/conftest.py``)."""

from __future__ import annotations

import asyncio
import json

import pytest
from eidan_backend.db import create_pool
from eidan_backend.node_identity import NodeIdentity
from eidan_backend.telemetry import TelemetryEmitter


def _identity(node_id: str = "test-node", node_type: str = "local") -> NodeIdentity:
    return NodeIdentity(
        node_id=node_id,
        node_type=node_type,
        metadata={"hostname": "test-host", "platform": "test"},
    )


async def test_start_upserts_heartbeat_eagerly(eidan_db: str) -> None:
    """:meth:`TelemetryEmitter.start` writes the heartbeat before
    returning so the first event emit doesn't FK-fail."""
    pool = await create_pool(eidan_db)
    try:
        emitter = TelemetryEmitter(pool=pool, identity=_identity("eager-node"))
        await emitter.start()
        try:
            async with pool.acquire() as conn:
                row = await conn.fetchrow(
                    "SELECT node_id, node_type, status, metadata "
                    "FROM eidan.node_heartbeats WHERE node_id = $1",
                    "eager-node",
                )
            assert row is not None
            assert row["node_type"] == "local"
            assert row["status"] == "online"
            # metadata round-trip
            metadata = (
                row["metadata"]
                if isinstance(row["metadata"], dict)
                else json.loads(row["metadata"])
            )
            assert metadata["hostname"] == "test-host"
        finally:
            await emitter.stop()
    finally:
        await pool.close()


async def test_heartbeat_upsert_refreshes_last_seen(eidan_db: str) -> None:
    """A second call to ``_upsert_heartbeat`` (effectively what the
    background loop does) bumps ``last_seen`` without inserting a
    duplicate row."""
    pool = await create_pool(eidan_db)
    try:
        emitter = TelemetryEmitter(
            pool=pool,
            identity=_identity("refresh-node"),
            # Long enough that the background loop won't tick during
            # this test — we drive _upsert_heartbeat manually.
            heartbeat_interval_seconds=3600,
        )
        await emitter.start()
        try:
            async with pool.acquire() as conn:
                first_seen = await conn.fetchval(
                    "SELECT last_seen FROM eidan.node_heartbeats "
                    "WHERE node_id = 'refresh-node'"
                )
            # Sleep a touch so now() advances measurably; postgres has
            # sub-ms resolution but the assertion is "later, not the
            # same row", which is robust even if the clock barely moves.
            await asyncio.sleep(0.02)
            await emitter._upsert_heartbeat()  # second beat
            async with pool.acquire() as conn:
                rows = await conn.fetch(
                    "SELECT last_seen FROM eidan.node_heartbeats "
                    "WHERE node_id = 'refresh-node'"
                )
            assert len(rows) == 1  # UPSERT, not duplicate INSERT
            assert rows[0]["last_seen"] >= first_seen
        finally:
            await emitter.stop()
    finally:
        await pool.close()


async def test_emit_event_allocates_per_node_sequence(eidan_db: str) -> None:
    """Three sequential emits land at seq 1, 2, 3 for the same node."""
    pool = await create_pool(eidan_db)
    try:
        emitter = TelemetryEmitter(
            pool=pool,
            identity=_identity("seq-node"),
            heartbeat_interval_seconds=3600,
        )
        await emitter.start()
        try:
            await emitter.emit_event("test.alpha", {"i": 1})
            await emitter.emit_event("test.beta", {"i": 2})
            await emitter.emit_event("test.gamma", {"i": 3})
            async with pool.acquire() as conn:
                rows = await conn.fetch(
                    "SELECT seq, type, payload FROM eidan.node_events "
                    "WHERE node_id = 'seq-node' ORDER BY seq"
                )
            assert [r["seq"] for r in rows] == [1, 2, 3]
            assert [r["type"] for r in rows] == [
                "test.alpha",
                "test.beta",
                "test.gamma",
            ]
        finally:
            await emitter.stop()
    finally:
        await pool.close()


async def test_emit_event_sequences_are_per_node(eidan_db: str) -> None:
    """Two emitters with different node_ids each get their own seq
    space — node-a's seq=1 doesn't shadow node-b's seq=1."""
    pool = await create_pool(eidan_db)
    try:
        emitter_a = TelemetryEmitter(
            pool=pool,
            identity=_identity("node-a"),
            heartbeat_interval_seconds=3600,
        )
        emitter_b = TelemetryEmitter(
            pool=pool,
            identity=_identity("node-b"),
            heartbeat_interval_seconds=3600,
        )
        await emitter_a.start()
        await emitter_b.start()
        try:
            await emitter_a.emit_event("a.one", {})
            await emitter_b.emit_event("b.one", {})
            await emitter_a.emit_event("a.two", {})
            async with pool.acquire() as conn:
                rows = await conn.fetch(
                    "SELECT node_id, seq, type FROM eidan.node_events "
                    "ORDER BY node_id, seq"
                )
            by_node = {(r["node_id"], r["seq"]): r["type"] for r in rows}
            assert by_node[("node-a", 1)] == "a.one"
            assert by_node[("node-a", 2)] == "a.two"
            assert by_node[("node-b", 1)] == "b.one"
        finally:
            await emitter_a.stop()
            await emitter_b.stop()
    finally:
        await pool.close()


async def test_emit_event_with_conversation_id(eidan_db: str) -> None:
    """conversation_id is persisted when supplied and queryable."""
    from uuid import uuid4

    conv_id = uuid4()
    pool = await create_pool(eidan_db)
    try:
        emitter = TelemetryEmitter(
            pool=pool,
            identity=_identity("conv-node"),
            heartbeat_interval_seconds=3600,
        )
        await emitter.start()
        try:
            await emitter.emit_event(
                "turn.start", {"prompt": "hi"}, conversation_id=conv_id
            )
            await emitter.emit_event("scheduler.tick", {})  # no conv_id
            async with pool.acquire() as conn:
                rows = await conn.fetch(
                    "SELECT seq, type, conversation_id "
                    "FROM eidan.node_events WHERE node_id = 'conv-node' "
                    "ORDER BY seq"
                )
            assert rows[0]["conversation_id"] == conv_id
            assert rows[1]["conversation_id"] is None
        finally:
            await emitter.stop()
    finally:
        await pool.close()


async def test_emit_event_swallows_db_failure(
    eidan_db: str,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """A telemetry write failure must not raise to the caller.

    We simulate "pool closed" — the most realistic class of failure
    (DB unreachable, transient outage). The emitter logs the
    exception and returns normally; the caller's loop keeps running."""
    import logging

    pool = await create_pool(eidan_db)
    emitter = TelemetryEmitter(
        pool=pool,
        identity=_identity("dead-pool-node"),
        heartbeat_interval_seconds=3600,
    )
    await emitter.start()
    await emitter.stop()
    await pool.close()  # underlying pool is gone

    with caplog.at_level(logging.ERROR, logger="eidan_backend.telemetry"):
        # Should not raise even though the pool is closed.
        await emitter.emit_event("post.close", {"won't": "land"})

    assert any(
        "emit_event" in r.message and r.levelno >= logging.ERROR
        for r in caplog.records
    )


async def test_start_raises_on_eager_heartbeat_failure(eidan_db: str) -> None:
    """The eager first heartbeat is **strict**: if it fails, start()
    raises so the boot caller can disable telemetry rather than
    enter a silent-FK-failure state. The background-loop refreshes
    keep swallowing (see test_emit_event_swallows_db_failure for
    the swallow contract on the other side)."""
    pool = await create_pool(eidan_db)
    await pool.close()  # close before start() to force the eager beat to fail

    emitter = TelemetryEmitter(
        pool=pool,
        identity=_identity("dead-on-arrival"),
        heartbeat_interval_seconds=3600,
    )
    with pytest.raises(Exception):  # noqa: B017 — any DB-side error counts
        await emitter.start()
    # No background task should have been scheduled.
    assert emitter._task is None


async def test_emit_event_invalid_conversation_id_does_not_raise(
    eidan_db: str,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """A malformed conversation_id string must not raise to the
    caller — the "telemetry never breaks job execution" invariant
    covers parsing failures, not just DB failures. Treat as no
    conversation and emit the row anyway."""
    import logging

    pool = await create_pool(eidan_db)
    try:
        emitter = TelemetryEmitter(
            pool=pool,
            identity=_identity("bad-conv-node"),
            heartbeat_interval_seconds=3600,
        )
        await emitter.start()
        try:
            with caplog.at_level(
                logging.ERROR, logger="eidan_backend.telemetry"
            ):
                # Not a UUID. Pre-fix this raised ValueError to the caller.
                await emitter.emit_event(
                    "test.bad", {"why": "garbage"}, conversation_id="not-a-uuid"
                )

            # Row landed, with conversation_id NULL.
            async with pool.acquire() as conn:
                row = await conn.fetchrow(
                    "SELECT type, conversation_id FROM eidan.node_events "
                    "WHERE node_id = 'bad-conv-node' AND type = 'test.bad'"
                )
            assert row is not None
            assert row["conversation_id"] is None

            # And the parsing failure was logged.
            assert any(
                "invalid conversation_id" in r.message
                and r.levelno >= logging.ERROR
                for r in caplog.records
            )
        finally:
            await emitter.stop()
    finally:
        await pool.close()


async def test_heartbeat_persists_plugin_list(eidan_db: str) -> None:
    """The plugin snapshot passed at construction lands in
    ``eidan.node_heartbeats.plugins`` on every UPSERT (issue #52).
    Drives the admin nodes pane's "what's loaded on this node"
    display so operators can confirm a runtime install actually
    landed on the node they expect.
    """
    pool = await create_pool(eidan_db)
    snapshot = [
        {"name": "calendar", "version": "1.2.3", "tier": "pro"},
        {"name": "telegram", "version": "0.4.0", "tier": "core"},
    ]
    try:
        emitter = TelemetryEmitter(
            pool=pool,
            identity=_identity("plugin-node"),
            heartbeat_interval_seconds=3600,
            plugins=snapshot,
        )
        await emitter.start()
        try:
            async with pool.acquire() as conn:
                row = await conn.fetchrow(
                    "SELECT plugins FROM eidan.node_heartbeats "
                    "WHERE node_id = 'plugin-node'"
                )
            assert row is not None
            stored = (
                row["plugins"]
                if isinstance(row["plugins"], list)
                else json.loads(row["plugins"])
            )
            assert stored == snapshot
        finally:
            await emitter.stop()
    finally:
        await pool.close()


async def test_heartbeat_plugins_default_empty(eidan_db: str) -> None:
    """A TelemetryEmitter constructed without a plugin list writes
    an empty array — keeps the wire shape consistent so the UI
    doesn't need to guard against ``undefined``."""
    pool = await create_pool(eidan_db)
    try:
        emitter = TelemetryEmitter(
            pool=pool,
            identity=_identity("no-plugin-node"),
            heartbeat_interval_seconds=3600,
        )
        await emitter.start()
        try:
            async with pool.acquire() as conn:
                row = await conn.fetchrow(
                    "SELECT plugins FROM eidan.node_heartbeats "
                    "WHERE node_id = 'no-plugin-node'"
                )
            assert row is not None
            stored = (
                row["plugins"]
                if isinstance(row["plugins"], list)
                else json.loads(row["plugins"])
            )
            assert stored == []
        finally:
            await emitter.stop()
    finally:
        await pool.close()


def test_node_id_hash_is_stable() -> None:
    """The advisory-lock key for seq allocation must be stable across
    process restarts; we encode the same node_id consistently."""
    from eidan_backend.telemetry import _node_id_hash

    assert _node_id_hash("kasha") == _node_id_hash("kasha")
    assert _node_id_hash("kasha") != _node_id_hash("kashb")
    # Fits in signed int32 range (asyncpg int4 placeholder).
    h = _node_id_hash("a-very-long-fly-machine-id-1234567890")
    assert -(2**31) <= h < 2**31
