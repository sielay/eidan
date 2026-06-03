"""HTTP route handlers.

The routes are wired in :func:`eidan_backend.http.app.create_app`.
Per ``docs/005 §5.1`` the runner enters one ``acquire()``-managed
transaction per write batch — these handlers follow the same shape and
do not re-implement DB session handling.

The streaming endpoint (``POST /api/turn``) emits the SSE wire shape
pinned in the issue:

    event: chunk
    data: {"text": "..."}

    event: complete
    data: {"user_message_id": "...", "assistant_message_id": "..."}

Client disconnects cancel the in-flight provider call by tearing down
the streaming generator (``asyncio.CancelledError`` propagates into the
async iterator and unwinds the provider context manager).
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
from collections.abc import AsyncIterator
from datetime import UTC, datetime, timedelta
from typing import Annotated, Any
from uuid import UUID

from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from ..auth_native import (
    issue_access_token,
    mint_refresh_token,
)
from ..auth_native.allowed_email import get_allowed_email
from ..auth_native.magic_link import (
    MagicLinkExpired,
    MagicLinkNotFound,
    MagicLinkUnauthorized,
    consume_magic_link,
    issue_magic_link,
)
from ..auth_native.sessions import (
    SessionExpired,
    SessionNotFound,
    create_session,
    lookup_active_session,
    revoke_session,
    touch_session,
)
from ..auth_native.smtp import is_production, send_magic_link_email
from ..auth_native.users import ensure_user_by_email
from ..conversation_title import generate_conversation_title
from ..db import acquire
from ..escalations import (
    acknowledge_escalation,
    list_escalations,
    resolve_escalation,
)
from ..knowledge_links import neighbours, record_links_for
from ..loop import TurnComplete, TurnContext, run_turn
from ..mcp import call_inbound_tool, list_inbound_tools
from ..persistence import (
    conversation_belongs_to,
    cost_summary_for_turn,
    cost_summary_since,
    count_conversation_messages,
    create_conversation,
    decode_jsonb,
    ensure_default_agent_context,
    first_turn_pair,
    latest_user_message_id,
    list_conversations,
    load_full_conversation_messages,
    update_conversation_title,
    upsert_user,
)
from ..providers.base import AssistantChunk
from .rate_limit import (
    RateLimitExceeded,
    extract_client_ip,
    get_or_create_limiter,
)

# Refresh-token cookie name + scope. The cookie is scoped to
# /api/auth/refresh so it never piggybacks on regular API calls
# (those carry the access JWT in Authorization instead).
_REFRESH_COOKIE_NAME = "eidan_refresh"
_REFRESH_COOKIE_PATH = "/api/auth/refresh"

router = APIRouter()
logger = logging.getLogger(__name__)


# -----------------------------------------------------------------------------
# /api/healthz
# -----------------------------------------------------------------------------


@router.get("/api/healthz")
async def get_healthz() -> dict[str, str]:
    """Process-liveness probe.

    Public, unauthenticated (on the allowlist in ``http.auth``). Used
    by the self-hosted systemd watchdog in ``infra/systemd/`` and by
    any external uptime monitor. Returns 200 as long as the ASGI app
    is up enough to route a request — it does NOT touch the DB or any
    downstream dependency. Deeper checks belong on ``/api/readyz``
    when that lands.
    """
    return {"status": "ok"}


# -----------------------------------------------------------------------------
# /api/auth/config
# -----------------------------------------------------------------------------


@router.get("/api/auth/config")
async def get_auth_config(request: Request) -> dict[str, Any]:
    """Publishable auth config the web UI renders into the login form.

    Public, unauthenticated. Returns only the list of enabled
    providers + optional ToS/privacy URLs — anything PII-shaped
    (operator email, instance-private hints) MUST stay out of this
    response. The verify endpoint re-checks ``EIDAN_AUTH_ALLOWED_EMAIL``
    server-side on every magic-link submission, so the UI doesn't
    need the email upfront to enforce the pin.
    """
    started_at = time.perf_counter()
    request_id = getattr(request.state, "request_id", "-")
    # Log whether the pin env var is configured so operators can
    # tell at-a-glance whether they forgot to set it; the value
    # itself is never logged and never on the wire.
    allowed_email_configured = get_allowed_email() is not None
    payload = {
        "provider": "native",
        "providers": ["magic_link"],
        "tos_url": None,
        "privacy_url": None,
    }
    logger.info(
        "[auth-config] served request_id=%s elapsed_ms=%.1f "
        "allowed_email_configured=%s",
        request_id,
        (time.perf_counter() - started_at) * 1000,
        allowed_email_configured,
    )
    return payload


# -----------------------------------------------------------------------------
# /api/auth/magic-link
# -----------------------------------------------------------------------------


class MagicLinkBody(BaseModel):
    """Body for ``POST /api/auth/magic-link``."""

    email: str = Field(..., min_length=3, max_length=254)


@router.post("/api/auth/magic-link")
async def post_magic_link(
    body: MagicLinkBody,
    request: Request,
) -> dict[str, Any]:
    """Mint a magic link for the operator's email + send it.

    Always returns 202 with the same envelope regardless of whether
    the email was allowed, dispatched, or rejected — this prevents
    an attacker from enumerating valid emails by timing the response.

    In dev (``EIDAN_DEPLOYMENT_MODE != production``) the response
    body also includes the raw ``magic_link`` URL + ``code`` so the
    operator doesn't need an SMTP server / mail viewer running. In
    prod those fields are omitted.
    """
    pool = request.app.state.pool
    email = body.email.strip()
    logger.info("[auth] magic-link request email=%s", email)

    issued = None
    async with pool.acquire() as conn:
        try:
            issued = await issue_magic_link(conn, email=email)
        except MagicLinkUnauthorized:
            logger.warning(
                "[auth] magic-link refused (not in allow-list): email=%s",
                email,
            )

    payload: dict[str, Any] = {"status": "sent"}
    if issued is not None:
        # Build the URL the email points at. The base origin is what
        # the operator hit us at — so it works behind the Caddy
        # proxy or a direct backend port.
        origin = request.headers.get("origin") or str(request.base_url).rstrip("/")
        magic_link_url = f"{origin}/login?token={issued.token}"
        await send_magic_link_email(
            to_email=issued.email,
            magic_link_url=magic_link_url,
            code=issued.code,
        )
        if not is_production():
            # Dev convenience: echo the link + code so the operator
            # can click without SMTP.
            payload["magic_link"] = magic_link_url
            payload["code"] = issued.code
    return payload


# -----------------------------------------------------------------------------
# /api/auth/verify  — exchange a magic-link token/code for a JWT pair
# -----------------------------------------------------------------------------


class VerifyBody(BaseModel):
    """Body for ``POST /api/auth/verify``. Exactly one of token /
    code is required."""

    token: str | None = None
    code: str | None = None


@router.post("/api/auth/verify")
async def post_verify(
    body: VerifyBody,
    request: Request,
) -> dict[str, Any]:
    """Atomic claim of a magic link → JWT pair.

    Marks the magic-link row consumed, upserts the user row, mints
    an access JWT + a refresh token (the latter goes into an
    httpOnly cookie scoped to ``/api/auth/refresh``).
    """
    if (body.token is None) == (body.code is None):
        raise HTTPException(
            status_code=400,
            detail="exactly one of token / code must be provided",
        )

    pool = request.app.state.pool
    async with pool.acquire() as conn:
        try:
            consumed = await consume_magic_link(
                conn, token=body.token, code=body.code
            )
        except MagicLinkNotFound as exc:
            raise HTTPException(status_code=404, detail="invalid token") from exc
        except MagicLinkExpired as exc:
            raise HTTPException(status_code=410, detail="token expired or already used") from exc

        # First-login mints a fresh UUID; subsequent logins resolve to
        # the existing row.
        user_id = await ensure_user_by_email(conn, email=consumed.email)

    # Mint the pair against the host's cached keypair (stashed by the
    # bootstrap; see http/app.py).
    private_pem: bytes = request.app.state.auth_private_pem
    raw_refresh, _ = mint_refresh_token()

    # Write the session row + use its id as the access token's sid
    # claim. Atomic per-request: a second pool.acquire is fine —
    # the writes don't span transactions.
    async with pool.acquire() as conn:
        session_id = await create_session(
            conn,
            user_id=user_id,
            raw_refresh=raw_refresh,
            user_agent=request.headers.get("user-agent"),
            ip_address=extract_client_ip(request),
        )

    access_token = issue_access_token(
        private_pem=private_pem,
        user_id=str(user_id),
        email=consumed.email,
        session_id=str(session_id),
    )

    from fastapi.responses import JSONResponse

    response = JSONResponse(
        {
            "access_token": access_token,
            "token_type": "bearer",
            "expires_in": 60 * 60 * 24,
            "user": {"id": str(user_id), "email": consumed.email},
        }
    )
    response.set_cookie(
        key=_REFRESH_COOKIE_NAME,
        value=raw_refresh,
        httponly=True,
        secure=is_production(),
        samesite="lax",
        path=_REFRESH_COOKIE_PATH,
        max_age=60 * 60 * 24 * 30,  # 30 days, matches REFRESH_TOKEN_TTL_DAYS
    )
    return response  # type: ignore[return-value]


# -----------------------------------------------------------------------------
# /api/auth/refresh — exchange the refresh cookie for a fresh access JWT
# -----------------------------------------------------------------------------


@router.post("/api/auth/refresh")
async def post_refresh(request: Request) -> dict[str, Any]:
    """Mint a fresh access JWT from the refresh cookie.

    The refresh token doesn't rotate today (no replay protection
    against a stolen cookie); when we add IP/UA fingerprinting that
    behaviour lands here.
    """
    raw_refresh = request.cookies.get(_REFRESH_COOKIE_NAME)
    if not raw_refresh:
        raise HTTPException(status_code=401, detail="missing refresh cookie")

    pool = request.app.state.pool
    async with pool.acquire() as conn:
        try:
            session = await lookup_active_session(conn, raw_refresh=raw_refresh)
        except (SessionNotFound, SessionExpired) as exc:
            raise HTTPException(status_code=401, detail="session expired") from exc

        # Bump last-used and fetch the email for the new JWT.
        await touch_session(conn, session_id=session["id"])
        user_row = await conn.fetchrow(
            "SELECT email FROM eidan.users WHERE id = $1",
            session["user_id"],
        )

    if user_row is None or user_row["email"] is None:
        raise HTTPException(status_code=401, detail="user record missing")

    private_pem: bytes = request.app.state.auth_private_pem
    access_token = issue_access_token(
        private_pem=private_pem,
        user_id=str(session["user_id"]),
        email=str(user_row["email"]),
        session_id=str(session["id"]),
    )
    return {
        "access_token": access_token,
        "token_type": "bearer",
        "expires_in": 60 * 60 * 24,
    }


# -----------------------------------------------------------------------------
# /api/auth/logout — revoke the current session
# -----------------------------------------------------------------------------


@router.post("/api/auth/logout")
async def post_logout(request: Request) -> Any:
    """Revoke the current session. Idempotent; always 204.

    Declared without ``status_code=204`` on the decorator because the
    handler returns a :class:`Response` that already carries the
    status — FastAPI refuses to register a 204 route with a response
    body schema, but a directly-returned ``Response`` is fine.
    """
    raw_refresh = request.cookies.get(_REFRESH_COOKIE_NAME)
    if raw_refresh:
        pool = request.app.state.pool
        async with pool.acquire() as conn:
            await revoke_session(conn, raw_refresh=raw_refresh)

    from fastapi.responses import Response

    response = Response(status_code=204)
    response.delete_cookie(
        key=_REFRESH_COOKIE_NAME,
        path=_REFRESH_COOKIE_PATH,
    )
    return response


# -----------------------------------------------------------------------------
# /api/agent — operator's per-user agent_context persona surface
# -----------------------------------------------------------------------------


class AgentPersonaBody(BaseModel):
    """Body for ``PUT /api/agent``. ``persona`` is the new value for
    ``user_overrides.system_prompt``; ``null`` clears it.
    """

    persona: str | None = Field(default=None, max_length=20_000)


def _serialise_agent_row(row: Any, persona: str | None) -> dict[str, Any]:
    code_defaults = decode_jsonb(row["code_defaults"])
    user_overrides = decode_jsonb(row["user_overrides"])
    return {
        "id": str(row["id"]),
        "agent_slug": row["agent_slug"],
        "display_name": row["display_name"],
        "description": row["description"],
        "enabled": row["enabled"],
        "code_defaults": code_defaults,
        "user_overrides": user_overrides,
        "persona": persona,
        "updated_at": row["updated_at"].isoformat(),
    }


@router.get("/api/agent")
async def get_agent(request: Request) -> dict[str, Any]:
    """Return the authenticated user's default agent_context row.

    Idempotently creates the row if first sight (the loop does the same
    on the next turn). The ``persona`` field is the effective override
    chain (``user_overrides → code_defaults → null``) — what the loop
    will actually render after EIDAN_BASE_IDENTITY.
    """
    identity = request.state.identity
    user_uuid = UUID(identity.user_id)
    pool = request.app.state.pool

    async with acquire(pool, identity) as conn:
        await upsert_user(conn, user_id=user_uuid, email=identity.email)
        agent_id, persona = await ensure_default_agent_context(
            conn, user_id=user_uuid
        )
        row = await conn.fetchrow(
            """
            SELECT id, agent_slug, display_name, description, enabled,
                   code_defaults, user_overrides, updated_at
            FROM eidan.agent_context
            WHERE id = $1
            """,
            agent_id,
        )

    assert row is not None
    return {"agent": _serialise_agent_row(row, persona)}


@router.put("/api/agent")
async def put_agent(
    request: Request, body: AgentPersonaBody
) -> dict[str, Any]:
    """Write ``user_overrides.system_prompt`` for the authenticated user's
    default agent.

    Body shape:

        { "persona": "You are concise and direct." }   # set
        { "persona": null }                            # clear
        { "persona": "" }                              # also clears

    Returns the same envelope as ``GET /api/agent`` so the UI can update
    its local state without a follow-up fetch.
    """
    identity = request.state.identity
    user_uuid = UUID(identity.user_id)
    pool = request.app.state.pool

    persona = body.persona
    if persona is not None:
        persona = persona.strip()
        if not persona:
            persona = None

    async with acquire(pool, identity) as conn:
        await upsert_user(conn, user_id=user_uuid, email=identity.email)
        agent_id, _ = await ensure_default_agent_context(
            conn, user_id=user_uuid
        )
        if persona is None:
            await conn.execute(
                """
                UPDATE eidan.agent_context
                SET user_overrides = user_overrides - 'system_prompt'
                WHERE id = $1
                """,
                agent_id,
            )
        else:
            await conn.execute(
                """
                UPDATE eidan.agent_context
                SET user_overrides =
                    COALESCE(user_overrides, '{}'::jsonb) || $2::jsonb
                WHERE id = $1
                """,
                agent_id,
                json.dumps({"system_prompt": persona}),
            )

        # Re-read so the response carries the canonical post-write shape
        # (including ``updated_at``, which the BEFORE-UPDATE trigger
        # bumps).
        _, effective_persona = await ensure_default_agent_context(
            conn, user_id=user_uuid
        )
        row = await conn.fetchrow(
            """
            SELECT id, agent_slug, display_name, description, enabled,
                   code_defaults, user_overrides, updated_at
            FROM eidan.agent_context
            WHERE id = $1
            """,
            agent_id,
        )

    assert row is not None
    return {"agent": _serialise_agent_row(row, effective_persona)}


# -----------------------------------------------------------------------------
# /api/mcp  (docs/013 — inbound MCP server)
# -----------------------------------------------------------------------------


@router.get("/api/mcp/tools")
async def mcp_list_tools(request: Request) -> dict[str, Any]:
    """List the tools the host exposes to external MCP clients.

    Only tools registered with ``expose_to_external_mcp = True``
    appear. Phase 1's HTTP surface stands in for the full stdio / SSE
    MCP transport from `docs/013 §4`; the response shape matches the
    MCP ``list_tools`` envelope so a real transport can wrap this
    handler later.
    """
    registry = request.app.state.tool_registry
    return {
        "tools": [
            {
                "name": t.name,
                "description": t.description,
                "input_schema": t.input_schema,
            }
            for t in list_inbound_tools(registry)
        ]
    }


class _McpToolCallBody(BaseModel):
    name: str
    arguments: dict[str, Any] = Field(default_factory=dict)


@router.post("/api/mcp/tools/call")
async def mcp_call_tool(
    request: Request, body: _McpToolCallBody
) -> dict[str, Any]:
    """Dispatch an MCP ``tools/call`` against the host's registry.

    External callers may only invoke tools whose
    ``expose_to_external_mcp`` flag is set — others surface as
    ``{"isError": true, ...}`` envelopes per `docs/013 §4.1`.
    """
    registry = request.app.state.tool_registry
    return await call_inbound_tool(
        registry, name=body.name, arguments=body.arguments
    )


# -----------------------------------------------------------------------------
# /api/knowledge  (docs/014 §5 — knowledge browser)
# -----------------------------------------------------------------------------


@router.get("/api/knowledge")
async def list_knowledge(
    request: Request,
    skill: Annotated[str | None, Query()] = None,
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
) -> dict[str, Any]:
    """Read-only knowledge index for the UI browser (`docs/014 §5`).

    Returns each row's id, slug, title, skill tag, and the
    timestamps. ``skill`` filters server-side so the UI's
    skill-grouped browser doesn't paginate over rows it'll throw
    away.
    """
    identity = request.state.identity
    user_uuid = UUID(identity.user_id)
    pool = request.app.state.pool
    async with acquire(pool, identity) as conn:
        if skill:
            rows = await conn.fetch(
                """
                SELECT id, slug, title, skill, updated_at, created_at
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
                SELECT id, slug, title, skill, updated_at, created_at
                FROM eidan.knowledge
                WHERE user_id = $1
                  AND deleted_at IS NULL
                ORDER BY updated_at DESC
                LIMIT $2
                """,
                user_uuid,
                limit,
            )
    return {
        "knowledge": [
            {
                "id": str(row["id"]),
                "slug": row["slug"],
                "title": row["title"],
                "skill": row["skill"],
                "updated_at": row["updated_at"].isoformat(),
                "created_at": row["created_at"].isoformat(),
            }
            for row in rows
        ]
    }


@router.get("/api/knowledge/{knowledge_id}")
async def get_knowledge_row(
    request: Request, knowledge_id: UUID
) -> dict[str, Any]:
    """One knowledge row, body included. Used by the browser's
    detail panel and by the seance / continuation paths."""
    identity = request.state.identity
    user_uuid = UUID(identity.user_id)
    pool = request.app.state.pool
    async with acquire(pool, identity) as conn:
        row = await conn.fetchrow(
            """
            SELECT id, slug, title, skill, body, source,
                   updated_at, created_at
            FROM eidan.knowledge
            WHERE user_id = $1
              AND id = $2
              AND deleted_at IS NULL
            """,
            user_uuid,
            knowledge_id,
        )
    if row is None:
        raise HTTPException(status_code=404, detail="knowledge row not found")
    return {
        "knowledge": {
            "id": str(row["id"]),
            "slug": row["slug"],
            "title": row["title"],
            "skill": row["skill"],
            "body": row["body"],
            "source": row["source"],
            "updated_at": row["updated_at"].isoformat(),
            "created_at": row["created_at"].isoformat(),
        }
    }


@router.patch("/api/knowledge/{knowledge_id}")
async def update_knowledge_row(
    request: Request, knowledge_id: UUID
) -> dict[str, Any]:
    """Partial update of one knowledge row from the UI (`docs/014 §5`).

    Body shape is pinned by ``KnowledgeUpdate`` in
    ``packages/schemas/schemas/core/memory/``. ``expected_updated_at``
    is the operator's last-known ``updated_at``; the row is updated
    only when it still matches at write time, otherwise the route
    returns 409 so the UI can refetch instead of clobbering an
    agent-side write. Body edits re-run the ``docs/017 §3`` link
    extractor in the same transaction so ``knowledge_links`` stays
    consistent.
    """
    from eidan_schemas import KnowledgeUpdate

    try:
        payload = KnowledgeUpdate.model_validate(await request.json())
    except ValueError as err:
        raise HTTPException(status_code=400, detail=str(err)) from err

    identity = request.state.identity
    user_uuid = UUID(identity.user_id)
    pool = request.app.state.pool

    fields = payload.model_dump(exclude_unset=True)
    expected_updated_at = fields.pop("expected_updated_at")
    if not fields:
        raise HTTPException(
            status_code=400,
            detail="at least one of title / body / skill must be supplied",
        )

    set_clauses: list[str] = []
    args: list[Any] = [user_uuid, knowledge_id, expected_updated_at]
    for col, value in fields.items():
        args.append(value)
        set_clauses.append(f"{col} = ${len(args)}")
    set_sql = ", ".join(set_clauses) + ", updated_at = now()"

    async with acquire(pool, identity) as conn:
        async with conn.transaction():
            row = await conn.fetchrow(
                f"""
                UPDATE eidan.knowledge
                SET {set_sql}
                WHERE user_id = $1
                  AND id = $2
                  AND deleted_at IS NULL
                  AND updated_at = $3
                RETURNING id, slug, title, skill, body, source,
                          updated_at, created_at
                """,
                *args,
            )
            if row is None:
                live = await conn.fetchrow(
                    """
                    SELECT updated_at, deleted_at
                    FROM eidan.knowledge
                    WHERE user_id = $1 AND id = $2
                    """,
                    user_uuid,
                    knowledge_id,
                )
                if live is None or live["deleted_at"] is not None:
                    raise HTTPException(
                        status_code=404, detail="knowledge row not found"
                    )
                raise HTTPException(
                    status_code=409,
                    detail="knowledge row was modified since fetch; refetch and retry",
                )
            if "body" in fields:
                await record_links_for(
                    conn,
                    user_id=user_uuid,
                    from_knowledge_id=knowledge_id,
                    body=row["body"],
                )
    return {
        "knowledge": {
            "id": str(row["id"]),
            "slug": row["slug"],
            "title": row["title"],
            "skill": row["skill"],
            "body": row["body"],
            "source": row["source"],
            "updated_at": row["updated_at"].isoformat(),
            "created_at": row["created_at"].isoformat(),
        }
    }


@router.delete("/api/knowledge/{knowledge_id}", status_code=204)
async def delete_knowledge_row(
    request: Request, knowledge_id: UUID
) -> None:
    """Soft-delete a knowledge row from the UI (`docs/014 §5`).

    Sets ``deleted_at = now()`` per the soft-delete convention
    (`docs/003 §1.3`). Idempotent — repeat calls against an
    already-deleted row return 204 without touching the DB beyond the
    initial check.
    """
    identity = request.state.identity
    user_uuid = UUID(identity.user_id)
    pool = request.app.state.pool
    async with acquire(pool, identity) as conn:
        async with conn.transaction():
            row = await conn.fetchrow(
                """
                UPDATE eidan.knowledge
                SET deleted_at = now(), updated_at = now()
                WHERE user_id = $1
                  AND id = $2
                  AND deleted_at IS NULL
                RETURNING id
                """,
                user_uuid,
                knowledge_id,
            )
            if row is None:
                # Distinguish "never existed" from "already deleted".
                exists = await conn.fetchval(
                    "SELECT 1 FROM eidan.knowledge WHERE user_id = $1 AND id = $2",
                    user_uuid,
                    knowledge_id,
                )
                if not exists:
                    raise HTTPException(
                        status_code=404, detail="knowledge row not found"
                    )
                return None
            # The soft-deleted row's own outbound link rows stay
            # behind — `docs/017 §5.2` joins backlinks through the
            # source's `deleted_at IS NULL`, so they naturally vanish
            # from every read path without a destructive cleanup.
    return None


# -----------------------------------------------------------------------------
# /api/commands  (docs/019, docs/014 §7 — command palette)
# -----------------------------------------------------------------------------


@router.get("/api/commands")
async def list_commands(request: Request) -> dict[str, Any]:
    """Return every registered plugin command for the Cmd-K palette
    (`docs/014 §7`). Description ships verbatim so the palette can
    render it under each command name without a second round-trip.
    """
    registry = getattr(request.app.state, "command_registry", None)
    if registry is None:
        return {"commands": []}
    return {
        "commands": [
            {
                "name": c.name,
                "description": c.description,
                "plugin": c.plugin,
                "idempotent": c.idempotent,
            }
            for c in registry.all()
        ]
    }


# -----------------------------------------------------------------------------
# /api/knowledge/{id}/neighbours  (docs/017 §5)
# -----------------------------------------------------------------------------


@router.get("/api/knowledge/{knowledge_id}/neighbours")
async def list_neighbours(
    request: Request,
    knowledge_id: UUID,
    depth: Annotated[int, Query(ge=0, le=4)] = 1,
    limit: Annotated[int, Query(ge=1, le=200)] = 64,
) -> dict[str, Any]:
    """BFS frontier around a knowledge node.

    Walks both directions (outbound + inbound) per `docs/017 §5`.
    ``depth=0`` returns the seed alone; ``depth=N`` returns the seed
    plus everything reachable within N hops, capped at ``limit``
    nodes.
    """
    identity = request.state.identity
    user_uuid = UUID(identity.user_id)
    pool = request.app.state.pool
    async with acquire(pool, identity) as conn:
        result = await neighbours(
            conn,
            user_id=user_uuid,
            seed_id=knowledge_id,
            depth=depth,
            limit=limit,
        )
    return {
        "seed_id": str(knowledge_id),
        "depth": depth,
        "neighbours": [
            {
                "id": str(n.id),
                "slug": n.slug,
                "title": n.title,
                "hops": n.hops,
            }
            for n in result
        ],
    }


# -----------------------------------------------------------------------------
# /api/escalations  (docs/022)
# -----------------------------------------------------------------------------


_ESCALATION_STATUS_VALUES: frozenset[str] = frozenset(
    {"pending", "acknowledged", "resolved", "all"}
)


def _serialise_escalation(row: Any) -> dict[str, Any]:
    return {
        "id": str(row.id),
        "conversation_id": (
            str(row.conversation_id) if row.conversation_id else None
        ),
        "agent_id": str(row.agent_id) if row.agent_id else None,
        "severity": row.severity,
        "reason_class": row.reason_class,
        "suggested_action": row.suggested_action,
        "evidence": row.evidence,
        "metadata": row.metadata,
        "status": row.status,
        "created_at": row.created_at.isoformat(),
        "updated_at": row.updated_at.isoformat(),
        "resolved_at": (
            row.resolved_at.isoformat() if row.resolved_at else None
        ),
    }


@router.get("/api/escalations")
async def list_escalations_endpoint(
    request: Request,
    status: Annotated[
        str,
        Query(
            description=(
                "Filter — one of pending (default) / acknowledged / "
                "resolved / all. The pending index is partial, so the "
                "default path is the fast one."
            )
        ),
    ] = "pending",
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
) -> dict[str, Any]:
    """List the calling user's escalations.

    Per ``docs/022 §3`` an escalation is a structured "I'm blocked"
    signal an agent / behaviour / loop step emitted. The operator UI
    paints them here; the lifecycle endpoints below advance them
    through ``acknowledged`` → ``resolved``.
    """
    if status not in _ESCALATION_STATUS_VALUES:
        raise HTTPException(
            status_code=400, detail=f"unknown status filter: {status}"
        )
    identity = request.state.identity
    user_uuid = UUID(identity.user_id)
    pool = request.app.state.pool
    filter_status = None if status == "all" else status
    async with acquire(pool, identity) as conn:
        rows = await list_escalations(
            conn, user_id=user_uuid, status=filter_status, limit=limit
        )
    return {"escalations": [_serialise_escalation(r) for r in rows]}


@router.post("/api/escalations/{escalation_id}/acknowledge")
async def acknowledge_escalation_endpoint(
    request: Request, escalation_id: UUID
) -> dict[str, Any]:
    """Move an escalation ``pending`` → ``acknowledged``.

    Returns 404 when the row doesn't belong to the caller or has
    already left the ``pending`` state — the UI re-renders the list
    from this response, so a stale optimistic update converges.
    """
    identity = request.state.identity
    user_uuid = UUID(identity.user_id)
    pool = request.app.state.pool
    async with acquire(pool, identity) as conn:
        moved = await acknowledge_escalation(
            conn, escalation_id=escalation_id, user_id=user_uuid
        )
    if not moved:
        raise HTTPException(
            status_code=404,
            detail="escalation not found or already past pending",
        )
    return {"ok": True}


@router.post("/api/escalations/{escalation_id}/resolve")
async def resolve_escalation_endpoint(
    request: Request, escalation_id: UUID
) -> dict[str, Any]:
    """Mark an escalation ``resolved``. Idempotent — resolving a
    row that's already resolved is a no-op that still returns 200."""
    identity = request.state.identity
    user_uuid = UUID(identity.user_id)
    pool = request.app.state.pool
    async with acquire(pool, identity) as conn:
        moved = await resolve_escalation(
            conn, escalation_id=escalation_id, user_id=user_uuid
        )
    if not moved:
        raise HTTPException(
            status_code=404, detail="escalation not found"
        )
    return {"ok": True}


# -----------------------------------------------------------------------------
# /api/webhooks/{plugin}/{slug}
# -----------------------------------------------------------------------------


@router.post("/api/webhooks/{plugin}/{slug}")
async def post_webhook(plugin: str, slug: str, request: Request) -> dict[str, Any]:
    """Receive an inbound webhook and dispatch to subscribing behaviours.

    Per ``docs/001 §5.1`` a behaviour declared with ``webhook:<slug>``
    is reachable at ``POST /api/webhooks/<plugin>/<slug>``. The route is
    public (no JWT) — third-party services don't hold an Eidan token.
    Per-plugin signature verification is the handler's responsibility
    (`docs/012`); the host's only job here is to resolve subscribers
    and dispatch.

    Rate-limited per ``(plugin, slug, client_ip)`` (audit §5 fix
    3/3) — defaults to 60/min, configurable via
    ``EIDAN_WEBHOOK_RATE_LIMIT_PER_MINUTE``. 429 with
    ``Retry-After`` when the budget's gone.

    Returns ``{ "ok": true, "fired": N }`` when at least one subscriber
    is registered; ``404`` when none match. Bodies that aren't JSON are
    passed through as ``{"raw": "<text>"}`` so handlers that need the
    raw payload (e.g. for HMAC verification) can still inspect it.
    """
    limiter = get_or_create_limiter(request.app.state)
    client_ip = extract_client_ip(request)
    key = f"{plugin}:{slug}:{client_ip}"
    try:
        await limiter.check(key)
    except RateLimitExceeded as exc:
        raise HTTPException(
            status_code=429,
            detail={
                "code": "webhook.rate_limited",
                "message": (
                    f"rate limit exceeded for {plugin}/{slug}; "
                    f"retry after {exc.retry_after}s"
                ),
                "retry_after_seconds": exc.retry_after,
            },
            headers={"Retry-After": str(exc.retry_after)},
        ) from exc

    dispatcher = getattr(request.app.state, "behaviour_dispatcher", None)
    if dispatcher is None:
        raise HTTPException(
            status_code=503, detail="behaviour dispatcher is not running"
        )

    # Accept JSON when the body looks like JSON; fall back to raw text.
    raw = await request.body()
    payload: dict[str, Any]
    content_type = (request.headers.get("content-type") or "").split(";", 1)[0].strip()
    if content_type == "application/json" and raw:
        try:
            decoded = json.loads(raw)
        except ValueError as exc:
            raise HTTPException(
                status_code=400, detail=f"invalid JSON body: {exc}"
            ) from exc
        if not isinstance(decoded, dict):
            # Wrap arrays/primitives so the handler always sees a dict.
            payload = {"body": decoded}
        else:
            payload = decoded
    else:
        payload = {"raw": raw.decode("utf-8", errors="replace")} if raw else {}

    results = await dispatcher.publish_webhook(plugin, slug, payload)
    if not results:
        # No subscribers for this (plugin, slug) — either the plugin is
        # not installed or it never declared a webhook with this slug.
        raise HTTPException(
            status_code=404,
            detail=f"no subscribers for webhook {plugin}/{slug}",
        )
    return {"ok": True, "fired": len(results)}


# -----------------------------------------------------------------------------
# /api/plugins
# -----------------------------------------------------------------------------


@router.get("/api/plugins")
async def get_plugins(request: Request) -> dict[str, Any]:
    """List the plugins the host loaded at startup.

    Read-only metadata snapshot of the in-memory ``BootstrapResult.plugins``
    list — no DB query. Authenticated like every non-config route; the
    sidebar fetches this once on mount to populate the "Plugins" section.

    ``enabled`` is always ``True`` in this slice because a failed plugin
    is rejected at load time (`docs/001 §1`) rather than appearing in the
    registry as disabled. The field is in the response shape so a future
    operator-controlled enable/disable surface doesn't break the wire
    contract.
    """
    plugins = getattr(request.app.state, "plugins", []) or []
    identity = getattr(request.app.state, "node_identity", None)
    node_payload: dict[str, str] | None = (
        {"node_id": identity.node_id, "node_type": identity.node_type}
        if identity is not None
        else None
    )
    return {
        "node": node_payload,
        "plugins": [
            {
                "name": p.manifest.name,
                "display_name": p.manifest.display_name or p.manifest.name,
                "tier": p.manifest.tier.value
                if hasattr(p.manifest.tier, "value")
                else str(p.manifest.tier),
                "version": p.manifest.version,
                "description": p.manifest.description,
                "enabled": True,
            }
            for p in plugins
        ],
    }


@router.get("/api/plugins/{name}")
async def get_plugin(request: Request, name: str) -> dict[str, Any]:
    """Detail view for a single loaded plugin.

    Returns the manifest fields the operator wants on the per-plugin
    info page (`/plugins/<name>` in the web UI) plus the plugin's
    ``README.md`` body if one ships next to the manifest. README is
    read from disk per request — the file is small, the route is
    operator-facing and rarely hit, and not caching avoids a stale
    body after an in-place edit on a dev install.
    """
    plugins = getattr(request.app.state, "plugins", []) or []
    loaded = next((p for p in plugins if p.manifest.name == name), None)
    if loaded is None:
        raise HTTPException(status_code=404, detail="unknown plugin")

    manifest = loaded.manifest
    tier = (
        manifest.tier.value
        if hasattr(manifest.tier, "value")
        else str(manifest.tier)
    )
    authors = (
        [
            {"name": a.name, "email": getattr(a, "email", None)}
            for a in (manifest.authors or [])
        ]
        if getattr(manifest, "authors", None)
        else []
    )

    readme: str | None = None
    plugin_dir = getattr(loaded, "plugin_dir", None)
    if plugin_dir is not None:
        readme_path = plugin_dir / "README.md"
        if readme_path.is_file():
            try:
                readme = readme_path.read_text(encoding="utf-8")
            except OSError:
                readme = None

    return {
        "name": manifest.name,
        "display_name": manifest.display_name or manifest.name,
        "tier": tier,
        "version": manifest.version,
        "description": manifest.description,
        "license": getattr(manifest, "license", None),
        "authors": authors,
        "readme": readme,
    }


# -----------------------------------------------------------------------------
# /api/conversations
# -----------------------------------------------------------------------------


class CreateConversationBody(BaseModel):
    title: str | None = Field(default=None, max_length=200)


@router.post("/api/conversations")
async def post_conversations(
    request: Request, body: CreateConversationBody
) -> dict[str, Any]:
    """Create a new conversation owned by the authenticated user."""
    identity = request.state.identity
    user_uuid = UUID(identity.user_id)
    pool = request.app.state.pool

    async with acquire(pool, identity) as conn:
        await upsert_user(conn, user_id=user_uuid, email=identity.email)
        conversation_id = await create_conversation(
            conn, user_id=user_uuid, title=body.title
        )

    return {"id": str(conversation_id), "title": body.title}


@router.get("/api/conversations")
async def get_conversations(request: Request) -> dict[str, Any]:
    """List the authenticated user's most recent conversations."""
    identity = request.state.identity
    user_uuid = UUID(identity.user_id)
    pool = request.app.state.pool

    async with acquire(pool, identity) as conn:
        await upsert_user(conn, user_id=user_uuid, email=identity.email)
        rows = await list_conversations(conn, user_id=user_uuid)

    return {
        "conversations": [
            {
                "id": str(row["id"]),
                "title": row["title"],
                "created_at": row["created_at"].isoformat(),
                "updated_at": row["updated_at"].isoformat(),
            }
            for row in rows
        ]
    }


@router.get("/api/conversations/{conversation_id}")
async def get_conversation(
    request: Request, conversation_id: UUID
) -> dict[str, Any]:
    """Fetch a single conversation row by id.

    The list endpoint already returns title + timestamps, but the
    chat-view route needs to render its own header without
    re-fetching the whole sidebar payload. Returns 404 if the row
    doesn't exist or isn't owned by the caller — same envelope as the
    other ownership-guarded conversation routes.
    """
    identity = request.state.identity
    user_uuid = UUID(identity.user_id)
    pool = request.app.state.pool

    async with acquire(pool, identity) as conn:
        row = await conn.fetchrow(
            """
            SELECT id, title, created_at, updated_at
            FROM eidan.conversations
            WHERE id = $1
              AND user_id = $2
              AND deleted_at IS NULL
            """,
            conversation_id,
            user_uuid,
        )
    if row is None:
        raise HTTPException(status_code=404, detail="conversation not found")
    return {
        "id": str(row["id"]),
        "title": row["title"],
        "created_at": row["created_at"].isoformat(),
        "updated_at": row["updated_at"].isoformat(),
    }


class UpdateConversationBody(BaseModel):
    """PATCH /api/conversations/{id} request body.

    Mirrors ``ConversationUpdate.schema.json`` (the canonical wire
    shape codegens to ``packages/schemas/eidan_schemas/generated/
    core/memory/ConversationUpdate_schema.py``). The handler does its
    own trimming, so an all-whitespace title collapses to null and the
    row reverts to autogen-eligible state per issue #48.
    """

    title: str | None = Field(default=None, max_length=200)


def _normalise_title(raw: str | None) -> str | None:
    """Strip whitespace, collapse empty to ``None`` and clamp to 200
    chars. Keeps the PATCH handler and the regenerate-title write path
    in sync on the "what does the wire actually persist" question.
    """
    if raw is None:
        return None
    text = raw.strip()
    if not text:
        return None
    if len(text) > 200:
        text = text[:200].rstrip()
    return text or None


@router.patch("/api/conversations/{conversation_id}")
async def patch_conversation(
    request: Request,
    conversation_id: UUID,
    body: UpdateConversationBody,
) -> dict[str, Any]:
    """Set or clear a conversation's title (issue #48).

    Null or whitespace-only input clears the title and re-arms the
    auto-title gate so the next regenerate / next-turn-on-untitled
    flow can produce a fresh label.
    """
    identity = request.state.identity
    user_uuid = UUID(identity.user_id)
    pool = request.app.state.pool

    normalised = _normalise_title(body.title)

    async with acquire(pool, identity) as conn:
        owned = await conversation_belongs_to(
            conn, conversation_id=conversation_id, user_id=user_uuid
        )
        if not owned:
            raise HTTPException(status_code=404, detail="conversation not found")
        stored = await update_conversation_title(
            conn,
            conversation_id=conversation_id,
            user_id=user_uuid,
            title=normalised,
        )

    return {"id": str(conversation_id), "title": stored}


@router.post("/api/conversations/{conversation_id}/regenerate_title")
async def post_regenerate_conversation_title(
    request: Request, conversation_id: UUID
) -> dict[str, Any]:
    """Force-regenerate a conversation's title from its first turn pair.

    Runs the cheap haiku-class summary inline (issue #48 budgets one
    call per regenerate) and writes the result onto the row. Returns
    ``{"id", "title"}`` so the UI can replace its local copy without a
    follow-up GET.
    """
    identity = request.state.identity
    user_uuid = UUID(identity.user_id)
    pool = request.app.state.pool
    provider = request.app.state.provider

    async with acquire(pool, identity) as conn:
        owned = await conversation_belongs_to(
            conn, conversation_id=conversation_id, user_id=user_uuid
        )
        if not owned:
            raise HTTPException(status_code=404, detail="conversation not found")
        pair = await first_turn_pair(conn, conversation_id=conversation_id)

    if pair is None:
        # Nothing to summarise yet — clear any existing title so the
        # next first-agent-turn lands the auto-title path.
        async with acquire(pool, identity) as conn:
            stored = await update_conversation_title(
                conn,
                conversation_id=conversation_id,
                user_id=user_uuid,
                title=None,
            )
        return {"id": str(conversation_id), "title": stored}

    user_text, assistant_text = pair
    try:
        generated = await generate_conversation_title(
            provider=provider,
            user_text=user_text,
            assistant_text=assistant_text,
        )
    except Exception as exc:
        logger.exception(
            "auto_title.regenerate_failed",
            extra={"conversation_id": str(conversation_id)},
        )
        # Surface a typed 502 so the UI can render a retry rather than a
        # generic 500 swallowing the cause.
        raise HTTPException(
            status_code=502, detail="title generation failed"
        ) from exc

    async with acquire(pool, identity) as conn:
        stored = await update_conversation_title(
            conn,
            conversation_id=conversation_id,
            user_id=user_uuid,
            title=generated,
        )

    return {"id": str(conversation_id), "title": stored}


@router.get("/api/conversations/{conversation_id}/messages")
async def get_conversation_messages(
    request: Request, conversation_id: UUID
) -> dict[str, Any]:
    """Replay a conversation's messages.

    Returns rows in ``created_at`` order; the UI folds tool turns under
    the assistant turn that issued them (`docs/014 §4.2`).
    """
    identity = request.state.identity
    user_uuid = UUID(identity.user_id)
    pool = request.app.state.pool

    async with acquire(pool, identity) as conn:
        owned = await conversation_belongs_to(
            conn, conversation_id=conversation_id, user_id=user_uuid
        )
        if not owned:
            raise HTTPException(status_code=404, detail="conversation not found")
        rows = await load_full_conversation_messages(
            conn, conversation_id=conversation_id
        )

    return {
        "messages": [
            {
                "id": str(row["id"]),
                "role": row["role"],
                "content": row["content"],
                "tool_calls": _maybe_json(row["tool_calls"]),
                "tool_results": _maybe_json(row["tool_results"]),
                "parent_message_id": (
                    str(row["parent_message_id"])
                    if row["parent_message_id"] is not None
                    else None
                ),
                "provider": row["provider"],
                "model": row["model"],
                "metadata": _maybe_json(row["metadata"]),
                "created_at": row["created_at"].isoformat(),
            }
            for row in rows
        ]
    }


def _maybe_json(value: Any) -> Any:
    if isinstance(value, (str, bytes, bytearray)):
        try:
            return json.loads(value)
        except (TypeError, ValueError):
            return value
    return value


def _decode_plugins_jsonb(value: Any) -> list[dict[str, Any]]:
    """Decode the ``eidan.node_heartbeats.plugins`` JSONB array.

    ``persistence.decode_jsonb`` assumes the column holds an object
    and collapses anything else to ``{}``; this column is a JSON
    array, so we do the string/list dance inline and default to
    ``[]`` for any unexpected shape (legacy rows, NULLs, codec
    surprises).
    """
    if value is None:
        return []
    if isinstance(value, str):
        try:
            decoded = json.loads(value)
        except (TypeError, ValueError):
            return []
        return decoded if isinstance(decoded, list) else []
    if isinstance(value, list):
        return value
    return []


# -----------------------------------------------------------------------------
# /api/turn — SSE streaming
# -----------------------------------------------------------------------------


class TurnRequestBody(BaseModel):
    conversation_id: UUID
    text: str
    sent_at_utc: datetime
    user_tz: str = Field(min_length=1)


def _sse_event(name: str, data: dict[str, Any]) -> str:
    """Format an SSE frame. Trailing blank line terminates the frame."""
    return f"event: {name}\ndata: {json.dumps(data)}\n\n"


async def _auto_title_first_turn(
    *,
    pool: Any,
    provider: Any,
    identity: Any,
    conversation_id: UUID,
    user_id: UUID,
) -> None:
    """Background hook that runs after every ``/api/turn`` ``complete``.

    Fires the cheap haiku-class summary iff the conversation is still
    titleless and the just-landed turn is the first one (message count
    == 2 — one user + one assistant). The persistence-side write is
    additionally gated on ``title IS NULL`` so two near-simultaneous
    turns on the same conversation cannot both win.

    The task swallows its own exceptions: an auto-title that fails
    must never break the turn pipeline. Per ``docs/005 §5.1`` the
    runner is authoritative — this is a best-effort UI nicety, not a
    correctness path.
    """
    try:
        async with acquire(pool, identity) as conn:
            count = await count_conversation_messages(
                conn, conversation_id=conversation_id
            )
            if count != 2:
                return
            # Skip the LLM call when a title already exists (operator
            # set it on conversation create, or a prior auto-title
            # already won). The SQL guard inside
            # ``update_conversation_title(..., only_if_null=True)``
            # would prevent the overwrite anyway, but checking here
            # avoids paying for a provider call we'd discard.
            existing_title = await conn.fetchval(
                "SELECT title FROM eidan.conversations WHERE id = $1",
                conversation_id,
            )
            if existing_title is not None:
                return
            pair = await first_turn_pair(
                conn, conversation_id=conversation_id
            )
        if pair is None:
            return
        user_text, assistant_text = pair
        generated = await generate_conversation_title(
            provider=provider,
            user_text=user_text,
            assistant_text=assistant_text,
        )
        if generated is None:
            return
        async with acquire(pool, identity) as conn:
            await update_conversation_title(
                conn,
                conversation_id=conversation_id,
                user_id=user_id,
                title=generated,
                only_if_null=True,
            )
    except Exception:
        logger.exception(
            "auto_title.background_failed",
            extra={"conversation_id": str(conversation_id)},
        )


@router.post("/api/turn")
async def post_turn(
    request: Request, body: TurnRequestBody
) -> StreamingResponse:
    """Drive one turn and stream chunks back as ``text/event-stream``.

    Per ``docs/005 §5.1`` the runner is authoritative: it persists every
    row (user, assistant, tool, llm_calls) before the next step depends
    on it. This handler is a thin SSE adapter on top of ``run_turn`` —
    no extra writes here. Client disconnect raises ``CancelledError``
    inside ``_stream`` which propagates into ``run_turn`` and unwinds
    the provider call.
    """
    identity = request.state.identity
    user_uuid = UUID(identity.user_id)
    pool = request.app.state.pool
    provider = request.app.state.provider
    default_model = request.app.state.default_model
    tool_registry = request.app.state.tool_registry

    # Budget caps (`docs/010 §2`). The per-turn cap is threaded into
    # `run_turn` and enforced inside the iteration loop. The per-day
    # cap is a pre-flight gate so we refuse new turns *before* any
    # provider work starts.
    backend_settings = getattr(request.app.state, "backend_settings", None)
    # When ``backend_settings`` isn't pinned (tests using the lightweight
    # ``create_app`` factory), the caps stay off — those tests opt into
    # the cap behaviour explicitly via ``app.state.backend_settings``.
    max_turn_cost = (
        backend_settings.max_turn_cost_usd if backend_settings is not None else None
    )
    max_daily_cost = (
        backend_settings.max_daily_cost_usd if backend_settings is not None else None
    )

    async with acquire(pool, identity) as conn:
        owned = await conversation_belongs_to(
            conn, conversation_id=body.conversation_id, user_id=user_uuid
        )
        if not owned:
            raise HTTPException(status_code=404, detail="conversation not found")

        if max_daily_cost is not None and max_daily_cost > 0:
            since = datetime.now(tz=UTC) - timedelta(hours=24)
            day_summary = await cost_summary_since(
                conn, user_id=user_uuid, since=since
            )
            day_cost = float(day_summary.get("cost_usd") or 0.0)
            if day_cost >= max_daily_cost:
                # 402 Payment Required is the closest HTTP-spec'd code
                # for "you've spent your quota"; the typed envelope is
                # what the UI actually renders.
                raise HTTPException(
                    status_code=402,
                    detail={
                        "code": "budget.daily_exceeded",
                        "message": (
                            f"daily spend ${day_cost:.4f} has reached the "
                            f"configured ceiling of ${max_daily_cost:.4f}"
                        ),
                        "cap_usd": max_daily_cost,
                        "spent_usd": day_cost,
                    },
                )

    ctx = TurnContext(identity=identity, conversation_id=body.conversation_id)

    # Normalise the wire-supplied timestamp to UTC. Pydantic accepts an
    # ISO 8601 with any offset; the loop's TZ header generator wants the
    # UTC representation so two surfaces with different local offsets
    # render identical headers.
    sent_at_utc = body.sent_at_utc.astimezone(UTC)

    async def _stream() -> AsyncIterator[bytes]:
        try:
            async for event in run_turn(
                pool=pool,
                provider=provider,
                model=default_model,
                ctx=ctx,
                user_text=body.text,
                sent_at_utc=sent_at_utc,
                user_tz=body.user_tz,
                tool_registry=tool_registry,
                max_turn_cost_usd=max_turn_cost,
            ):
                if await request.is_disconnected():
                    break
                if isinstance(event, AssistantChunk):
                    yield _sse_event("chunk", {"text": event.text}).encode("utf-8")
                elif isinstance(event, TurnComplete):
                    yield _sse_event(
                        "complete",
                        {
                            "user_message_id": str(event.user_message_id),
                            "assistant_message_id": str(
                                event.assistant_message_id
                            ),
                        },
                    ).encode("utf-8")
                    # Fire-and-forget auto-title hook (issue #48). The
                    # call is gated on ``title IS NULL`` inside
                    # ``_auto_title_first_turn`` — a second turn on a
                    # conversation that already has a title is a no-op
                    # both at the SQL layer and (when no fresh provider
                    # call is needed) before it.
                    asyncio.create_task(
                        _auto_title_first_turn(
                            pool=pool,
                            provider=provider,
                            identity=identity,
                            conversation_id=body.conversation_id,
                            user_id=user_uuid,
                        )
                    )
        except asyncio.CancelledError:
            # Client disconnect — propagate so the provider call unwinds.
            raise

    return StreamingResponse(
        _stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )


# -----------------------------------------------------------------------------
# /api/cost/summary
# -----------------------------------------------------------------------------


_COST_SCOPES: frozenset[str] = frozenset({"turn", "session", "day"})


def _iat_to_datetime(raw_claims: dict[str, Any]) -> datetime | None:
    """Parse the JWT's ``iat`` claim into a tz-aware UTC datetime.

    The native access token carries ``iat`` as a unix epoch seconds
    integer per RFC 7519. A missing or malformed claim degrades to
    ``None`` and the caller falls back to the rolling-day window.
    """
    raw = raw_claims.get("iat")
    if raw is None:
        return None
    try:
        return datetime.fromtimestamp(int(raw), tz=UTC)
    except (TypeError, ValueError):
        return None


def _format_summary(summary: dict) -> dict[str, Any]:
    started = summary.get("started_at")
    return {
        "cost_usd": float(summary.get("cost_usd") or 0.0),
        "input_tokens": int(summary.get("input_tokens") or 0),
        "output_tokens": int(summary.get("output_tokens") or 0),
        "started_at": started.isoformat() if started is not None else None,
    }


@router.get("/api/cost/summary")
async def get_cost_summary(
    request: Request,
    scope: Annotated[
        str, Query(description="One of: turn, session, day.")
    ],
    message_id: Annotated[UUID | None, Query()] = None,
) -> dict[str, Any]:
    """Aggregate token spend for the authenticated user.

    Per ``docs/010 §6`` the UI surfaces three running totals derived from
    ``eidan.llm_calls``: per-turn (keyed on the latest user message id),
    per-session (since the JWT's ``iat``), and per-day (rolling 24h).
    Each scope returns ``{ cost_usd, input_tokens, output_tokens,
    started_at }``; ``started_at`` is the lower bound of the aggregation
    window (the turn's first call for ``turn``, the session's ``iat`` /
    24h-ago for ``session`` / ``day``).
    """
    if scope not in _COST_SCOPES:
        raise HTTPException(
            status_code=400, detail=f"unknown scope: {scope}"
        )

    identity = request.state.identity
    user_uuid = UUID(identity.user_id)
    pool = request.app.state.pool

    async with acquire(pool, identity) as conn:
        if scope == "turn":
            anchor = message_id or await latest_user_message_id(
                conn, user_id=user_uuid
            )
            if anchor is None:
                return {
                    "scope": scope,
                    "cost_usd": 0.0,
                    "input_tokens": 0,
                    "output_tokens": 0,
                    "started_at": None,
                    "message_id": None,
                }
            summary = await cost_summary_for_turn(
                conn, user_id=user_uuid, message_id=anchor
            )
            return {
                "scope": scope,
                "message_id": str(anchor),
                **_format_summary(summary),
            }

        if scope == "session":
            iat = _iat_to_datetime(identity.raw_claims) or (
                datetime.now(tz=UTC) - timedelta(hours=24)
            )
            summary = await cost_summary_since(
                conn, user_id=user_uuid, since=iat
            )
            return {"scope": scope, **_format_summary(summary)}

        # scope == "day"
        since = datetime.now(tz=UTC) - timedelta(hours=24)
        summary = await cost_summary_since(
            conn, user_id=user_uuid, since=since
        )
        return {"scope": scope, **_format_summary(summary)}


# ---------------------------------------------------------------------------
# Node telemetry — heartbeats + per-node event tail.
#
# Mirrors potem's `/api/nodes` and `/api/nodes/<id>/events` shape so a
# future UI can render them with the same component. Tables are
# host-global (no user_id), so we don't go through `acquire(pool,
# identity)` — that helper opens an RLS-scoped transaction we don't
# need. The HTTP route itself is gated on a valid session via the
# auth middleware (every /api/* route is, except /api/auth/*).
# ---------------------------------------------------------------------------


@router.get("/api/admin/nodes")
async def list_nodes_endpoint(request: Request) -> dict[str, Any]:
    """List every node that's ever heartbeated, newest activity first.

    Returns ``last_seen`` + ``seconds_since`` so the UI can render a
    coloured chip ("online" if seconds_since < ~90, "stale" otherwise)
    without doing its own clock arithmetic. ``metadata`` is the
    platform-specific blob the emitter computed at boot (region, app,
    pod namespace, …).
    """
    # Identity check fires via middleware; here we just need the pool.
    pool = request.app.state.pool
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT node_id,
                   node_type,
                   status,
                   last_seen,
                   EXTRACT(EPOCH FROM (now() - last_seen))::int
                                              AS seconds_since,
                   metadata,
                   plugins,
                   created_at,
                   updated_at
              FROM eidan.node_heartbeats
             ORDER BY last_seen DESC
            """
        )
    return {
        "nodes": [
            {
                "node_id": r["node_id"],
                "node_type": r["node_type"],
                "status": r["status"],
                "last_seen": r["last_seen"].isoformat(),
                "seconds_since": r["seconds_since"],
                "metadata": decode_jsonb(r["metadata"]),
                # Plugins active on this node, written on every
                # heartbeat UPSERT (issue #52). decode_jsonb()
                # collapses non-dict JSONB to ``{}``; this column
                # is a JSON array, so decode the raw value directly
                # and fall through to ``[]`` for legacy rows.
                "plugins": _decode_plugins_jsonb(r["plugins"]),
                "created_at": r["created_at"].isoformat(),
                "updated_at": r["updated_at"].isoformat(),
            }
            for r in rows
        ]
    }


@router.get("/api/admin/nodes/{node_id}/events")
async def list_node_events_endpoint(
    request: Request,
    node_id: str,
    after_seq: Annotated[
        int,
        Query(
            ge=0,
            description=(
                "Return only events with seq > after_seq. Drives "
                "incremental polling — UI passes the last seq it has "
                "and gets the delta back."
            ),
        ),
    ] = 0,
    conversation_id: Annotated[
        UUID | None,
        Query(
            description=(
                "Filter to one conversation's slice of the timeline "
                "(e.g. an expanded /conversations row). Without it, "
                "returns the most recent 200 events node-wide."
            )
        ),
    ] = None,
    limit: Annotated[int, Query(ge=1, le=500)] = 200,
) -> dict[str, Any]:
    """Tail one node's recent activity.

    Two query shapes:
      - ``after_seq=N`` (without conversation_id) — latest ``limit``
        rows since seq N, ordered DESC so the newest entries are at
        the top of the response. Mirrors the chat-message tail.
      - ``after_seq=N&conversation_id=<uuid>`` — slice of the timeline
        bound to one turn, ordered ASC so the UI renders chronologically.

    Empty list when the node has no events yet (or no events past
    after_seq) — not a 404. 404 *is* returned when the node_id has
    never heartbeated, which is a stronger signal of "wrong id".
    """
    pool = request.app.state.pool
    async with pool.acquire() as conn:
        node_exists = await conn.fetchval(
            "SELECT 1 FROM eidan.node_heartbeats WHERE node_id = $1",
            node_id,
        )
        if node_exists is None:
            raise HTTPException(status_code=404, detail="unknown node_id")

        if conversation_id is not None:
            rows = await conn.fetch(
                """
                SELECT node_id, seq, ts, type, payload, conversation_id
                  FROM eidan.node_events
                 WHERE node_id = $1
                   AND conversation_id = $2
                   AND seq > $3
                 ORDER BY seq ASC
                 LIMIT $4
                """,
                node_id,
                conversation_id,
                after_seq,
                limit,
            )
        else:
            rows = await conn.fetch(
                """
                SELECT node_id, seq, ts, type, payload, conversation_id
                  FROM eidan.node_events
                 WHERE node_id = $1
                   AND seq > $2
                 ORDER BY seq DESC
                 LIMIT $3
                """,
                node_id,
                after_seq,
                limit,
            )

    return {
        "node_id": node_id,
        "events": [
            {
                "id": f"{r['node_id']}:{r['seq']}",
                "seq": r["seq"],
                "ts": r["ts"].isoformat(),
                "type": r["type"],
                "payload": decode_jsonb(r["payload"]),
                "conversation_id": (
                    str(r["conversation_id"])
                    if r["conversation_id"] is not None
                    else None
                ),
            }
            for r in rows
        ],
    }


# ---------------------------------------------------------------------------
# Behaviour triggers — read-only snapshot of the in-process dispatcher.
#
# Pinned shape in packages/schemas/schemas/core/admin/TriggerList.schema.json
# (docs/006 §4). Consumed by the /admin/activity triggers tab in apps/web.
# Same auth posture as the node telemetry routes above: middleware checks
# the Bearer, no RLS — the registry is host-global and the DLQ has no
# user_id column.
# ---------------------------------------------------------------------------


@router.get("/api/admin/triggers")
async def list_triggers_endpoint(request: Request) -> dict[str, Any]:
    """List every behaviour currently registered with the dispatcher.

    The registry is in-process so a request hitting one backend instance
    sees that instance's behaviours, not the cluster's. For
    Phase 1 single-operator deployments that's the whole catalogue.
    Multi-instance fleet aggregation is a follow-up.

    Returns an empty list (and ``dlq_count: 0``) when the registry isn't
    populated yet — happens in tests that build a bare app without
    running ``bootstrap``, and during the brief boot window before
    plugins activate.
    """
    registry = getattr(request.app.state, "behaviour_registry", None)
    dispatcher = getattr(request.app.state, "behaviour_dispatcher", None)
    pool = request.app.state.pool

    triggers: list[dict[str, Any]] = []
    if registry is not None:
        scheduler = dispatcher.scheduler if dispatcher is not None else None
        for beh in registry.all():
            plugin, _, _ = beh.id.partition(":")
            next_run_ts: str | None = None
            if scheduler is not None and beh.trigger.kind in ("cron", "schedule"):
                job = scheduler.get_job(f"behaviour:{beh.id}")
                # APScheduler exposes next_run_time on a scheduled job; it's
                # None when the scheduler is stopped or the job was paused.
                if job is not None and job.next_run_time is not None:
                    next_run_ts = job.next_run_time.isoformat()
            triggers.append(
                {
                    "behaviour_id": beh.id,
                    "plugin": plugin,
                    "kind": beh.trigger.kind,
                    "spec": beh.trigger.spec,
                    "next_run_ts": next_run_ts,
                }
            )

    async with pool.acquire() as conn:
        dlq_count = await conn.fetchval(
            "SELECT count(*) FROM eidan.behaviour_dlq WHERE status = 'pending'"
        )

    return {"triggers": triggers, "dlq_count": int(dlq_count or 0)}
