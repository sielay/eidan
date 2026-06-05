# SPDX-License-Identifier: AGPL-3.0-or-later
"""Model-C service accounts (#187 / docs/028 slice A).

`eidan.users.kind` distinguishes a human operator from a non-human
principal. An autonomous agent acting on its own behalf gets a synthetic
`kind='agent'` users row (so `on_behalf_of` stays a users id and RLS /
cost / FKs are unchanged). DB-backed — exercises the real migration +
CHECK constraint.
"""

from __future__ import annotations

from uuid import UUID

import asyncpg
import pytest
from eidan_backend.db import create_pool
from eidan_backend.persistence import (
    ensure_service_account,
    service_account_id,
    upsert_user,
)

from .conftest import build_identity


@pytest.mark.asyncio
async def test_human_user_defaults_to_kind_human(eidan_db: str) -> None:
    identity = build_identity()
    uid = UUID(identity.user_id)
    pool = await create_pool(eidan_db)
    try:
        async with pool.acquire() as conn:
            await upsert_user(conn, user_id=uid, email=identity.email)
            kind = await conn.fetchval(
                "SELECT kind FROM eidan.users WHERE id = $1", uid
            )
            assert kind == "human"
    finally:
        await pool.close()


@pytest.mark.asyncio
async def test_ensure_service_account_agent_and_idempotent(eidan_db: str) -> None:
    pool = await create_pool(eidan_db)
    try:
        async with pool.acquire() as conn:
            uid1 = await ensure_service_account(conn, agent_name="sentry")
            uid2 = await ensure_service_account(conn, agent_name="sentry")
            assert uid1 == uid2 == service_account_id("sentry")

            kind = await conn.fetchval(
                "SELECT kind FROM eidan.users WHERE id = $1", uid1
            )
            assert kind == "agent"
            count = await conn.fetchval(
                "SELECT count(*) FROM eidan.users WHERE id = $1", uid1
            )
            assert count == 1

            # A different agent gets a distinct row.
            other = await ensure_service_account(conn, agent_name="learn")
            assert other != uid1
    finally:
        await pool.close()


@pytest.mark.asyncio
async def test_kind_check_rejects_unknown(eidan_db: str) -> None:
    pool = await create_pool(eidan_db)
    try:
        async with pool.acquire() as conn:
            with pytest.raises(asyncpg.exceptions.CheckViolationError):
                await conn.execute(
                    "INSERT INTO eidan.users (id, kind) VALUES ($1, 'bogus')",
                    UUID("11111111-1111-1111-1111-111111111111"),
                )
    finally:
        await pool.close()
