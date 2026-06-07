"""Tests for ``ensure_default_agent_context`` + the loop's agent_id wiring.

Exercises the persistence helper against a real Postgres (so the
``ON CONFLICT (user_id, agent_slug) DO NOTHING`` + follow-up SELECT
pattern is verified end-to-end) and the contextvar pairing the loop
publishes for tool handlers.
"""

from __future__ import annotations

import asyncio
from uuid import UUID, uuid4

import pytest
from eidan_backend.db import create_pool
from eidan_backend.identity import (
    Identity,
    current_agent_id,
    get_current_agent_id,
)
from eidan_backend.persistence import (
    DEFAULT_AGENT_SLUG,
    ensure_default_agent_context,
    upsert_user,
)


def _identity(user_id: str) -> Identity:
    return Identity(
        user_id=user_id,
        email="test-agent@example.com",
        session_id=None,
        aal="aal1",
        raw_claims={},
    )


@pytest.mark.asyncio
async def test_ensure_default_agent_context_creates_then_returns_same_row(
    eidan_db: str,
) -> None:
    """First call inserts a ``default``-slug row; second call returns the
    same id without writing again. ``persona_prompt`` is ``None`` when
    neither code_defaults nor user_overrides set ``system_prompt``."""
    pool = await create_pool(eidan_db)
    try:
        user_uuid = uuid4()
        async with pool.acquire() as conn:
            async with conn.transaction():
                await upsert_user(
                    conn, user_id=user_uuid, email=_identity(str(user_uuid)).email
                )
                first_id, first_persona = await ensure_default_agent_context(
                    conn, user_id=user_uuid
                )
                second_id, second_persona = await ensure_default_agent_context(
                    conn, user_id=user_uuid
                )

        assert first_id == second_id
        # Default row has empty jsonb code_defaults / user_overrides.
        assert first_persona is None
        assert second_persona is None

        # The row exists in the table with the expected slug.
        async with pool.acquire() as conn:
            row = await conn.fetchrow(
                "SELECT agent_slug FROM eidan.agent_context WHERE id = $1",
                first_id,
            )
        assert row is not None
        assert row["agent_slug"] == DEFAULT_AGENT_SLUG
    finally:
        await pool.close()


@pytest.mark.asyncio
async def test_ensure_default_agent_context_reads_user_override_persona(
    eidan_db: str,
) -> None:
    """When the operator has written ``user_overrides.system_prompt``,
    that value wins over an empty code_defaults."""
    pool = await create_pool(eidan_db)
    try:
        user_uuid = uuid4()
        async with pool.acquire() as conn:
            async with conn.transaction():
                await upsert_user(conn, user_id=user_uuid, email=f"{user_uuid}@example.test")
                agent_id, _ = await ensure_default_agent_context(
                    conn, user_id=user_uuid
                )
                await conn.execute(
                    """
                    UPDATE eidan.agent_context
                    SET user_overrides = $2::jsonb
                    WHERE id = $1
                    """,
                    agent_id,
                    '{"system_prompt": "You are Charlotte the nutrition coach."}',
                )
                _, persona = await ensure_default_agent_context(
                    conn, user_id=user_uuid
                )

        assert persona == "You are Charlotte the nutrition coach."
    finally:
        await pool.close()


@pytest.mark.asyncio
async def test_ensure_default_agent_context_user_override_beats_code_default(
    eidan_db: str,
) -> None:
    """When both layers carry a ``system_prompt``, user_overrides wins."""
    pool = await create_pool(eidan_db)
    try:
        user_uuid = uuid4()
        async with pool.acquire() as conn:
            async with conn.transaction():
                await upsert_user(conn, user_id=user_uuid, email=f"{user_uuid}@example.test")
                agent_id, _ = await ensure_default_agent_context(
                    conn, user_id=user_uuid
                )
                await conn.execute(
                    """
                    UPDATE eidan.agent_context
                    SET code_defaults = $2::jsonb,
                        user_overrides = $3::jsonb
                    WHERE id = $1
                    """,
                    agent_id,
                    '{"system_prompt": "code-default persona"}',
                    '{"system_prompt": "user-override persona"}',
                )
                _, persona = await ensure_default_agent_context(
                    conn, user_id=user_uuid
                )

        assert persona == "user-override persona"
    finally:
        await pool.close()


def test_current_agent_id_default_is_none() -> None:
    """The contextvar is unset outside a turn — tool handlers MUST treat
    ``None`` as the explicit "no active agent" signal rather than fall
    back to a sentinel."""
    # Reset to default in case a prior test in this module set it.
    current_agent_id.set(None)
    assert get_current_agent_id() is None


def test_current_agent_id_round_trip() -> None:
    fake = UUID("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa")
    current_agent_id.set(fake)
    assert get_current_agent_id() == fake
    current_agent_id.set(None)


# ---------------------------------------------------------------------------
# CLI admin surface — `eidan admin agent show / set-persona / clear-persona`
#
# Drives the real CLI functions against the test Postgres so the
# end-to-end wire (CLI flag parse → asyncpg → ensure_default_agent_context
# → eidan.agent_context) is exercised. Test isolation: each test
# creates its own user row with a fresh email so the single-user
# resolution path is deterministic regardless of test order.
# ---------------------------------------------------------------------------


def _set_database_url(eidan_db: str, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("DATABASE_URL", eidan_db)


async def _seed_single_user(pool, email: str) -> UUID:
    user_id = uuid4()
    async with pool.acquire() as conn:
        async with conn.transaction():
            # ensure no other rows exist so the single-user fallback path
            # in `agent show` picks this row deterministically.
            await conn.execute("DELETE FROM eidan.users")
            await upsert_user(conn, user_id=user_id, email=email)
    return user_id


@pytest.mark.asyncio
async def test_cli_agent_show_renders_existing_row(
    eidan_db: str,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    """`eidan admin agent show` resolves the only user, ensures the
    default row exists, and prints its display_name + the effective
    persona (which is "(none …)" right after creation)."""
    from eidan_cli import admin

    _set_database_url(eidan_db, monkeypatch)
    pool = await create_pool(eidan_db)
    try:
        await _seed_single_user(pool, "cli-show@example.test")
    finally:
        await pool.close()

    # The CLI entry calls ``asyncio.run`` internally, which the test's
    # own event loop forbids — hand it off to a worker thread.
    rc = await asyncio.to_thread(admin.agent_show, None)
    captured = capsys.readouterr()
    assert rc == 0, captured.err
    assert "display_name:   Eidan" in captured.out
    assert "agent_slug:     default" in captured.out
    assert "(none — only EIDAN_BASE_IDENTITY will render)" in captured.out


@pytest.mark.asyncio
async def test_cli_agent_set_persona_writes_user_overrides(
    eidan_db: str,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    """`set-persona <text>` updates user_overrides.system_prompt; a
    follow-up `show` renders the new prompt under "effective persona"."""
    from eidan_cli import admin

    _set_database_url(eidan_db, monkeypatch)
    pool = await create_pool(eidan_db)
    try:
        user_id = await _seed_single_user(pool, "cli-set@example.test")
    finally:
        await pool.close()

    rc = await asyncio.to_thread(
        admin.agent_set_persona, "You are concise and direct, no fluff.", None
    )
    assert rc == 0, capsys.readouterr().err

    # Persona round-trips through `agent show`.
    capsys.readouterr()  # drain previous output
    rc2 = await asyncio.to_thread(admin.agent_show, None)
    out = capsys.readouterr().out
    assert rc2 == 0
    assert "You are concise and direct, no fluff." in out

    # And the underlying row carries the value verbatim.
    pool = await create_pool(eidan_db)
    try:
        async with pool.acquire() as conn:
            row = await conn.fetchrow(
                """
                SELECT user_overrides
                FROM eidan.agent_context
                WHERE user_id = $1 AND agent_slug = 'default'
                """,
                user_id,
            )
    finally:
        await pool.close()
    assert row is not None
    import json as _json

    overrides = (
        _json.loads(row["user_overrides"])
        if isinstance(row["user_overrides"], str)
        else row["user_overrides"]
    )
    assert overrides == {"system_prompt": "You are concise and direct, no fluff."}


@pytest.mark.asyncio
async def test_cli_agent_clear_persona_drops_only_system_prompt(
    eidan_db: str,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """`clear-persona` removes the system_prompt key but leaves sibling
    keys in user_overrides intact — operators may stash other config
    there in future (per the schema's jsonb shape)."""
    from eidan_cli import admin

    _set_database_url(eidan_db, monkeypatch)
    pool = await create_pool(eidan_db)
    try:
        user_id = await _seed_single_user(pool, "cli-clear@example.test")
        # Pre-seed user_overrides with a system_prompt AND a sibling key.
        async with pool.acquire() as conn:
            async with conn.transaction():
                from eidan_backend.persistence import (
                    ensure_default_agent_context,
                )

                agent_id, _ = await ensure_default_agent_context(
                    conn, user_id=user_id
                )
                await conn.execute(
                    """
                    UPDATE eidan.agent_context
                    SET user_overrides = $2::jsonb
                    WHERE id = $1
                    """,
                    agent_id,
                    '{"system_prompt": "old persona", "favourite_colour": "blue"}',
                )

        rc = await asyncio.to_thread(admin.agent_clear_persona, None)
        assert rc == 0

        async with pool.acquire() as conn:
            row = await conn.fetchrow(
                "SELECT user_overrides FROM eidan.agent_context WHERE id = $1",
                agent_id,
            )
    finally:
        await pool.close()

    import json as _json

    overrides = (
        _json.loads(row["user_overrides"])
        if isinstance(row["user_overrides"], str)
        else row["user_overrides"]
    )
    assert "system_prompt" not in overrides
    assert overrides.get("favourite_colour") == "blue"


@pytest.mark.asyncio
async def test_cli_agent_set_persona_refuses_empty_input(
    eidan_db: str,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    """Whitespace-only input is not a real persona — refuse rather than
    write a useless row that suppresses no behaviour."""
    from eidan_cli import admin

    _set_database_url(eidan_db, monkeypatch)
    pool = await create_pool(eidan_db)
    try:
        await _seed_single_user(pool, "cli-empty@example.test")
    finally:
        await pool.close()

    rc = admin.agent_set_persona("   \n  ", email=None)
    assert rc == 2
    assert "refusing to set an empty persona" in capsys.readouterr().err


@pytest.mark.asyncio
async def test_cli_agent_show_errors_when_no_users_exist(
    eidan_db: str,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    """No users in eidan.users → actionable error, non-zero exit."""
    from eidan_cli import admin

    _set_database_url(eidan_db, monkeypatch)
    pool = await create_pool(eidan_db)
    try:
        async with pool.acquire() as conn:
            await conn.execute("DELETE FROM eidan.users")
    finally:
        await pool.close()

    rc = await asyncio.to_thread(admin.agent_show, None)
    assert rc == 1
    assert "no users in eidan.users yet" in capsys.readouterr().err
