"""Escalation envelope tests (issue #57 / `docs/022 §3`).

Exercises the persistence + lifecycle of ``eidan.escalations``
against the in-session Postgres fixture. The HTTP route surface is
covered by ``test_http.py``; this file focuses on the
record/list/acknowledge/resolve helpers in
:mod:`eidan_backend.escalations`.
"""

from __future__ import annotations

import pytest
from eidan_backend.db import create_pool
from eidan_backend.escalations import (
    Escalation,
    EscalationReason,
    EscalationSeverity,
    acknowledge_escalation,
    list_escalations,
    record_escalation,
    resolve_escalation,
)
from eidan_backend.persistence import upsert_user

from .conftest import build_identity


async def _seed_user(pool, identity):
    from uuid import UUID

    async with pool.acquire() as conn:
        async with conn.transaction():
            await upsert_user(
                conn,
                user_id=UUID(identity.user_id),
                email=identity.email,
            )


@pytest.mark.asyncio
async def test_record_escalation_persists_envelope(eidan_db: str) -> None:
    from uuid import UUID

    identity = build_identity()
    pool = await create_pool(eidan_db)
    try:
        await _seed_user(pool, identity)
        user_uuid = UUID(identity.user_id)
        async with pool.acquire() as conn:
            async with conn.transaction():
                row_id = await record_escalation(
                    conn,
                    escalation=Escalation(
                        severity=EscalationSeverity.MEDIUM,
                        reason_class=EscalationReason.MISSING_INPUT,
                        user_id=user_uuid,
                        suggested_action="need OAuth token for Zoho",
                        evidence=("msg:abc", "llm_call:def"),
                        metadata={"plugin": "zoho-mail"},
                    ),
                )

        async with pool.acquire() as conn:
            rows = await list_escalations(conn, user_id=user_uuid)
        assert len(rows) == 1
        only = rows[0]
        assert only.id == row_id
        assert only.severity == "medium"
        assert only.reason_class == "missing_input"
        assert only.suggested_action == "need OAuth token for Zoho"
        assert only.evidence == ["msg:abc", "llm_call:def"]
        assert only.metadata == {"plugin": "zoho-mail"}
        assert only.status == "pending"
        assert only.resolved_at is None
    finally:
        await pool.close()


@pytest.mark.asyncio
async def test_list_escalations_filters_by_status(eidan_db: str) -> None:
    from uuid import UUID

    identity = build_identity()
    pool = await create_pool(eidan_db)
    try:
        await _seed_user(pool, identity)
        user_uuid = UUID(identity.user_id)
        async with pool.acquire() as conn:
            async with conn.transaction():
                a = await record_escalation(
                    conn,
                    escalation=Escalation(
                        severity=EscalationSeverity.LOW,
                        reason_class=EscalationReason.OTHER,
                        user_id=user_uuid,
                    ),
                )
                b = await record_escalation(
                    conn,
                    escalation=Escalation(
                        severity=EscalationSeverity.HIGH,
                        reason_class=EscalationReason.UNRECOVERABLE_ERROR,
                        user_id=user_uuid,
                    ),
                )
                await resolve_escalation(
                    conn, escalation_id=b, user_id=user_uuid
                )

        async with pool.acquire() as conn:
            pending = await list_escalations(conn, user_id=user_uuid)
            assert [r.id for r in pending] == [a]
            resolved = await list_escalations(
                conn, user_id=user_uuid, status="resolved"
            )
            assert [r.id for r in resolved] == [b]
            all_rows = await list_escalations(
                conn, user_id=user_uuid, status=None
            )
            assert {r.id for r in all_rows} == {a, b}
    finally:
        await pool.close()


@pytest.mark.asyncio
async def test_acknowledge_only_moves_pending(eidan_db: str) -> None:
    from uuid import UUID

    identity = build_identity()
    pool = await create_pool(eidan_db)
    try:
        await _seed_user(pool, identity)
        user_uuid = UUID(identity.user_id)
        async with pool.acquire() as conn:
            async with conn.transaction():
                row_id = await record_escalation(
                    conn,
                    escalation=Escalation(
                        severity=EscalationSeverity.MEDIUM,
                        reason_class=EscalationReason.AMBIGUOUS_INTENT,
                        user_id=user_uuid,
                    ),
                )

        async with pool.acquire() as conn:
            moved = await acknowledge_escalation(
                conn, escalation_id=row_id, user_id=user_uuid
            )
        assert moved is True

        async with pool.acquire() as conn:
            second = await acknowledge_escalation(
                conn, escalation_id=row_id, user_id=user_uuid
            )
        # Already acknowledged → status is no longer pending.
        assert second is False
    finally:
        await pool.close()


@pytest.mark.asyncio
async def test_resolve_is_idempotent(eidan_db: str) -> None:
    from uuid import UUID

    identity = build_identity()
    pool = await create_pool(eidan_db)
    try:
        await _seed_user(pool, identity)
        user_uuid = UUID(identity.user_id)
        async with pool.acquire() as conn:
            async with conn.transaction():
                row_id = await record_escalation(
                    conn,
                    escalation=Escalation(
                        severity=EscalationSeverity.LOW,
                        reason_class=EscalationReason.EXTERNAL_FAILURE,
                        user_id=user_uuid,
                    ),
                )

        async with pool.acquire() as conn:
            assert await resolve_escalation(
                conn, escalation_id=row_id, user_id=user_uuid
            )
            # Second resolution is a no-op write that still returns True.
            assert await resolve_escalation(
                conn, escalation_id=row_id, user_id=user_uuid
            )
    finally:
        await pool.close()
