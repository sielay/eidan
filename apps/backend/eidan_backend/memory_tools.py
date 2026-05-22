"""Agent memory-introspection tools — core read surface.

Lets the primary agent query its own memory without a dedicated
plugin. Two surfaces:

1. **Structured helpers** — narrow, parameterised queries the model
   reaches for in the common cases: ``memory_events_due``,
   ``memory_list_knowledge``, ``memory_get_knowledge``,
   ``memory_recall``, ``memory_notes_recent``,
   ``memory_user_context``. Each maps onto one stable SQL query and
   returns JSON-shaped results.

2. **Generic safe SQL** — ``memory_query_sql`` accepts an arbitrary
   ``SELECT`` against any table in any schema, including ``eidan.*``,
   ``plugin_*.*``, ``pg_catalog.*`` and ``information_schema.*``. It
   rejects:
   - any statement that isn't `SELECT` (no DML, no DDL)
   - the encrypted-secret tables (`eidan.auth_keypair`,
     `eidan.secrets_vault`) — Fernet-sealed blobs the agent has no
     business reading
   - multiple statements (`;` separation)
   - SET / SHOW / CALL / COPY

   Schema introspection (``pg_catalog.pg_tables``,
   ``information_schema.columns``) is allowed so the agent can ask
   "what tables exist?" or "what columns does X have?" before writing
   a join.

Every tool here runs under :func:`db.acquire(pool, identity)` so
the `SET LOCAL eidan.current_user_id` session variable is set —
the RLS plugin's policies (`docs/002 §5.2`) consume it when
installed. Without RLS the queries themselves carry a
``WHERE user_id = $1`` predicate for defence-in-depth.
"""

from __future__ import annotations

import json
import re
from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import UUID

import asyncpg

from .db import acquire
from .identity import Identity, get_current_identity
from .tools import Tool, ToolError, ToolRegistry

# --- deny-list ----------------------------------------------------------

# The agent gets read access to every table in every schema. The only
# absolute denials are tables whose rows are encrypted-secret blobs —
# even though they're Fernet-sealed by ``EIDAN_AUTH_MASTER_KEY`` (which
# lives outside the DB), leaking the ciphertext over the agent's
# context narrows the attacker's path from "compromise DB + master
# key" to "compromise master key alone". The operator can widen or
# narrow this set per install.
_DENY_TABLES: frozenset[str] = frozenset(
    {
        "eidan.auth_keypair",   # Fernet-sealed RS256 signing key
        "eidan.secrets_vault",  # Fernet-sealed provider / plugin secrets
    }
)

# Reject any query whose stripped body matches one of these regexes
# AFTER normalisation. Order matters — first match wins.
#
# pg_catalog / information_schema are intentionally absent — schema
# introspection ("what tables exist?", "what columns does X have?") is
# part of giving the agent the full DB surface.
_FORBIDDEN_KEYWORDS: tuple[re.Pattern[str], ...] = (
    re.compile(r"\b(INSERT|UPDATE|DELETE|TRUNCATE|DROP|ALTER|CREATE|GRANT|REVOKE)\b", re.IGNORECASE),
    re.compile(r"\b(SET|SHOW|CALL|COPY|VACUUM|ANALYZE|CLUSTER)\b", re.IGNORECASE),
    re.compile(r"\\copy\b", re.IGNORECASE),
)

# Single-statement only — reject anything with embedded semicolons
# that aren't at the very end of the query.
_SEMICOLON_RE = re.compile(r";\s*[^\s].*", re.DOTALL)

# Matches any ``schema.table`` reference — used only to enforce the
# deny-list. Column-on-alias references (``u.email``) also match the
# shape but never collide with a deny-listed schema.table pair.
_TABLE_REFERENCE_RE = re.compile(
    r"\b([a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*)\b",
    re.IGNORECASE,
)

# Matches single-quoted string literals so we can strip them before
# extracting table references. Without this, `current_setting('eidan.X')`
# would be parsed as a reference to a table named ``eidan.X``. The
# regex consumes ``''`` escape sequences as part of one literal.
_STRING_LITERAL_RE = re.compile(r"'(?:''|[^'])*'", re.DOTALL)

# Hard caps on the generic query path.
_MAX_QUERY_LENGTH = 4_000
_MAX_RESULT_ROWS = 200
_QUERY_TIMEOUT_S = 5.0


class SqlValidationError(ToolError):
    """Raised when ``memory_query_sql`` rejects a query."""


def validate_sql(sql: str) -> None:
    """Statically check a query string against the safety rules.

    Raises :class:`SqlValidationError` with an actionable message on
    any rejection. The check is purposely conservative — false
    positives (refusing a query that would have been safe) are
    preferred over false negatives.
    """
    if not isinstance(sql, str):
        raise SqlValidationError("sql must be a string")
    stripped = sql.strip()
    if not stripped:
        raise SqlValidationError("sql is empty")
    if len(stripped) > _MAX_QUERY_LENGTH:
        raise SqlValidationError(
            f"sql exceeds {_MAX_QUERY_LENGTH}-character cap"
        )

    # Strip trailing semicolons but reject embedded ones.
    body = stripped.rstrip(";").rstrip()
    if _SEMICOLON_RE.search(body + ";"):
        # The regex above hits "statement; another", which is the
        # multi-statement case. A single trailing `;` is already
        # stripped by `rstrip` so it can't trip this branch.
        if ";" in body:
            raise SqlValidationError(
                "multi-statement queries are not allowed"
            )

    upper = body.lstrip().upper()
    if not (upper.startswith("SELECT") or upper.startswith("WITH ")):
        raise SqlValidationError(
            "only SELECT (or CTE WITH ... SELECT) queries are allowed"
        )

    for pattern in _FORBIDDEN_KEYWORDS:
        match = pattern.search(body)
        if match is not None:
            raise SqlValidationError(
                f"forbidden keyword in sql: {match.group(0)!r}"
            )

    # The read surface is "any SELECT against any table in any schema",
    # so the only table-level check is the deny-list. Strip string
    # literals first so ``current_setting('eidan.current_user_id')``
    # is not parsed as a reference to a table named ``eidan.X`` — that
    # is a PostgreSQL setting name, not a qualified table. Queries with
    # no table reference at all (``SELECT now()``, ``SELECT version()``)
    # are allowed; they touch nothing the deny-list cares about.
    body_without_strings = _STRING_LITERAL_RE.sub("''", body)
    seen_tables: set[str] = set()
    for match in _TABLE_REFERENCE_RE.finditer(body_without_strings):
        seen_tables.add(match.group(1).lower())
    for table in seen_tables:
        if table in _DENY_TABLES:
            raise SqlValidationError(
                f"table {table!r} holds encrypted secret material and "
                "is not readable by the agent"
            )


# --- handlers -----------------------------------------------------------


def _require_identity() -> tuple[UUID, Identity]:
    """Return ``(user_uuid, identity)`` for the calling agent.

    Raises :class:`ToolError` when invoked outside a turn — defensive,
    since the loop always sets the contextvar before invoking tools.
    """
    identity = get_current_identity()
    if identity is None:
        raise ToolError(
            "memory tools require an active identity; "
            "this tool can only be called from inside a turn"
        )
    return UUID(identity.user_id), identity


async def _events_due_handler(pool: asyncpg.Pool, args: dict) -> str:
    """Return events whose ``due_at`` falls in the requested window."""
    window = (args.get("window") or "today").lower()
    limit = min(int(args.get("limit", 25) or 25), 100)
    user_uuid, identity = _require_identity()
    now = datetime.now(tz=UTC)
    if window == "overdue":
        lo, hi = datetime(1970, 1, 1, tzinfo=UTC), now
    elif window == "today":
        lo, hi = now, now + timedelta(hours=24)
    elif window == "next_7d":
        lo, hi = now, now + timedelta(days=7)
    elif window == "next_30d":
        lo, hi = now, now + timedelta(days=30)
    else:
        raise ToolError(
            f"unknown window {window!r}; allowed: overdue|today|next_7d|next_30d"
        )

    async with acquire(pool, identity) as conn:
        rows = await conn.fetch(
            """
            SELECT id, type, title, due_at, status
            FROM eidan.events
            WHERE user_id = $1
              AND status = 'pending'
              AND deleted_at IS NULL
              AND due_at IS NOT NULL
              AND due_at >= $2
              AND due_at < $3
            ORDER BY due_at ASC
            LIMIT $4
            """,
            user_uuid,
            lo,
            hi,
            limit,
        )
    return json.dumps(
        [
            {
                "id": str(r["id"]),
                "type": r["type"],
                "title": r["title"],
                "due_at": r["due_at"].isoformat(),
                "status": r["status"],
            }
            for r in rows
        ]
    )


async def _list_knowledge_handler(pool: asyncpg.Pool, args: dict) -> str:
    skill = args.get("skill")
    limit = min(int(args.get("limit", 25) or 25), 100)
    user_uuid, identity = _require_identity()
    async with acquire(pool, identity) as conn:
        if skill:
            rows = await conn.fetch(
                """
                SELECT id, slug, title, skill, updated_at
                FROM eidan.knowledge
                WHERE user_id = $1
                  AND skill = $2
                  AND deleted_at IS NULL
                ORDER BY updated_at DESC
                LIMIT $3
                """,
                user_uuid,
                skill,
                limit,
            )
        else:
            rows = await conn.fetch(
                """
                SELECT id, slug, title, skill, updated_at
                FROM eidan.knowledge
                WHERE user_id = $1 AND deleted_at IS NULL
                ORDER BY updated_at DESC
                LIMIT $2
                """,
                user_uuid,
                limit,
            )
    return json.dumps(
        [
            {
                "id": str(r["id"]),
                "slug": r["slug"],
                "title": r["title"],
                "skill": r["skill"],
                "updated_at": r["updated_at"].isoformat(),
            }
            for r in rows
        ]
    )


async def _get_knowledge_handler(pool: asyncpg.Pool, args: dict) -> str:
    raw_id = args.get("id")
    slug = args.get("slug")
    user_uuid, identity = _require_identity()
    if not raw_id and not slug:
        raise ToolError("memory_get_knowledge requires either 'id' or 'slug'")
    async with acquire(pool, identity) as conn:
        if raw_id:
            try:
                kid = UUID(str(raw_id))
            except ValueError as exc:
                raise ToolError(f"id {raw_id!r} is not a UUID") from exc
            row = await conn.fetchrow(
                """
                SELECT id, slug, title, skill, body, source, updated_at
                FROM eidan.knowledge
                WHERE user_id = $1 AND id = $2 AND deleted_at IS NULL
                """,
                user_uuid,
                kid,
            )
        else:
            row = await conn.fetchrow(
                """
                SELECT id, slug, title, skill, body, source, updated_at
                FROM eidan.knowledge
                WHERE user_id = $1 AND slug = $2 AND deleted_at IS NULL
                """,
                user_uuid,
                slug,
            )
    if row is None:
        raise ToolError("knowledge row not found")
    return json.dumps(
        {
            "id": str(row["id"]),
            "slug": row["slug"],
            "title": row["title"],
            "skill": row["skill"],
            "body": row["body"],
            "source": row["source"],
            "updated_at": row["updated_at"].isoformat(),
        }
    )


async def _recall_handler(pool: asyncpg.Pool, args: dict) -> str:
    """Trigram + ILIKE search over knowledge + notes.

    The fancier FTS path (using `eidan.knowledge.body_tsv` if present)
    is reserved for when the indexer plugin lands; this fallback hits
    every row with an ILIKE so it works against a fresh install with
    no indexer running.
    """
    needle = (args.get("query") or "").strip()
    if not needle:
        raise ToolError("memory_recall requires a non-empty 'query'")
    target = (args.get("table") or "all").lower()
    limit = min(int(args.get("limit", 10) or 10), 50)
    user_uuid, identity = _require_identity()

    pattern = f"%{needle}%"
    results: list[dict[str, Any]] = []
    async with acquire(pool, identity) as conn:
        if target in ("all", "knowledge"):
            rows = await conn.fetch(
                """
                SELECT id, title, skill, body, updated_at
                FROM eidan.knowledge
                WHERE user_id = $1
                  AND deleted_at IS NULL
                  AND (title ILIKE $2 OR body ILIKE $2)
                ORDER BY updated_at DESC
                LIMIT $3
                """,
                user_uuid,
                pattern,
                limit,
            )
            for r in rows:
                results.append(
                    {
                        "source": "knowledge",
                        "id": str(r["id"]),
                        "title": r["title"],
                        "skill": r["skill"],
                        "snippet": (r["body"] or "")[:240],
                        "updated_at": r["updated_at"].isoformat(),
                    }
                )
        if target in ("all", "notes"):
            # ``eidan.notes`` stores the body in the ``content`` column
            # per `docs/003 §5` — knowledge uses ``body``, notes uses
            # ``content``. Don't conflate them.
            rows = await conn.fetch(
                """
                SELECT id, content, conversation_id, created_at
                FROM eidan.notes
                WHERE user_id = $1
                  AND deleted_at IS NULL
                  AND content ILIKE $2
                ORDER BY created_at DESC
                LIMIT $3
                """,
                user_uuid,
                pattern,
                limit,
            )
            for r in rows:
                results.append(
                    {
                        "source": "notes",
                        "id": str(r["id"]),
                        "conversation_id": str(r["conversation_id"])
                        if r["conversation_id"]
                        else None,
                        "snippet": (r["content"] or "")[:240],
                        "created_at": r["created_at"].isoformat(),
                    }
                )
    return json.dumps(results)


async def _query_sql_handler(pool: asyncpg.Pool, args: dict) -> str:
    """The generic safe-SQL escape hatch.

    Validates against :func:`validate_sql`, then runs with a
    fixed-timeout cursor and capped row count. The result is a
    JSON object ``{columns, rows}``.

    No bound parameters — the model writes literals into its
    query. The whitelist + sensitive-table guards are what makes
    this safe, not parameterisation; the agent's own user_id is
    enforced via the `SET LOCAL eidan.current_user_id` session var
    plus an explicit `WHERE user_id = current_setting(...)::uuid`
    contract the agent is expected to honour.
    """
    sql = args.get("sql")
    if not isinstance(sql, str):
        raise ToolError("memory_query_sql requires 'sql' as a string")
    validate_sql(sql)
    _, identity = _require_identity()

    body = sql.strip().rstrip(";").rstrip()

    async with acquire(pool, identity) as conn:
        try:
            rows = await conn.fetch(
                f"SELECT * FROM ({body}) AS _agent_q LIMIT {_MAX_RESULT_ROWS}",
                timeout=_QUERY_TIMEOUT_S,
            )
        except asyncpg.PostgresError as exc:
            raise ToolError(f"sql execution failed: {exc}") from exc

    columns: list[str] = list(rows[0].keys()) if rows else []
    out_rows: list[list[Any]] = []
    for row in rows:
        out_rows.append([_jsonable(row[col]) for col in columns])
    return json.dumps(
        {
            "columns": columns,
            "rows": out_rows,
            "truncated": len(rows) == _MAX_RESULT_ROWS,
        }
    )


async def _notes_recent_handler(pool: asyncpg.Pool, args: dict) -> str:
    limit = min(int(args.get("limit", 10) or 10), 50)
    conversation_id = args.get("conversation_id")
    user_uuid, identity = _require_identity()
    async with acquire(pool, identity) as conn:
        if conversation_id:
            try:
                cid = UUID(str(conversation_id))
            except ValueError as exc:
                raise ToolError(
                    f"conversation_id {conversation_id!r} is not a UUID"
                ) from exc
            rows = await conn.fetch(
                """
                SELECT id, body, conversation_id, created_at
                FROM eidan.notes
                WHERE user_id = $1 AND conversation_id = $2 AND deleted_at IS NULL
                ORDER BY created_at DESC LIMIT $3
                """,
                user_uuid,
                cid,
                limit,
            )
        else:
            rows = await conn.fetch(
                """
                SELECT id, body, conversation_id, created_at
                FROM eidan.notes
                WHERE user_id = $1 AND deleted_at IS NULL
                ORDER BY created_at DESC LIMIT $2
                """,
                user_uuid,
                limit,
            )
    return json.dumps(
        [
            {
                "id": str(r["id"]),
                "conversation_id": str(r["conversation_id"])
                if r["conversation_id"]
                else None,
                "body": r["body"],
                "created_at": r["created_at"].isoformat(),
            }
            for r in rows
        ]
    )


async def _user_context_handler(pool: asyncpg.Pool, args: dict) -> str:
    key = args.get("key")
    user_uuid, identity = _require_identity()
    async with acquire(pool, identity) as conn:
        if key:
            row = await conn.fetchrow(
                """
                SELECT key, value, updated_at
                FROM eidan.user_context
                WHERE user_id = $1 AND key = $2
                """,
                user_uuid,
                str(key),
            )
            if row is None:
                return json.dumps(None)
            return json.dumps(
                {
                    "key": row["key"],
                    "value": _jsonable(row["value"]),
                    "updated_at": row["updated_at"].isoformat(),
                }
            )
        rows = await conn.fetch(
            """
            SELECT key, value, updated_at
            FROM eidan.user_context
            WHERE user_id = $1
            ORDER BY key
            """,
            user_uuid,
        )
    return json.dumps(
        [
            {
                "key": r["key"],
                "value": _jsonable(r["value"]),
                "updated_at": r["updated_at"].isoformat(),
            }
            for r in rows
        ]
    )


def _jsonable(value: Any) -> Any:
    """Coerce asyncpg's return types to JSON-serialisable shapes."""
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, datetime):
        return value.isoformat()
    if isinstance(value, UUID):
        return str(value)
    if isinstance(value, (list, tuple)):
        return [_jsonable(v) for v in value]
    if isinstance(value, dict):
        return {k: _jsonable(v) for k, v in value.items()}
    return str(value)


# --- registration -------------------------------------------------------


def register_memory_tools(
    registry: ToolRegistry,
    *,
    pool: asyncpg.Pool,
) -> list[str]:
    """Register the six core memory tools against the host's registry.

    Returns the registered tool names so the caller can log them or
    pin them in the surface for the primary call. Each handler
    captures the pool by closure — same pattern as
    :func:`eidan_backend.mcp.register_outbound_tools`.
    """
    registered: list[str] = []

    async def events_due(args: dict) -> str:
        return await _events_due_handler(pool, args)

    async def list_knowledge(args: dict) -> str:
        return await _list_knowledge_handler(pool, args)

    async def get_knowledge(args: dict) -> str:
        return await _get_knowledge_handler(pool, args)

    async def recall(args: dict) -> str:
        return await _recall_handler(pool, args)

    async def query_sql(args: dict) -> str:
        return await _query_sql_handler(pool, args)

    async def notes_recent(args: dict) -> str:
        return await _notes_recent_handler(pool, args)

    async def user_context(args: dict) -> str:
        return await _user_context_handler(pool, args)

    tools = [
        Tool(
            name="memory_events_due",
            description=(
                "List the calling user's pending eidan.events with due_at in "
                "the named window. window: overdue|today|next_7d|next_30d. "
                "Returns id, type, title, due_at, status."
            ),
            input_schema={
                "type": "object",
                "properties": {
                    "window": {
                        "type": "string",
                        "enum": ["overdue", "today", "next_7d", "next_30d"],
                        "default": "today",
                    },
                    "limit": {"type": "integer", "minimum": 1, "maximum": 100},
                },
            },
            handler=events_due,
        ),
        Tool(
            name="memory_list_knowledge",
            description=(
                "List the user's knowledge nodes (id, slug, title, skill, "
                "updated_at). Optional skill filter. Body is omitted to "
                "keep the response compact — call memory_get_knowledge "
                "to fetch one row's body."
            ),
            input_schema={
                "type": "object",
                "properties": {
                    "skill": {"type": "string"},
                    "limit": {"type": "integer", "minimum": 1, "maximum": 100},
                },
            },
            handler=list_knowledge,
        ),
        Tool(
            name="memory_get_knowledge",
            description=(
                "Fetch one knowledge row by id or slug. Returns id, slug, "
                "title, skill, body, source, updated_at."
            ),
            input_schema={
                "type": "object",
                "properties": {
                    "id": {"type": "string", "format": "uuid"},
                    "slug": {"type": "string"},
                },
            },
            handler=get_knowledge,
        ),
        Tool(
            name="memory_recall",
            description=(
                "Substring search across the user's knowledge bodies and "
                "notes bodies. Returns up to `limit` snippets with the "
                "source (knowledge|notes), id, and a 240-char excerpt."
            ),
            input_schema={
                "type": "object",
                "required": ["query"],
                "properties": {
                    "query": {"type": "string"},
                    "table": {
                        "type": "string",
                        "enum": ["all", "knowledge", "notes"],
                        "default": "all",
                    },
                    "limit": {"type": "integer", "minimum": 1, "maximum": 50},
                },
            },
            handler=recall,
        ),
        Tool(
            name="memory_notes_recent",
            description=(
                "Return the user's most recent notes. Optionally scoped to "
                "one conversation_id. Returns id, body, conversation_id, "
                "created_at."
            ),
            input_schema={
                "type": "object",
                "properties": {
                    "conversation_id": {"type": "string", "format": "uuid"},
                    "limit": {"type": "integer", "minimum": 1, "maximum": 50},
                },
            },
            handler=notes_recent,
        ),
        Tool(
            name="memory_user_context",
            description=(
                "Read the user's durable facts (eidan.user_context). With "
                "a key, returns that single value; without one, returns "
                "every row."
            ),
            input_schema={
                "type": "object",
                "properties": {
                    "key": {"type": "string"},
                },
            },
            handler=user_context,
        ),
        Tool(
            name="memory_query_sql",
            description=(
                "Run an arbitrary SELECT against any table in any schema. "
                "Use this when the structured memory_* tools above don't fit "
                "the question. Only SELECT statements (no DML, no DDL). "
                "Every schema is readable — eidan.*, plugin_*.*, pg_catalog, "
                "information_schema — EXCEPT eidan.auth_keypair and "
                "eidan.secrets_vault, which hold encrypted secret material. "
                "Returns {columns, rows, truncated}. The query is capped at "
                "200 rows and a 5-second timeout. For any table that has a "
                "user_id column, include "
                "WHERE user_id = current_setting('eidan.current_user_id')::uuid "
                "in your WHERE clause — RLS isn't always installed. Use "
                "pg_catalog.pg_tables / information_schema.columns to "
                "discover the schema before writing a join."
            ),
            input_schema={
                "type": "object",
                "required": ["sql"],
                "properties": {
                    "sql": {
                        "type": "string",
                        "description": (
                            "A single SELECT (or CTE WITH … SELECT). "
                            "Qualify table references as <schema>.<table>."
                        ),
                    },
                },
            },
            handler=query_sql,
        ),
    ]
    for tool in tools:
        registry.register(tool)
        registered.append(tool.name)
    return registered


__all__ = [
    "SqlValidationError",
    "register_memory_tools",
    "validate_sql",
]
