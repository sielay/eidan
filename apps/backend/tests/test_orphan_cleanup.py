"""Orphan-message cleanup tests (audit §11 fix).

The loop stamps ``metadata.completed_at`` on the final assistant
message just before yielding ``TurnComplete``. Any assistant row
older than the grace period without that stamp is debris from a
crashed previous process and gets ``crashed_before_completion``
stamped so the UI knows to mark it visually.

The bootstrap calls this once at startup; the function is
idempotent so a row that was already flagged is left alone.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from uuid import UUID, uuid4

import pytest
from eidan_backend.db import create_pool
from eidan_backend.persistence import (
    flag_orphaned_assistant_messages,
    upsert_user,
)

from .conftest import build_identity


async def _seed_user(pool, identity) -> UUID:
    user_uuid = UUID(identity.user_id)
    async with pool.acquire() as conn:
        async with conn.transaction():
            await upsert_user(
                conn, user_id=user_uuid, email=identity.email
            )
    return user_uuid


async def _insert_assistant(
    conn,
    *,
    user_id,
    conversation_id,
    created_at,
    metadata: dict | None = None,
):
    import json as _json

    msg_id = uuid4()
    await conn.execute(
        """
        INSERT INTO eidan.messages
            (id, user_id, conversation_id, role, content, metadata, created_at)
        VALUES ($1, $2, $3, 'assistant', 'reply', $4::jsonb, $5)
        """,
        msg_id,
        user_id,
        conversation_id,
        _json.dumps(metadata or {}),
        created_at,
    )
    return msg_id


@pytest.mark.asyncio
async def test_old_assistant_without_completed_at_gets_flagged(
    eidan_db: str,
) -> None:
    identity = build_identity()
    pool = await create_pool(eidan_db)
    try:
        user_uuid = await _seed_user(pool, identity)
        conv = uuid4()
        async with pool.acquire() as conn:
            await conn.execute(
                "INSERT INTO eidan.conversations (id, user_id) VALUES ($1, $2)",
                conv,
                user_uuid,
            )
            msg_id = await _insert_assistant(
                conn,
                user_id=user_uuid,
                conversation_id=conv,
                created_at=datetime.now(tz=UTC) - timedelta(minutes=5),
                metadata={},
            )

        async with pool.acquire() as conn:
            flagged = await flag_orphaned_assistant_messages(conn)
        assert flagged == 1

        async with pool.acquire() as conn:
            row = await conn.fetchrow(
                "SELECT metadata FROM eidan.messages WHERE id = $1",
                msg_id,
            )
        import json as _json

        meta = (
            _json.loads(row["metadata"])
            if isinstance(row["metadata"], str)
            else row["metadata"]
        )
        assert meta.get("crashed_before_completion") is True
    finally:
        await pool.close()


@pytest.mark.asyncio
async def test_completed_assistant_is_left_alone(eidan_db: str) -> None:
    """A clean turn carries metadata.completed_at; the scanner skips
    it. Single most important assertion — false positives erode
    operator trust in the indicator."""
    identity = build_identity()
    pool = await create_pool(eidan_db)
    try:
        user_uuid = await _seed_user(pool, identity)
        conv = uuid4()
        async with pool.acquire() as conn:
            await conn.execute(
                "INSERT INTO eidan.conversations (id, user_id) VALUES ($1, $2)",
                conv,
                user_uuid,
            )
            msg_id = await _insert_assistant(
                conn,
                user_id=user_uuid,
                conversation_id=conv,
                created_at=datetime.now(tz=UTC) - timedelta(minutes=10),
                metadata={"completed_at": "2026-05-20T00:00:00+00:00"},
            )
            await flag_orphaned_assistant_messages(conn)
            row = await conn.fetchrow(
                "SELECT metadata FROM eidan.messages WHERE id = $1",
                msg_id,
            )
        import json as _json

        meta = (
            _json.loads(row["metadata"])
            if isinstance(row["metadata"], str)
            else row["metadata"]
        )
        assert "crashed_before_completion" not in meta
    finally:
        await pool.close()


@pytest.mark.asyncio
async def test_recent_in_flight_assistant_is_spared(eidan_db: str) -> None:
    """A turn that's actively streaming RIGHT NOW (created < 60s
    ago) hasn't crashed — it's still going. The grace period
    skips it so the cleanup doesn't false-positive against a
    live process."""
    identity = build_identity()
    pool = await create_pool(eidan_db)
    try:
        user_uuid = await _seed_user(pool, identity)
        conv = uuid4()
        async with pool.acquire() as conn:
            await conn.execute(
                "INSERT INTO eidan.conversations (id, user_id) VALUES ($1, $2)",
                conv,
                user_uuid,
            )
            msg_id = await _insert_assistant(
                conn,
                user_id=user_uuid,
                conversation_id=conv,
                created_at=datetime.now(tz=UTC) - timedelta(seconds=5),
                metadata={},
            )
            await flag_orphaned_assistant_messages(conn)
            row = await conn.fetchrow(
                "SELECT metadata FROM eidan.messages WHERE id = $1",
                msg_id,
            )
        import json as _json

        meta = (
            _json.loads(row["metadata"])
            if isinstance(row["metadata"], str)
            else row["metadata"]
        )
        assert "crashed_before_completion" not in meta
    finally:
        await pool.close()


@pytest.mark.asyncio
async def test_budget_exceeded_is_not_a_crash(eidan_db: str) -> None:
    """A turn that ended cleanly via budget short-circuit (`docs/010
    §2`) doesn't have completed_at but has budget_exceeded. The
    scanner respects that as a clean ending."""
    identity = build_identity()
    pool = await create_pool(eidan_db)
    try:
        user_uuid = await _seed_user(pool, identity)
        conv = uuid4()
        async with pool.acquire() as conn:
            await conn.execute(
                "INSERT INTO eidan.conversations (id, user_id) VALUES ($1, $2)",
                conv,
                user_uuid,
            )
            msg_id = await _insert_assistant(
                conn,
                user_id=user_uuid,
                conversation_id=conv,
                created_at=datetime.now(tz=UTC) - timedelta(minutes=5),
                metadata={"budget_exceeded": {"cap_usd": 1.00, "iterations": 5}},
            )
            await flag_orphaned_assistant_messages(conn)
            row = await conn.fetchrow(
                "SELECT metadata FROM eidan.messages WHERE id = $1",
                msg_id,
            )
        import json as _json

        meta = (
            _json.loads(row["metadata"])
            if isinstance(row["metadata"], str)
            else row["metadata"]
        )
        assert "crashed_before_completion" not in meta
    finally:
        await pool.close()


@pytest.mark.asyncio
async def test_already_flagged_is_idempotent(eidan_db: str) -> None:
    """Running the scanner twice doesn't double-stamp or re-flag.
    Subsequent boots over a populated DB are no-ops on the rows that
    have been there since the last boot."""
    identity = build_identity()
    pool = await create_pool(eidan_db)
    try:
        user_uuid = await _seed_user(pool, identity)
        conv = uuid4()
        async with pool.acquire() as conn:
            await conn.execute(
                "INSERT INTO eidan.conversations (id, user_id) VALUES ($1, $2)",
                conv,
                user_uuid,
            )
            await _insert_assistant(
                conn,
                user_id=user_uuid,
                conversation_id=conv,
                created_at=datetime.now(tz=UTC) - timedelta(minutes=5),
                metadata={},
            )

        async with pool.acquire() as conn:
            first = await flag_orphaned_assistant_messages(conn)
            second = await flag_orphaned_assistant_messages(conn)
        assert first == 1
        assert second == 0
    finally:
        await pool.close()
