"""Shared fakes + fixtures for backend tests.

Two distinct surfaces live here:

1. Hand-rolled fakes (``FakeProvider``, ``FakePool``, ``FakeStore``) used
   by the loop unit tests to record calls without spinning up Postgres
   or burning provider quota.
2. The ``eidan_db`` and ``stub_provider`` pytest fixtures wired in for
   the Phase 1.5 smoke harness (`docs/002 §8.2`): ephemeral Postgres,
   ``alembic upgrade head``, then a scripted provider so the agent loop
   can be exercised end-to-end without Anthropic credentials.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
from collections.abc import AsyncIterator, Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from uuid import UUID

import pytest
from eidan_backend.providers.base import (
    AssistantBlock,
    AssistantChunk,
    AssistantMessage,
    ProviderCallResult,
    ToolUseBlock,
    UserMessage,
)
from pytest_postgresql import factories

# Per-turn TZ kwargs every ``run_turn(...)`` call needs (issue #51).
# Tests use a fixed clock so the assertions stay stable; the production
# surfaces (REPL / HTTP composer) supply real values.
TZ_TEST_KWARGS: dict[str, Any] = {
    "sent_at_utc": datetime(2026, 5, 14, 22, 13, tzinfo=UTC),
    "user_tz": "Europe/London",
}

_REPO_ROOT = Path(__file__).resolve().parents[3]
_ALEMBIC_INI = _REPO_ROOT / "migrations" / "alembic.ini"


def _find_pg_ctl() -> str | None:
    """Locate ``pg_ctl`` for pytest-postgresql.

    Returns ``None`` if it's on ``PATH`` (let pytest-postgresql resolve).
    Falls back to scanning Debian's ``/usr/lib/postgresql/<v>/bin/`` so
    a default ``apt install postgresql`` works without extra setup.
    """
    if shutil.which("pg_ctl"):
        return None
    candidates = sorted(
        Path("/usr/lib/postgresql").glob("*/bin/pg_ctl"),
        reverse=True,
    )
    return str(candidates[0]) if candidates else None


postgresql_proc = factories.postgresql_proc(
    executable=_find_pg_ctl(),
    port=None,
)


@dataclass
class ScriptedTurn:
    """One scripted provider call: optional text and optional tool_uses."""

    text: str = ""
    tool_uses: list[ToolUseBlock] = field(default_factory=list)
    model: str = "claude-sonnet-4-6"
    input_tokens: int = 10
    output_tokens: int = 5


class FakeProvider:
    """Replays a queue of :class:`ScriptedTurn`s in order.

    The loop kicks the provider 3 + N times per turn (scope, sizer,
    then N primary iterations). Tests script the whole sequence.
    """

    name = "fake"

    def __init__(self, script: list[ScriptedTurn]) -> None:
        self._script = list(script)
        self._calls: list[dict] = []
        self._last: ProviderCallResult | None = None

    @property
    def calls(self) -> list[dict]:
        return self._calls

    async def stream_turn(
        self,
        *,
        model: str,
        messages: list[UserMessage],
        system: str | None = None,
        max_tokens: int = 4096,
        tools: list[dict] | None = None,
    ) -> AsyncIterator[AssistantBlock]:
        if not self._script:
            raise AssertionError("FakeProvider script exhausted")
        turn = self._script.pop(0)
        self._calls.append(
            {
                "model": model,
                "messages": messages,
                "system": system,
                "tools": tools,
            }
        )

        if turn.text:
            yield AssistantChunk(text=turn.text)
        for tu in turn.tool_uses:
            yield tu

        # tz-aware UTC — asyncpg writes tz-naive datetimes by
        # reinterpreting them in the connection's local TZ, which
        # shifts ``started_at`` for any test that runs against a
        # session whose TZ isn't UTC (cf. session-scope cost
        # rollup).
        now = datetime.now(UTC)
        # Estimate cost_usd from the token counts so budget-cap tests
        # see realistic spend without each test having to thread an
        # explicit cost through. Production providers do this same step
        # internally (see ``anthropic._estimate_cost``).
        try:
            from eidan_backend.providers.anthropic import (
                _estimate_cost as _anth_estimate_cost,
            )
            cost_usd = _anth_estimate_cost(
                turn.model,
                turn.input_tokens,
                turn.output_tokens,
                0,
                0,
            )
        except Exception:  # noqa: BLE001 — fall back to free for unknown models
            cost_usd = 0.0
        self._last = ProviderCallResult(
            message=AssistantMessage(
                content=turn.text,
                provider=self.name,
                model=turn.model,
                tool_calls=tuple(turn.tool_uses),
            ),
            input_tokens=turn.input_tokens,
            output_tokens=turn.output_tokens,
            cost_usd=cost_usd,
            started_at=now,
            finished_at=now,
            request_id=f"req-{len(self._calls)}",
        )

    async def last_call_result(self) -> ProviderCallResult:
        assert self._last is not None
        return self._last


class _FakeTransactionCtx:
    """Stand-in for asyncpg's ``Connection.transaction()`` context manager."""

    async def __aenter__(self) -> None:
        return None

    async def __aexit__(self, *exc: Any) -> None:
        return None


_DEFAULT_AGENT_UUID = UUID("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1")


class FakeConnection:
    """Records every SQL string + args; serves canned reads."""

    def __init__(self, store: FakeStore) -> None:
        self.store = store

    def transaction(self) -> _FakeTransactionCtx:
        return _FakeTransactionCtx()

    async def execute(self, sql: str, *args: Any) -> None:
        self.store.executes.append((sql, args))

    async def fetch(self, sql: str, *args: Any) -> list[dict]:
        self.store.fetches.append((sql, args))
        return list(self.store.history)

    async def fetchrow(self, sql: str, *args: Any) -> dict | None:
        self.store.fetchrows.append((sql, args))
        # The loop calls ``ensure_default_agent_context`` at the start of
        # every turn. The query is a SELECT against ``eidan.agent_context``;
        # return a stable canned row so the loop has an agent_id to thread
        # through every subsequent insert. Tests that need a different
        # value (or want to assert on a missing row path) can swap the
        # store's ``default_agent_id`` field.
        if (
            "FROM eidan.agent_context" in sql
            or "from eidan.agent_context" in sql
        ):
            import json as _json

            return {
                "id": self.store.default_agent_id,
                "code_defaults": _json.dumps(self.store.default_code_defaults),
                "user_overrides": _json.dumps(self.store.default_user_overrides),
            }
        if "INTO eidan.conversations" in sql:
            # ``create_conversation`` runs an INSERT ... RETURNING id. The
            # agent-initiated-turn path uses this when no conversation_id
            # is supplied. Mint a stable id so the rest of the turn has
            # somewhere to attribute messages to.
            from uuid import uuid4 as _uuid4

            minted = _uuid4()
            # create_conversation's VALUES are ($1 user_id, $2 title);
            # record the new row as owned so a later ownership check
            # (conversation_belongs_to) on this conversation passes.
            if args:
                self.store.owned_conversations.add((minted, args[0]))
            return {"id": minted}
        if "FROM eidan.llm_calls" in sql or "from eidan.llm_calls" in sql:
            # The loop's per-turn cost summary aggregates inserted rows.
            # Replay the in-memory llm_calls inserts so the budget cap
            # test sees the running total the production query would
            # produce. The insert_llm_call SQL positions cost_usd /
            # input_tokens / output_tokens at arg indices 10 / 6 / 7
            # respectively (see persistence.py:insert_llm_call).
            target_user_id, target_message_id = args[0], args[1]
            rows = [
                a
                for sql_, a in self.store.executes
                if "INTO eidan.llm_calls" in sql_
                and len(a) >= 11
                and a[0] == target_user_id
                and a[2] == target_message_id
            ]
            cost = sum(float(r[10]) for r in rows)
            return {
                "cost_usd": cost,
                "input_tokens": sum(int(r[6]) for r in rows),
                "output_tokens": sum(int(r[7]) for r in rows),
                "started_at": None,
            }
        if "FROM eidan.conversations" in sql and "deleted_at IS NULL" in sql:
            # ``conversation_belongs_to``: SELECT 1 ... WHERE id=$1 AND
            # user_id=$2 AND deleted_at IS NULL. Truthy row iff the
            # (conversation_id, user_id) pair was seeded as owned (#184).
            if (args[0], args[1]) in self.store.owned_conversations:
                return {"?column?": 1}
            return None
        return None


class _AcquireCtx:
    def __init__(self, conn: FakeConnection) -> None:
        self._conn = conn

    async def __aenter__(self) -> FakeConnection:
        return self._conn

    async def __aexit__(self, *exc: Any) -> None:
        return None


class FakePool:
    def __init__(self, store: FakeStore) -> None:
        self.store = store

    def acquire(self) -> _AcquireCtx:
        return _AcquireCtx(FakeConnection(self.store))


@dataclass
class FakeStore:
    """Records every write the loop performs.

    Stores SQL strings + args verbatim; tests inspect the lists.
    """

    executes: list[tuple[str, tuple]] = field(default_factory=list)
    fetches: list[tuple[str, tuple]] = field(default_factory=list)
    fetchrows: list[tuple[str, tuple]] = field(default_factory=list)
    history: list[dict] = field(default_factory=list)
    default_agent_id: UUID = field(default_factory=lambda: _DEFAULT_AGENT_UUID)
    # When the loop calls ensure_default_agent_context, the SELECT returns
    # these jsonb columns (serialised as strings on the wire, matching
    # asyncpg's default jsonb codec). Set ``default_user_overrides`` to a
    # dict carrying ``{"system_prompt": "..."}`` to simulate an operator
    # who has saved a persona.
    default_code_defaults: dict = field(default_factory=dict)
    default_user_overrides: dict = field(default_factory=dict)
    # (conversation_id, user_id) pairs treated as owned by
    # ``conversation_belongs_to``: auto-seeded on create_conversation and
    # settable directly for the agent-initiated-turn ownership guard (#184).
    owned_conversations: set = field(default_factory=set)

    def messages_by_role(self, role: str) -> list[tuple[str, tuple]]:
        # Crude but adequate: persistence.py uses 'role=user', 'role=assistant',
        # 'role=tool' inline in the INSERT, so a substring grep is enough.
        needle = "role"
        return [
            (sql, args)
            for sql, args in self.executes
            if needle in sql
            and "INTO eidan.messages" in sql
            and f"'{role}'" in sql
        ]

    def llm_calls(self) -> list[tuple[str, tuple]]:
        return [
            (sql, args)
            for sql, args in self.executes
            if "INTO eidan.llm_calls" in sql
        ]


def build_identity() -> Any:
    """Minimal :class:`Identity` stand-in for the loop's user-id field."""
    from eidan_backend.identity import Identity

    return Identity(
        user_id="00000000-0000-0000-0000-000000000001",
        email="test@example.com",
        session_id=None,
        aal="aal1",
        raw_claims={},
    )


# In-process RS256 keypair shared by every HTTP-surface test.
# Generating a 4096-bit key per test is far too slow (>1s each); a
# 2048-bit key signs the same tokens with the same algorithm and is
# fine for test verification (the bit-length matters for production
# threat models, not for the cryptographic correctness this surface
# exercises).
_TEST_KEYPAIR: tuple[bytes, bytes] | None = None


def _get_test_keypair() -> tuple[bytes, bytes]:
    """Lazily mint + cache a 2048-bit RSA keypair as (private_pem, public_pem)."""
    global _TEST_KEYPAIR
    if _TEST_KEYPAIR is not None:
        return _TEST_KEYPAIR
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric import rsa

    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    private_pem = key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.TraditionalOpenSSL,
        encryption_algorithm=serialization.NoEncryption(),
    )
    public_pem = key.public_key().public_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PublicFormat.SubjectPublicKeyInfo,
    )
    _TEST_KEYPAIR = (private_pem, public_pem)
    return _TEST_KEYPAIR


def mint_test_token(identity: Any, *, now: datetime | None = None) -> str:
    """Mint a real RS256 access token for the given :class:`Identity`.

    Uses :func:`auth_native.issue_access_token` against the in-process
    test keypair so the auth middleware (which calls
    ``verify_access_token`` with ``app.state.auth_public_pem``) accepts
    it. Tests get a token they can paste into ``Authorization: Bearer``;
    we get end-to-end exercise of the real verify path.
    """
    from eidan_backend.auth_native import issue_access_token

    private_pem, _ = _get_test_keypair()
    email = identity.email or "test@example.com"
    return issue_access_token(
        private_pem=private_pem,
        user_id=identity.user_id,
        email=email,
        session_id=identity.session_id,
        now=now,
    )


def conversation_uuid() -> UUID:
    return UUID("00000000-0000-0000-0000-000000000002")


@pytest.fixture(scope="session")
def _eidan_db_migrated(postgresql_proc) -> str:
    """Ephemeral Postgres + ``alembic upgrade head``; yields a DATABASE_URL.

    One instance per test session per `docs/002 §8.2`. The fixture
    creates a fresh database, runs every Alembic migration against it,
    and exports ``DATABASE_URL`` to the process so any code that reads
    the environment (the migration runner itself, the host's config)
    sees the same URL.

    This is the session-scoped substrate. The ``eidan_db`` fixture
    (below) wraps it with per-test truncation so tests don't see rows
    from each other.
    """
    import psycopg

    host = postgresql_proc.host
    port = postgresql_proc.port
    user = postgresql_proc.user
    password = postgresql_proc.password or ""
    dbname = "eidan_smoke"

    with psycopg.connect(
        host=host,
        port=port,
        user=user,
        password=password,
        dbname="postgres",
        autocommit=True,
    ) as conn:
        conn.execute(f"DROP DATABASE IF EXISTS {dbname}")
        conn.execute(f"CREATE DATABASE {dbname}")

    auth = f"{user}:{password}@" if password else f"{user}@"
    async_url = f"postgresql+asyncpg://{auth}{host}:{port}/{dbname}"
    plain_url = f"postgresql://{auth}{host}:{port}/{dbname}"

    env = os.environ.copy()
    env["DATABASE_URL"] = async_url
    # Invoke alembic via ``python -m`` so we hit the same interpreter the
    # tests are running in and don't depend on the ``alembic`` console
    # script being on PATH (it isn't, under ``uv run pytest`` defaults).
    result = subprocess.run(
        [sys.executable, "-m", "alembic", "-c", str(_ALEMBIC_INI), "upgrade", "head"],
        cwd=str(_REPO_ROOT),
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode != 0:
        raise RuntimeError(
            "alembic upgrade head failed:\n"
            f"stdout:\n{result.stdout}\nstderr:\n{result.stderr}"
        )

    prior = os.environ.get("DATABASE_URL")
    os.environ["DATABASE_URL"] = async_url
    try:
        yield plain_url
    finally:
        if prior is None:
            os.environ.pop("DATABASE_URL", None)
        else:
            os.environ["DATABASE_URL"] = prior


# Tables to wipe between tests. Keep ``eidan.users`` and ``eidan.agent_context``
# out: the per-test ``_seed_user`` flow expects them to persist for the
# duration of the test, and most test files don't even reseed agents.
# Truncating with CASCADE on this fixed set is enough to clear all the
# fact rows (events, messages, knowledge, notes, llm_calls, escalations,
# behaviour_dlq) that tests append between runs.
_TRUNCATE_TABLES = (
    "eidan.llm_calls",
    "eidan.notes",
    "eidan.knowledge_links",
    "eidan.knowledge",
    "eidan.events",
    "eidan.messages",
    "eidan.conversations",
    "eidan.escalations",
    "eidan.behaviour_dlq",
    "eidan.user_context",
    "eidan.agent_context",
    "eidan.users",
)


@pytest.fixture
def eidan_db(_eidan_db_migrated: str) -> str:
    """Per-test view of the migrated DB: truncates fact tables before
    yielding so each test starts from an empty eidan.* slate.

    The underlying database is created and migrated once per session
    (see :func:`_eidan_db_migrated`); only the row-level data is
    cleared between tests. Plugin schemas managed by individual test
    files (e.g. ``plugin_sentry`` in ``_create_plugin_schema``) are
    cleared by those files' own setup helpers.
    """
    import psycopg

    url = _eidan_db_migrated
    # plain ``postgresql://`` URL — psycopg accepts it directly.
    with psycopg.connect(url, autocommit=True) as conn:
        # Truncate all known fact tables in one statement so CASCADE
        # only has to fire once. Identity-restart resets any sequences
        # tests inspect.
        targets = ", ".join(_TRUNCATE_TABLES)
        conn.execute(f"TRUNCATE {targets} RESTART IDENTITY CASCADE")
        # Plugin-private schemas also pollute across tests. Truncating
        # the tables isn't enough — the migration-runner tests rely on
        # ``alembic_version`` being empty to re-run, and a stale
        # ``foo`` table from the previous test trips DuplicateTableError
        # on the CREATE. DROP each plugin_* schema entirely; tests that
        # need one (test_sentry_plugin, test_plugin_migration_runner)
        # recreate it via their own setup helpers.
        cur = conn.execute(
            "SELECT schema_name FROM information_schema.schemata "
            "WHERE schema_name LIKE 'plugin_%'"
        )
        for (schema,) in cur.fetchall():
            conn.execute(f'DROP SCHEMA "{schema}" CASCADE')
    return url


StubProviderFactory = Callable[[list[ScriptedTurn]], "FakeProvider"]


@pytest.fixture
def stub_provider() -> StubProviderFactory:
    """Factory for a scripted :class:`Provider` (no Anthropic creds).

    Tests call ``stub_provider([ScriptedTurn(...), ...])`` to get a
    provider that replays the given turns in order. Used by the smoke
    harness so the agent loop can be exercised end-to-end against a
    real database without burning provider quota.
    """
    def _make(script: list[ScriptedTurn]) -> FakeProvider:
        return FakeProvider(list(script))

    return _make
