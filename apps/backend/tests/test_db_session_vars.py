"""Regression test for the per-acquire session variables.

Per `docs/011 §9.3`, every connection checkout opens a transaction and
issues ``SET LOCAL eidan.current_user_id`` (and friends). Core does not
read these; the RLS plugin's policies (`docs/002 §5.2`) do, so this
test stands in for that plugin by reading the variables back via
``current_setting()`` — the same primitive an RLS policy uses.
"""

from __future__ import annotations

import pytest
from eidan_backend.db import acquire, create_pool
from eidan_backend.identity import Identity


def _identity(user_id: str, session_id: str | None, aal: str) -> Identity:
    return Identity(
        user_id=user_id,
        email=f"{user_id}@example.test",
        session_id=session_id,
        aal=aal,
        raw_claims={},
    )


@pytest.mark.asyncio
async def test_acquire_sets_session_vars_on_checkout(eidan_db: str) -> None:
    """``acquire`` makes the three eidan.* GUCs visible to in-tx queries.

    Mirrors what an RLS policy does: read the GUC via ``current_setting``
    and gate a query on it. Phase 2 has no policy, so the test reads the
    value back directly rather than exercising a policy.
    """
    pool = await create_pool(eidan_db)
    try:
        identity = _identity(
            user_id="11111111-1111-1111-1111-111111111111",
            session_id="22222222-2222-2222-2222-222222222222",
            aal="aal2",
        )
        async with acquire(pool, identity) as conn:
            user_id = await conn.fetchval(
                "SELECT current_setting('eidan.current_user_id', true)"
            )
            session_id = await conn.fetchval(
                "SELECT current_setting('eidan.current_session_id', true)"
            )
            aal = await conn.fetchval(
                "SELECT current_setting('eidan.current_aal', true)"
            )

        assert user_id == identity.user_id
        assert session_id == identity.session_id
        assert aal == identity.aal
    finally:
        await pool.close()


@pytest.mark.asyncio
async def test_acquire_encodes_null_session_id_as_empty_string(
    eidan_db: str,
) -> None:
    """A ``None`` session_id is bound as ``''`` so ``set_config`` doesn't no-op."""
    pool = await create_pool(eidan_db)
    try:
        identity = _identity(
            user_id="33333333-3333-3333-3333-333333333333",
            session_id=None,
            aal="aal1",
        )
        async with acquire(pool, identity) as conn:
            session_id = await conn.fetchval(
                "SELECT current_setting('eidan.current_session_id', true)"
            )
        assert session_id == ""
    finally:
        await pool.close()


@pytest.mark.asyncio
async def test_acquire_session_vars_do_not_leak_between_acquisitions(
    eidan_db: str,
) -> None:
    """Each ``acquire`` is its own transaction; SET LOCAL doesn't leak."""
    pool = await create_pool(eidan_db)
    try:
        first = _identity(
            user_id="44444444-4444-4444-4444-444444444444",
            session_id=None,
            aal="aal1",
        )
        second = _identity(
            user_id="55555555-5555-5555-5555-555555555555",
            session_id=None,
            aal="aal1",
        )
        async with acquire(pool, first) as conn:
            assert await conn.fetchval(
                "SELECT current_setting('eidan.current_user_id', true)"
            ) == first.user_id

        async with acquire(pool, second) as conn:
            assert await conn.fetchval(
                "SELECT current_setting('eidan.current_user_id', true)"
            ) == second.user_id
    finally:
        await pool.close()


@pytest.mark.asyncio
async def test_stub_policy_filter_sees_set_local_via_current_setting(
    eidan_db: str,
) -> None:
    """A query gated on ``current_setting`` returns only the identity's rows.

    This mirrors the shape `docs/002 §5.2` pins for the RLS plugin's
    policies. An actual RLS policy can't fire here because
    pytest-postgresql's session role is a superuser (superusers
    unconditionally bypass RLS — neither ``ENABLE`` nor ``FORCE`` ROW
    LEVEL SECURITY changes that). The test instead expands the policy
    body into the SELECT directly, which is what Postgres does
    internally when applying RLS: a policy is sugar for a ``USING``
    predicate appended to every read. If ``acquire()`` populates the
    GUC, this query returns the identity's rows; if not, it returns
    nothing.
    """
    pool = await create_pool(eidan_db)
    setup_identity = _identity(
        user_id="77777777-7777-7777-7777-777777777777",
        session_id=None,
        aal="aal1",
    )
    me = "77777777-7777-7777-7777-777777777777"
    someone_else = "88888888-8888-8888-8888-888888888888"
    try:
        async with acquire(pool, setup_identity) as conn:
            await conn.execute(
                """
                CREATE TABLE eidan._stub_policy_rows (
                    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
                    owner_id uuid NOT NULL
                )
                """
            )
            await conn.execute(
                """
                INSERT INTO eidan._stub_policy_rows (owner_id) VALUES
                    ($1::uuid), ($1::uuid), ($2::uuid)
                """,
                me,
                someone_else,
            )

        async with acquire(pool, setup_identity) as conn:
            owner_ids = await conn.fetch(
                """
                SELECT owner_id::text AS owner_id
                FROM eidan._stub_policy_rows
                WHERE owner_id = current_setting(
                    'eidan.current_user_id', true
                )::uuid
                """
            )
        assert sorted(row["owner_id"] for row in owner_ids) == [me, me]

        other_identity = _identity(
            user_id=someone_else, session_id=None, aal="aal1"
        )
        async with acquire(pool, other_identity) as conn:
            owner_ids = await conn.fetch(
                """
                SELECT owner_id::text AS owner_id
                FROM eidan._stub_policy_rows
                WHERE owner_id = current_setting(
                    'eidan.current_user_id', true
                )::uuid
                """
            )
        assert [row["owner_id"] for row in owner_ids] == [someone_else]
    finally:
        async with acquire(pool, setup_identity) as conn:
            await conn.execute(
                "DROP TABLE IF EXISTS eidan._stub_policy_rows"
            )
        await pool.close()


@pytest.mark.asyncio
async def test_acquire_rolls_back_on_exception(eidan_db: str) -> None:
    """An exception inside the ``async with`` body aborts the transaction."""
    pool = await create_pool(eidan_db)
    try:
        identity = _identity(
            user_id="66666666-6666-6666-6666-666666666666",
            session_id=None,
            aal="aal1",
        )
        with pytest.raises(RuntimeError, match="boom"):
            async with acquire(pool, identity) as conn:
                await conn.execute(
                    """
                    INSERT INTO eidan.users (id, email)
                    VALUES ($1::uuid, ($1::uuid)::text || '@example.test')
                    """,
                    identity.user_id,
                )
                raise RuntimeError("boom")

        # The insert was rolled back. A second, plain acquire confirms the
        # row never landed.
        async with acquire(pool, identity) as conn:
            row = await conn.fetchrow(
                "SELECT id FROM eidan.users WHERE id = $1::uuid",
                identity.user_id,
            )
        assert row is None
    finally:
        await pool.close()
