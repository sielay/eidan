"""HTTP surface tests.

End-to-end against an ephemeral Postgres + a scripted provider + the
real RS256 verifier. Tests mint actual access JWTs against a test
keypair (`conftest._get_test_keypair`) so the auth middleware
exercises its production verify path; failure cases pass either a
malformed string or a token signed with a different key.

Coverage:

- :data:`UNAUTHENTICATED_PATHS` skips auth (``/api/auth/config``).
- A missing ``Authorization`` header returns 401 with
  ``auth.missing_token`` per ``docs/011 §10.2``.
- A bad token returns 401 with ``auth.invalid_signature``.
- ``POST /api/turn`` streams SSE ``chunk`` / ``complete`` frames and
  persists the same rows the in-process loop writes.
- ``GET /api/conversations`` and ``/api/conversations/{id}/messages``
  read back what the turn just wrote.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from uuid import UUID

import pytest
from eidan_backend.db import create_pool
from eidan_backend.http.app import create_app
from eidan_backend.identity import Identity

from .conftest import (
    ScriptedTurn,
    _get_test_keypair,
    build_identity,
    mint_test_token,
)


async def _build_app(pool, provider):
    private_pem, public_pem = _get_test_keypair()
    return create_app(
        pool=pool,
        provider=provider,
        default_model="claude-sonnet-4-6",
        auth_private_pem=private_pem,
        auth_public_pem=public_pem,
    )


def _auth_header(identity: Identity | None = None) -> dict[str, str]:
    """Convenience: produce a Bearer header carrying a real signed token."""
    identity = identity or build_identity()
    return {"Authorization": f"Bearer {mint_test_token(identity)}"}


@pytest.fixture
async def http_client(eidan_db: str, stub_provider) -> AsyncIterator:
    """ASGI test client + the dependencies the test wired into it.

    Yields a tuple ``(client, pool, provider, mint)`` where ``mint`` is
    a callable that returns a fresh ``Authorization: Bearer`` header
    for the given identity (defaults to :func:`build_identity`). Tests
    that need to assert against a specific identity capture ``mint``
    from this tuple.
    """
    import httpx

    pool = await create_pool(eidan_db)

    # ``eidan_db`` is session-scoped (migrations + Postgres are expensive),
    # so rows persisted by earlier http tests survive into later ones.
    # Truncate the per-user data each time the fixture is built so a test
    # like ``test_cost_summary_zero_state`` can rely on a clean slate.
    async with pool.acquire() as conn:
        await conn.execute(
            "TRUNCATE eidan.llm_calls, eidan.messages, eidan.conversations "
            "RESTART IDENTITY CASCADE"
        )

    # Default script: scope -> sizer -> intent -> primary (text-only).
    provider = stub_provider(
        [
            ScriptedTurn(text='["chitchat"]'),
            ScriptedTurn(text="claude-sonnet-4-6"),
            # Intent classifier — empty actions list for chitchat turns.
            ScriptedTurn(text='{"actions": []}'),
            ScriptedTurn(text="hi from the http surface"),
        ]
    )
    app = await _build_app(pool, provider)
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(
        transport=transport, base_url="http://testserver"
    ) as client:
        yield client, pool, provider, _auth_header
    await pool.close()


@pytest.mark.asyncio
async def test_healthz_is_public(http_client) -> None:
    """``/api/healthz`` is unauthenticated and returns a 200 envelope
    that the self-hosted systemd watchdog in ``infra/systemd/`` probes
    with ``curl -fsS`` — non-2xx must unambiguously be a failure."""
    client, _, _, _ = http_client
    resp = await client.get("/api/healthz")
    assert resp.status_code == 200
    assert resp.json() == {"status": "ok"}


@pytest.mark.asyncio
async def test_auth_config_is_public(http_client) -> None:
    """``/api/auth/config`` is public and surfaces the native auth
    envelope. The ``provider`` is always ``native``; the providers
    list carries every auth surface enabled (today: magic_link).

    Critically, the response MUST NOT include ``allowed_email`` or
    any other PII — the endpoint is unauthenticated and any value
    here is broadcast to every caller. The verify endpoint
    re-checks ``EIDAN_AUTH_ALLOWED_EMAIL`` server-side."""
    client, _, _, _ = http_client
    resp = await client.get("/api/auth/config")
    assert resp.status_code == 200
    body = resp.json()
    assert body["provider"] == "native"
    assert body["providers"] == ["magic_link"]
    assert "tos_url" in body
    assert "privacy_url" in body
    # Regression guard: no PII on a public endpoint.
    assert "allowed_email" not in body
    assert "email" not in body


@pytest.mark.asyncio
async def test_missing_token_returns_typed_401(http_client) -> None:
    client, _, _, _ = http_client
    resp = await client.get("/api/conversations")
    assert resp.status_code == 401
    body = resp.json()
    assert body["error"]["code"] == "auth.missing_token"
    # WWW-Authenticate header required on 401 per docs/011 §10.1.
    assert "Bearer" in resp.headers.get("www-authenticate", "")


@pytest.mark.asyncio
async def test_invalid_token_returns_typed_401(http_client) -> None:
    """A garbage string in the Authorization header is rejected by the
    RS256 verifier with ``auth.invalid_signature``."""
    client, _, _, _ = http_client
    resp = await client.get(
        "/api/conversations",
        headers={"Authorization": "Bearer not-a-real-token"},
    )
    assert resp.status_code == 401
    body = resp.json()
    assert body["error"]["code"] == "auth.invalid_signature"


@pytest.mark.asyncio
async def test_token_signed_by_other_key_returns_typed_401(http_client) -> None:
    """A well-formed JWT signed by a *different* RS256 key fails the
    signature check. Same shape as the malformed-token case — the
    native middleware does not distinguish "wrong key" from "garbage
    bytes"."""
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric import rsa
    from eidan_backend.auth_native import issue_access_token

    foreign_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    foreign_pem = foreign_key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.TraditionalOpenSSL,
        encryption_algorithm=serialization.NoEncryption(),
    )
    forged = issue_access_token(
        private_pem=foreign_pem,
        user_id="00000000-0000-0000-0000-000000000001",
        email="test@example.com",
    )
    client, _, _, _ = http_client
    resp = await client.get(
        "/api/conversations",
        headers={"Authorization": f"Bearer {forged}"},
    )
    assert resp.status_code == 401
    assert resp.json()["error"]["code"] == "auth.invalid_signature"


@pytest.mark.asyncio
async def test_token_expired_returns_typed_401(http_client) -> None:
    """An access token whose ``exp`` is in the past is rejected — the
    middleware maps the jose ``ExpiredSignatureError`` onto the same
    ``auth.invalid_signature`` envelope today; refreshing the token
    fixes it on the next request."""
    from datetime import UTC, datetime, timedelta

    client, _, _, _ = http_client
    expired_iat = datetime.now(UTC) - timedelta(days=2)
    token = mint_test_token(build_identity(), now=expired_iat)
    resp = await client.get(
        "/api/conversations",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 401
    assert resp.json()["error"]["code"] == "auth.invalid_signature"


@pytest.mark.asyncio
async def test_malformed_token_returns_typed_401(http_client) -> None:
    """A "Bearer <gibberish>" header that isn't a valid JWT structure
    is rejected with the same envelope as an invalid signature."""
    client, _, _, _ = http_client
    resp = await client.get(
        "/api/conversations",
        headers={"Authorization": "Bearer not.a.jwt"},
    )
    assert resp.status_code == 401
    assert resp.json()["error"]["code"] == "auth.invalid_signature"


@pytest.mark.asyncio
async def test_error_envelope_carries_request_id(http_client) -> None:
    """Every error envelope echoes the per-request trace id and the
    middleware sets it on a response header. The shape is pinned in
    `docs/011 §10.1`."""
    client, _, _, _ = http_client
    resp = await client.get("/api/conversations")
    assert resp.status_code == 401
    body = resp.json()
    assert "request_id" in body["error"]
    assert resp.headers.get("x-request-id") == body["error"]["request_id"]


@pytest.mark.asyncio
async def test_inbound_request_id_is_honoured(http_client) -> None:
    """When the upstream proxy supplies X-Request-Id the middleware
    propagates it instead of minting a fresh one — keeps log
    correlation working across hops."""
    client, _, _, _ = http_client
    incoming = "01HQTRACEID0123456789ABCDEF"
    resp = await client.get(
        "/api/conversations",
        headers={"X-Request-Id": incoming},
    )
    assert resp.headers.get("x-request-id") == incoming
    assert resp.json()["error"]["request_id"] == incoming


@pytest.mark.asyncio
async def test_unauthenticated_path_still_carries_request_id(
    http_client,
) -> None:
    """Public paths (auth/config, healthz, …) also get the X-Request-Id
    header so a UI screen flagging "couldn't load config" can hand the
    operator a grep-able trace id."""
    client, _, _, _ = http_client
    resp = await client.get("/api/auth/config")
    assert resp.status_code == 200
    rid = resp.headers.get("x-request-id")
    assert rid is not None and len(rid) > 0


@pytest.mark.asyncio
async def test_get_agent_creates_row_and_returns_null_persona(http_client) -> None:
    """First fetch idempotently creates the user's default agent_context
    row. ``persona`` is null until the operator writes user_overrides."""
    client, _, _, mint = http_client
    identity = build_identity()
    headers = mint(identity)

    resp = await client.get(
        "/api/agent",
        headers=headers,
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()["agent"]
    assert body["agent_slug"] == "default"
    assert body["display_name"] == "Eidan"
    assert body["enabled"] is True
    assert body["persona"] is None
    # The row's jsonb columns serialise to plain dicts on the wire.
    assert body["code_defaults"] == {}
    assert body["user_overrides"] == {}


@pytest.mark.asyncio
async def test_put_agent_sets_then_clears_persona(http_client) -> None:
    """PUT writes user_overrides.system_prompt; PUT with null clears it.
    Both responses carry the canonical post-write row + effective
    persona so the UI doesn't need a follow-up GET."""
    client, _, _, mint = http_client
    identity = build_identity()
    headers = mint(identity)

    # Set.
    resp = await client.put(
        "/api/agent",
        headers=headers,
        json={"persona": "You are concise and direct."},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()["agent"]
    assert body["persona"] == "You are concise and direct."
    assert body["user_overrides"]["system_prompt"] == "You are concise and direct."

    # Clear via null.
    resp = await client.put(
        "/api/agent",
        headers=headers,
        json={"persona": None},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()["agent"]
    assert body["persona"] is None
    assert "system_prompt" not in body["user_overrides"]


@pytest.mark.asyncio
async def test_put_agent_treats_whitespace_only_as_clear(http_client) -> None:
    """Empty / whitespace-only persona collapses to ``null`` so a user
    can't accidentally write a useless prompt that suppresses nothing."""
    client, _, _, mint = http_client
    identity = build_identity()
    headers = mint(identity)

    # Seed a real persona first so the clear branch has something to undo.
    await client.put(
        "/api/agent",
        headers=headers,
        json={"persona": "I will be replaced."},
    )
    resp = await client.put(
        "/api/agent",
        headers=headers,
        json={"persona": "   \n  "},
    )
    assert resp.status_code == 200
    body = resp.json()["agent"]
    assert body["persona"] is None


@pytest.mark.asyncio
async def test_agent_endpoints_require_auth(http_client) -> None:
    client, _, _, _ = http_client
    for method in ("get", "put"):
        kwargs: dict[str, object] = {}
        if method == "put":
            kwargs["json"] = {"persona": "x"}
        resp = await getattr(client, method)("/api/agent", **kwargs)
        assert resp.status_code == 401, (method, resp.text)
        assert resp.json()["error"]["code"] == "auth.missing_token"


@pytest.mark.asyncio
async def test_get_plugins_returns_empty_list_when_none_loaded(http_client) -> None:
    """Default ``http_client`` fixture builds the app with no plugins, so
    the route returns an empty list — but still requires auth."""
    client, _, _, mint = http_client
    identity = build_identity()
    headers = mint(identity)

    resp = await client.get(
        "/api/plugins",
        headers=headers,
    )
    assert resp.status_code == 200, resp.text
    assert resp.json() == {"node": None, "plugins": []}


@pytest.mark.asyncio
async def test_get_plugins_renders_loaded_manifest_fields(
    eidan_db: str, stub_provider
) -> None:
    """An app constructed with a loaded plugin renders its manifest in the
    list. Builds a synthetic :class:`LoadedPlugin` directly so the test
    does not depend on the on-disk ``plugins/`` tree."""
    import httpx
    from eidan_backend.plugins import LoadedPlugin
    from eidan_backend.plugins.base import PluginBase
    from eidan_schemas.generated.core.plugin.PluginManifest_schema import (
        PluginManifest,
    )

    pool = await create_pool(eidan_db)
    try:
        manifest = PluginManifest.model_validate(
            {
                "schema": 1,
                "name": "demo-plugin",
                "version": "1.2.3",
                "display_name": "Demo Plugin",
                "description": "Used by tests only.",
                "tier": "core",
                "license": "AGPL-3.0",
            }
        )

        class _NoopPlugin(PluginBase):
            pass

        loaded = LoadedPlugin(
            manifest=manifest,
            plugin=_NoopPlugin(),
            plugin_dir=__import__("pathlib").Path("/tmp/not-real"),
        )

        private_pem, public_pem = _get_test_keypair()
        provider = stub_provider([])  # no turns in this test
        app = create_app(
            pool=pool,
            provider=provider,
            default_model="claude-sonnet-4-6",
            plugins=[loaded],
            auth_private_pem=private_pem,
            auth_public_pem=public_pem,
        )

        identity = build_identity()
        headers = _auth_header(identity)

        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(
            transport=transport, base_url="http://testserver"
        ) as client:
            resp = await client.get(
                "/api/plugins",
                headers=headers,
            )
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body == {
            "node": None,
            "plugins": [
                {
                    "name": "demo-plugin",
                    "display_name": "Demo Plugin",
                    "tier": "core",
                    "version": "1.2.3",
                    "description": "Used by tests only.",
                    "enabled": True,
                }
            ],
        }
    finally:
        await pool.close()


@pytest.mark.asyncio
async def test_get_plugins_requires_auth(http_client) -> None:
    """Plugins list is authenticated like every non-config route."""
    client, _, _, _ = http_client
    resp = await client.get("/api/plugins")
    assert resp.status_code == 401
    assert resp.json()["error"]["code"] == "auth.missing_token"


@pytest.mark.asyncio
async def test_get_plugin_returns_404_for_unknown(http_client) -> None:
    client, _, _, mint = http_client
    identity = build_identity()
    headers = mint(identity)
    resp = await client.get("/api/plugins/does-not-exist", headers=headers)
    assert resp.status_code == 404, resp.text


@pytest.mark.asyncio
async def test_get_plugin_returns_manifest_and_readme(
    eidan_db: str, stub_provider, tmp_path
) -> None:
    """The per-plugin endpoint returns manifest detail and the
    README body when one ships next to the plugin manifest. Built
    around a synthetic :class:`LoadedPlugin` whose ``plugin_dir``
    is a real path so the README read-back exercises the on-disk
    branch."""
    import httpx
    from eidan_backend.plugins import LoadedPlugin
    from eidan_backend.plugins.base import PluginBase
    from eidan_schemas.generated.core.plugin.PluginManifest_schema import (
        PluginManifest,
    )

    plugin_dir = tmp_path / "demo-plugin"
    plugin_dir.mkdir()
    (plugin_dir / "README.md").write_text("# Demo\n\nHello.", encoding="utf-8")

    pool = await create_pool(eidan_db)
    try:
        manifest = PluginManifest.model_validate(
            {
                "schema": 1,
                "name": "demo-plugin",
                "version": "1.2.3",
                "display_name": "Demo Plugin",
                "description": "Used by tests only.",
                "tier": "core",
                "license": "AGPL-3.0",
            }
        )

        class _NoopPlugin(PluginBase):
            pass

        loaded = LoadedPlugin(
            manifest=manifest,
            plugin=_NoopPlugin(),
            plugin_dir=plugin_dir,
        )

        private_pem, public_pem = _get_test_keypair()
        provider = stub_provider([])
        app = create_app(
            pool=pool,
            provider=provider,
            default_model="claude-sonnet-4-6",
            plugins=[loaded],
            auth_private_pem=private_pem,
            auth_public_pem=public_pem,
        )

        identity = build_identity()
        headers = _auth_header(identity)

        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(
            transport=transport, base_url="http://testserver"
        ) as client:
            resp = await client.get(
                "/api/plugins/demo-plugin", headers=headers
            )
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["name"] == "demo-plugin"
        assert body["display_name"] == "Demo Plugin"
        assert body["tier"] == "core"
        assert body["version"] == "1.2.3"
        assert body["description"] == "Used by tests only."
        assert body["license"] == "AGPL-3.0"
        assert body["readme"] == "# Demo\n\nHello."
    finally:
        await pool.close()


@pytest.mark.asyncio
async def test_get_plugin_requires_auth(http_client) -> None:
    client, _, _, _ = http_client
    resp = await client.get("/api/plugins/anything")
    assert resp.status_code == 401
    assert resp.json()["error"]["code"] == "auth.missing_token"


@pytest.mark.asyncio
async def test_post_turn_streams_sse_and_persists(http_client) -> None:
    client, pool, _, mint = http_client
    identity = build_identity()
    headers = mint(identity)
    user_uuid = UUID(identity.user_id)

    # Create a conversation via the HTTP API itself.
    resp = await client.post(
        "/api/conversations",
        headers=headers,
        json={"title": "smoke"},
    )
    assert resp.status_code == 200, resp.text
    conversation_id = resp.json()["id"]

    # Drive a turn and consume the SSE frames.
    chunks: list[str] = []
    complete: dict | None = None
    async with client.stream(
        "POST",
        "/api/turn",
        headers=headers,
        json={
            "conversation_id": conversation_id,
            "text": "hello over http",
            # sent_at_utc + user_tz are required by TurnInput (issue #51 piece A);
            # the loop renders them into the per-turn TZ header.
            "sent_at_utc": "2026-05-14T22:13:00Z",
            "user_tz": "Europe/London",
        },
    ) as stream:
        assert stream.status_code == 200
        assert stream.headers["content-type"].startswith("text/event-stream")
        buffer = ""
        async for piece in stream.aiter_text():
            buffer += piece
            while "\n\n" in buffer:
                raw, buffer = buffer.split("\n\n", 1)
                event = "message"
                data = ""
                for line in raw.split("\n"):
                    if line.startswith("event:"):
                        event = line[len("event:") :].strip()
                    elif line.startswith("data:"):
                        data = line[len("data:") :].lstrip()
                if event == "chunk":
                    import json
                    chunks.append(json.loads(data)["text"])
                elif event == "complete":
                    import json
                    complete = json.loads(data)

    assert complete is not None
    assert "user_message_id" in complete
    assert "assistant_message_id" in complete
    assert "hi from the http surface" in "".join(chunks)

    # Persistence shape — one user row + one assistant row, both keyed
    # to this user / conversation.
    async with pool.acquire() as conn:
        msgs = await conn.fetch(
            "SELECT role, content FROM eidan.messages "
            "WHERE conversation_id = $1 ORDER BY created_at ASC",
            UUID(conversation_id),
        )
        assert [m["role"] for m in msgs] == ["user", "assistant"]
        assert msgs[0]["content"] == "hello over http"
        assert "hi from the http surface" in msgs[1]["content"]

        # And the three llm_calls (scope -> sizer -> primary) all attach
        # to the user message id.
        roles = await conn.fetch(
            "SELECT role FROM eidan.llm_calls "
            "WHERE conversation_id = $1 ORDER BY started_at ASC",
            UUID(conversation_id),
        )
        assert [r["role"] for r in roles] == [
            "scope_classifier",
            "sizer",
            "intent_classifier",
            "primary",
        ]

    # GET /api/conversations sees the new row.
    resp = await client.get(
        "/api/conversations",
        headers=headers,
    )
    assert resp.status_code == 200
    convos = resp.json()["conversations"]
    assert any(c["id"] == conversation_id for c in convos)

    # GET /api/conversations/{id}/messages returns the rows.
    resp = await client.get(
        f"/api/conversations/{conversation_id}/messages",
        headers=headers,
    )
    assert resp.status_code == 200
    body = resp.json()
    assert len(body["messages"]) == 2
    assert body["messages"][0]["role"] == "user"
    assert body["messages"][1]["role"] == "assistant"
    assert body["messages"][1]["parent_message_id"] == body["messages"][0]["id"]
    # Bonus: user_uuid pinning didn't drift between persistence and HTTP.
    async with pool.acquire() as conn:
        owner = await conn.fetchval(
            "SELECT user_id FROM eidan.conversations WHERE id = $1",
            UUID(conversation_id),
        )
        assert owner == user_uuid


@pytest.mark.asyncio
async def test_turn_stamps_agent_id_on_messages_and_llm_calls(http_client) -> None:
    """After a turn lands, the loop-provisioned agent_context.id appears
    on every message row and every llm_call row for the turn — proving
    the contextvar + persistence wiring threads end-to-end."""
    client, pool, _, mint = http_client
    identity = build_identity()
    headers = mint(identity)
    user_uuid = UUID(identity.user_id)

    resp = await client.post(
        "/api/conversations",
        headers=headers,
        json={"title": "agent_id-smoke"},
    )
    conversation_id = resp.json()["id"]

    async with client.stream(
        "POST",
        "/api/turn",
        headers=headers,
        json={
            "conversation_id": conversation_id,
            "text": "ping",
            "sent_at_utc": "2026-05-14T22:13:00Z",
            "user_tz": "Europe/London",
        },
    ) as stream:
        async for _ in stream.aiter_text():
            pass

    async with pool.acquire() as conn:
        agent_id = await conn.fetchval(
            "SELECT id FROM eidan.agent_context "
            "WHERE user_id = $1 AND agent_slug = 'default'",
            user_uuid,
        )
        assert agent_id is not None, (
            "loop must have provisioned the default agent_context row"
        )

        msg_agent_ids = [
            row["agent_id"]
            for row in await conn.fetch(
                "SELECT agent_id FROM eidan.messages WHERE conversation_id = $1",
                UUID(conversation_id),
            )
        ]
        assert msg_agent_ids, "expected ≥1 messages for the turn"
        assert all(aid == agent_id for aid in msg_agent_ids), (
            f"every message row should carry the loop's agent_id; got {msg_agent_ids}"
        )

        llm_agent_ids = [
            row["agent_id"]
            for row in await conn.fetch(
                "SELECT agent_id FROM eidan.llm_calls WHERE conversation_id = $1",
                UUID(conversation_id),
            )
        ]
        assert llm_agent_ids, "expected ≥1 llm_calls for the turn"
        assert all(aid == agent_id for aid in llm_agent_ids), (
            f"every llm_call row should carry the loop's agent_id; got {llm_agent_ids}"
        )


@pytest.mark.asyncio
async def test_cost_summary_unknown_scope_400(http_client) -> None:
    client, _, _, mint = http_client
    identity = build_identity()
    headers = mint(identity)

    resp = await client.get(
        "/api/cost/summary?scope=lifetime",
        headers=headers,
    )
    assert resp.status_code == 400


@pytest.mark.asyncio
async def test_cost_summary_zero_state(http_client) -> None:
    """Before any llm_calls land, every scope returns a zero envelope."""
    client, _, _, mint = http_client
    identity = build_identity()
    headers = mint(identity)

    for scope in ("turn", "session", "day"):
        resp = await client.get(
            f"/api/cost/summary?scope={scope}",
            headers=headers,
        )
        assert resp.status_code == 200, (scope, resp.text)
        body = resp.json()
        assert body["scope"] == scope
        assert body["cost_usd"] == 0.0
        assert body["input_tokens"] == 0
        assert body["output_tokens"] == 0


@pytest.mark.asyncio
async def test_cost_summary_after_turn_matches_direct_sum(http_client) -> None:
    """Drive a turn, then assert the day aggregate matches a direct SUM."""
    from decimal import Decimal

    client, pool, _, _ = http_client
    identity = build_identity()
    # Mint the access token with ``iat`` 60s in the past so the
    # session-scope cost summary reads it back and windows from there.
    from datetime import UTC, datetime, timedelta

    iat_time = datetime.now(UTC) - timedelta(seconds=60)
    token = mint_test_token(identity, now=iat_time)
    headers = {"Authorization": f"Bearer {token}"}
    user_uuid = UUID(identity.user_id)

    # Create + drive a turn so llm_calls rows commit.
    resp = await client.post(
        "/api/conversations",
        headers=headers,
        json={"title": "cost"},
    )
    assert resp.status_code == 200, resp.text
    conversation_id = resp.json()["id"]

    user_message_id: str | None = None
    async with client.stream(
        "POST",
        "/api/turn",
        headers=headers,
        json={
            "conversation_id": conversation_id,
            "text": "hi",
            "sent_at_utc": "2026-05-14T22:13:00Z",
            "user_tz": "Europe/London",
        },
    ) as stream:
        assert stream.status_code == 200
        buffer = ""
        async for piece in stream.aiter_text():
            buffer += piece
            while "\n\n" in buffer:
                raw, buffer = buffer.split("\n\n", 1)
                event = "message"
                data = ""
                for line in raw.split("\n"):
                    if line.startswith("event:"):
                        event = line[len("event:") :].strip()
                    elif line.startswith("data:"):
                        data = line[len("data:") :].lstrip()
                if event == "complete":
                    import json
                    user_message_id = json.loads(data)["user_message_id"]

    assert user_message_id is not None

    # Stamp a non-zero ``cost_usd`` so the aggregate has something to
    # sum — the scripted provider reports zero pricing.
    async with pool.acquire() as conn:
        await conn.execute(
            "UPDATE eidan.llm_calls SET cost_usd = $1 WHERE message_id = $2",
            Decimal("0.012345"),
            UUID(user_message_id),
        )
        direct_sum = await conn.fetchval(
            "SELECT SUM(cost_usd) FROM eidan.llm_calls WHERE user_id = $1 "
            "AND started_at > now() - interval '24 hours'",
            user_uuid,
        )
    expected = float(direct_sum or 0)

    # Per-day must match a direct SUM against eidan.llm_calls.
    resp = await client.get(
        "/api/cost/summary?scope=day",
        headers=headers,
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["scope"] == "day"
    assert body["cost_usd"] == pytest.approx(expected, rel=1e-6)

    # Per-turn keyed on the user-message id we just got from the stream.
    resp = await client.get(
        f"/api/cost/summary?scope=turn&message_id={user_message_id}",
        headers=headers,
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["scope"] == "turn"
    assert body["message_id"] == user_message_id
    assert body["cost_usd"] == pytest.approx(expected, rel=1e-6)

    # Per-session — the JWT ``iat`` is 60s ago, so the same rows are in
    # window and the value matches.
    resp = await client.get(
        "/api/cost/summary?scope=session",
        headers=headers,
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["scope"] == "session"
    assert body["cost_usd"] == pytest.approx(expected, rel=1e-6)


@pytest.mark.asyncio
async def test_get_messages_404_for_other_users_conversation(http_client) -> None:
    client, pool, _, mint = http_client
    identity = build_identity()
    headers = mint(identity)

    # Insert a conversation belonging to a different user.
    other_user = UUID("00000000-0000-0000-0000-00000000beef")
    async with pool.acquire() as conn:
        await conn.execute(
            "INSERT INTO eidan.users (id, email) VALUES ($1, NULL) "
            "ON CONFLICT (id) DO NOTHING",
            other_user,
        )
        other_convo = await conn.fetchval(
            "INSERT INTO eidan.conversations (user_id, title) "
            "VALUES ($1, 'not yours') RETURNING id",
            other_user,
        )

    resp = await client.get(
        f"/api/conversations/{other_convo}/messages",
        headers=headers,
    )
    assert resp.status_code == 404
