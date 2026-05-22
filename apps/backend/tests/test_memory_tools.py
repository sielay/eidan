"""Memory-tools tests (note #12 of the 2026-05-19 audit).

Two halves:

- :func:`validate_sql` unit tests — the static checker that gates
  ``memory_query_sql``. These run without a Postgres connection.
- Structured-helper tests — exercise ``memory_events_due``,
  ``memory_list_knowledge``, ``memory_recall``, etc. against the
  real eidan_db fixture so the column projections are honest.
"""

from __future__ import annotations

from uuid import UUID, uuid4

import pytest
from eidan_backend.db import create_pool
from eidan_backend.identity import current_identity
from eidan_backend.memory_tools import (
    SqlValidationError,
    register_memory_tools,
    validate_sql,
)
from eidan_backend.persistence import upsert_user
from eidan_backend.tools import ToolError, ToolRegistry

from .conftest import build_identity

# --- validate_sql (no DB) -----------------------------------------------


def test_validate_accepts_simple_select() -> None:
    validate_sql(
        "SELECT id, title FROM eidan.events WHERE user_id = "
        "current_setting('eidan.current_user_id')::uuid"
    )


def test_validate_accepts_cte() -> None:
    validate_sql(
        "WITH recent AS (SELECT * FROM eidan.notes) "
        "SELECT id FROM recent"
    )


def test_validate_rejects_empty() -> None:
    with pytest.raises(SqlValidationError):
        validate_sql("")
    with pytest.raises(SqlValidationError):
        validate_sql("   ")


def test_validate_rejects_dml() -> None:
    for bad in (
        "INSERT INTO eidan.events (id) VALUES (1)",
        "UPDATE eidan.events SET status = 'done'",
        "DELETE FROM eidan.events WHERE id = 1",
        "TRUNCATE eidan.events",
        "DROP TABLE eidan.events",
        "ALTER TABLE eidan.events ADD COLUMN x int",
        "CREATE TABLE eidan.foo (id int)",
        "GRANT SELECT ON eidan.events TO public",
        "REVOKE SELECT ON eidan.events FROM public",
    ):
        with pytest.raises(SqlValidationError):
            validate_sql(bad)


def test_validate_rejects_session_changes() -> None:
    for bad in (
        "SET search_path = pg_catalog",
        "SHOW search_path",
        "CALL some_proc()",
        "COPY eidan.events TO stdout",
        "VACUUM eidan.events",
    ):
        with pytest.raises(SqlValidationError):
            validate_sql(bad)


def test_validate_accepts_catalog_introspection() -> None:
    validate_sql(
        "SELECT schemaname, tablename FROM pg_catalog.pg_tables "
        "WHERE schemaname NOT IN ('pg_catalog', 'information_schema')"
    )
    validate_sql(
        "SELECT table_schema, table_name, column_name "
        "FROM information_schema.columns WHERE table_schema = 'eidan'"
    )


def test_validate_accepts_plugin_and_arbitrary_schemas() -> None:
    """The read surface is any table in any schema, so plugin schemas
    and operator-added schemas both pass validation."""
    validate_sql("SELECT * FROM plugin_capture.captures")
    validate_sql("SELECT * FROM analytics.daily_rollup")
    validate_sql("SELECT * FROM eidan.something_new_landed_today")


def test_validate_accepts_previously_sensitive_tables() -> None:
    """The widened policy allows what used to be the sensitive list
    (llm_calls, users, agent_context, plugin_state, escalations).
    Only the encrypted-secret tables remain denied — covered by
    :func:`test_validate_rejects_encrypted_secret_tables` below."""
    for ok in (
        "SELECT * FROM eidan.llm_calls",
        "SELECT email FROM eidan.users",
        "SELECT * FROM eidan.agent_context",
        "SELECT * FROM eidan.plugin_state",
        "SELECT * FROM eidan.escalations",
    ):
        validate_sql(ok)


def test_validate_rejects_encrypted_secret_tables() -> None:
    for bad in (
        "SELECT * FROM eidan.auth_keypair",
        "SELECT * FROM eidan.secrets_vault",
    ):
        with pytest.raises(SqlValidationError, match="encrypted secret"):
            validate_sql(bad)


def test_validate_accepts_no_from_query() -> None:
    """Queries without any table reference (``SELECT now()``,
    ``SELECT version()``) are allowed — they touch nothing the
    deny-list cares about."""
    validate_sql("SELECT now()")
    validate_sql("SELECT version()")


def test_validate_rejects_multi_statement() -> None:
    with pytest.raises(SqlValidationError, match="multi-statement"):
        validate_sql(
            "SELECT * FROM eidan.events; SELECT * FROM eidan.notes"
        )


def test_validate_rejects_oversized() -> None:
    with pytest.raises(SqlValidationError, match="character cap"):
        validate_sql("SELECT * FROM eidan.events WHERE " + "x=1 OR " * 1000)


def test_validate_rejects_non_select_leading_keyword() -> None:
    with pytest.raises(SqlValidationError, match="only SELECT"):
        validate_sql("EXPLAIN SELECT * FROM eidan.events")


# --- structured helpers (integration with eidan_db) ---------------------


async def _seed_user(pool, identity) -> UUID:
    user_uuid = UUID(identity.user_id)
    async with pool.acquire() as conn:
        async with conn.transaction():
            await upsert_user(
                conn, user_id=user_uuid, email=identity.email
            )
    return user_uuid


@pytest.mark.asyncio
async def test_register_memory_tools_lands_full_set() -> None:
    """Registration writes seven tools; the agent surface lists them
    alongside any plugin tools."""

    class _NullPool:
        pass

    registry = ToolRegistry()
    names = register_memory_tools(registry, pool=_NullPool())  # type: ignore[arg-type]
    assert set(names) == {
        "memory_events_due",
        "memory_list_knowledge",
        "memory_get_knowledge",
        "memory_recall",
        "memory_notes_recent",
        "memory_user_context",
        "memory_query_sql",
    }


@pytest.mark.asyncio
async def test_events_due_filters_window(eidan_db: str) -> None:
    identity = build_identity()
    pool = await create_pool(eidan_db)
    try:
        user_uuid = await _seed_user(pool, identity)
        async with pool.acquire() as conn:
            await conn.execute(
                """
                INSERT INTO eidan.events (id, user_id, type, title, due_at, status)
                VALUES ($1, $2, 'reminder', 'soon', NOW() + INTERVAL '1 hour', 'pending'),
                       ($3, $2, 'reminder', 'later', NOW() + INTERVAL '10 days', 'pending'),
                       ($4, $2, 'reminder', 'past', NOW() - INTERVAL '1 day', 'pending')
                """,
                uuid4(),
                user_uuid,
                uuid4(),
                uuid4(),
            )

        registry = ToolRegistry()
        register_memory_tools(registry, pool=pool)
        token = current_identity.set(identity)
        try:
            today_json = await registry.execute(
                "memory_events_due", {"window": "today"}
            )
            overdue_json = await registry.execute(
                "memory_events_due", {"window": "overdue"}
            )
            next_30_json = await registry.execute(
                "memory_events_due", {"window": "next_30d"}
            )
        finally:
            current_identity.reset(token)

        import json as _json

        today = _json.loads(today_json)
        overdue = _json.loads(overdue_json)
        next_30 = _json.loads(next_30_json)
        assert {row["title"] for row in today} == {"soon"}
        assert {row["title"] for row in overdue} == {"past"}
        assert {row["title"] for row in next_30} == {"soon", "later"}
    finally:
        await pool.close()


@pytest.mark.asyncio
async def test_recall_searches_knowledge_and_notes(eidan_db: str) -> None:
    identity = build_identity()
    pool = await create_pool(eidan_db)
    try:
        user_uuid = await _seed_user(pool, identity)
        async with pool.acquire() as conn:
            await conn.execute(
                """
                INSERT INTO eidan.knowledge
                    (id, user_id, skill, title, body, source)
                VALUES
                    ($1, $2, 'general', 'dentist note', 'Booked dentist for Tuesday', 'agent')
                """,
                uuid4(),
                user_uuid,
            )
            # eidan.notes requires agent_id and uses ``content`` (not
            # ``body``). Provision the default agent context for the
            # seeded user so the FK passes.
            from eidan_backend.persistence import (
                ensure_default_agent_context,
            )
            agent_id, _persona = await ensure_default_agent_context(
                conn, user_id=user_uuid
            )
            await conn.execute(
                """
                INSERT INTO eidan.notes (id, user_id, agent_id, content)
                VALUES ($1, $2, $3, 'remember to confirm the DENTIST appointment')
                """,
                uuid4(),
                user_uuid,
                agent_id,
            )

        registry = ToolRegistry()
        register_memory_tools(registry, pool=pool)
        token = current_identity.set(identity)
        try:
            raw = await registry.execute("memory_recall", {"query": "dentist"})
        finally:
            current_identity.reset(token)
        import json as _json

        rows = _json.loads(raw)
        sources = {r["source"] for r in rows}
        assert sources == {"knowledge", "notes"}
    finally:
        await pool.close()


@pytest.mark.asyncio
async def test_query_sql_returns_columns_and_rows(eidan_db: str) -> None:
    identity = build_identity()
    pool = await create_pool(eidan_db)
    try:
        user_uuid = await _seed_user(pool, identity)
        async with pool.acquire() as conn:
            await conn.execute(
                """
                INSERT INTO eidan.events
                    (id, user_id, type, title, due_at, status)
                VALUES
                    ($1, $2, 'reminder', 'gym', NOW() + INTERVAL '2 hours', 'pending')
                """,
                uuid4(),
                user_uuid,
            )

        registry = ToolRegistry()
        register_memory_tools(registry, pool=pool)
        token = current_identity.set(identity)
        try:
            raw = await registry.execute(
                "memory_query_sql",
                {
                    "sql": (
                        "SELECT type, title FROM eidan.events "
                        "WHERE user_id = "
                        "current_setting('eidan.current_user_id')::uuid "
                        "AND status = 'pending'"
                    )
                },
            )
        finally:
            current_identity.reset(token)
        import json as _json

        out = _json.loads(raw)
        assert out["columns"] == ["type", "title"]
        assert ["reminder", "gym"] in out["rows"]
        assert out["truncated"] is False
    finally:
        await pool.close()


@pytest.mark.asyncio
async def test_query_sql_refuses_encrypted_secret_through_handler() -> None:
    """The handler-level path raises ToolError on an encrypted-secret
    table reference — the validator runs before any DB connection opens."""

    class _NullPool:
        pass

    registry = ToolRegistry()
    register_memory_tools(registry, pool=_NullPool())  # type: ignore[arg-type]
    identity = build_identity()
    token = current_identity.set(identity)
    try:
        with pytest.raises(ToolError, match="encrypted secret"):
            await registry.execute(
                "memory_query_sql",
                {"sql": "SELECT * FROM eidan.auth_keypair"},
            )
    finally:
        current_identity.reset(token)


@pytest.mark.asyncio
async def test_memory_tool_refuses_without_identity() -> None:
    """Tools refuse to run without a current_identity contextvar —
    they only make sense inside a turn."""

    class _NullPool:
        pass

    registry = ToolRegistry()
    register_memory_tools(registry, pool=_NullPool())  # type: ignore[arg-type]
    with pytest.raises(ToolError, match="active identity"):
        await registry.execute("memory_events_due", {})
