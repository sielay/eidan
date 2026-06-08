# SPDX-License-Identifier: AGPL-3.0-or-later
"""HTTP surface tests for the artifact primitive (#252).

End-to-end against the ephemeral Postgres fixture: create an artifact via
:class:`ArtifactService` (Postgres-bytea backend), then download it through
``GET /api/artifacts/{id}`` — asserting the bytes round-trip, the response
headers, the cross-user isolation guard, and the 404 path.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from uuid import UUID, uuid4

import pytest
from eidan_backend.artifacts import ArtifactService, PostgresArtifactStore
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


async def _seed_user(pool, user_id: UUID, email: str) -> None:
    async with pool.acquire() as conn:
        await conn.execute(
            "INSERT INTO eidan.users (id, email) VALUES ($1, $2) "
            "ON CONFLICT (id) DO NOTHING",
            user_id,
            email,
        )


def _other_identity() -> Identity:
    return Identity(
        user_id="00000000-0000-0000-0000-0000000000b2",
        email="other@example.com",
        session_id=None,
        aal="aal1",
        raw_claims={},
    )


@pytest.fixture
async def http_client(eidan_db: str, stub_provider) -> AsyncIterator:
    import httpx

    pool = await create_pool(eidan_db)
    provider = stub_provider([ScriptedTurn(text="unused")])
    app = await _build_app(pool, provider)
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(
        transport=transport, base_url="http://testserver"
    ) as client:
        yield client, pool
    await pool.close()


@pytest.mark.asyncio
async def test_create_then_download_round_trip(http_client) -> None:
    client, pool = http_client
    owner = build_identity()
    await _seed_user(pool, UUID(owner.user_id), owner.email)

    payload = b"<html><body>deck</body></html>"
    service = ArtifactService(pool, PostgresArtifactStore())
    ref = await service.create(
        owner,
        kind="deck",
        filename="Q2 Board Deck.html",
        data=payload,
        mime_type="text/html",
        metadata={"slides": 3},
    )

    resp = await client.get(
        f"/api/artifacts/{ref.id}",
        headers={"Authorization": f"Bearer {mint_test_token(owner)}"},
    )
    assert resp.status_code == 200, resp.text
    assert resp.content == payload
    assert resp.headers["content-type"].startswith("text/html")
    # RFC 5987 filename* survives the space in the title.
    assert "Q2%20Board%20Deck.html" in resp.headers["content-disposition"]


@pytest.mark.asyncio
async def test_download_is_owner_scoped(http_client) -> None:
    client, pool = http_client
    owner = build_identity()
    other = _other_identity()
    await _seed_user(pool, UUID(owner.user_id), owner.email)
    await _seed_user(pool, UUID(other.user_id), other.email)

    service = ArtifactService(pool, PostgresArtifactStore())
    ref = await service.create(
        owner,
        kind="deck",
        filename="secret.pdf",
        data=b"%PDF-1.4",
        mime_type="application/pdf",
    )

    # The non-owner cannot read it — 404, not 403 (no existence leak).
    resp = await client.get(
        f"/api/artifacts/{ref.id}",
        headers={"Authorization": f"Bearer {mint_test_token(other)}"},
    )
    assert resp.status_code == 404, resp.text


@pytest.mark.asyncio
async def test_download_missing_is_404(http_client) -> None:
    client, pool = http_client
    owner = build_identity()
    await _seed_user(pool, UUID(owner.user_id), owner.email)

    resp = await client.get(
        f"/api/artifacts/{uuid4()}",
        headers={"Authorization": f"Bearer {mint_test_token(owner)}"},
    )
    assert resp.status_code == 404, resp.text


@pytest.mark.asyncio
async def test_messages_payload_includes_artifacts(http_client) -> None:
    # #255 — an artifact produced under a message surfaces in the
    # GET /api/conversations/{id}/messages payload (for the download chip).
    client, pool = http_client
    owner = build_identity()
    await _seed_user(pool, UUID(owner.user_id), owner.email)
    conv_id, msg_id = uuid4(), uuid4()
    async with pool.acquire() as conn:
        await conn.execute(
            "INSERT INTO eidan.conversations (id, user_id) VALUES ($1, $2)",
            conv_id,
            UUID(owner.user_id),
        )
        await conn.execute(
            "INSERT INTO eidan.messages (id, user_id, conversation_id, role, content) "
            "VALUES ($1, $2, $3, 'assistant', 'here is your deck')",
            msg_id,
            UUID(owner.user_id),
            conv_id,
        )

    service = ArtifactService(pool, PostgresArtifactStore())
    ref = await service.create(
        owner,
        kind="deck",
        filename="board.pptx",
        data=b"deck-bytes",
        mime_type="application/vnd.openxmlformats-officedocument.presentationml.presentation",
        message_id=msg_id,
        conversation_id=conv_id,
    )

    resp = await client.get(
        f"/api/conversations/{conv_id}/messages",
        headers={"Authorization": f"Bearer {mint_test_token(owner)}"},
    )
    assert resp.status_code == 200, resp.text
    msg = next(m for m in resp.json()["messages"] if m["id"] == str(msg_id))
    assert len(msg["artifacts"]) == 1
    art = msg["artifacts"][0]
    assert art["filename"] == "board.pptx"
    assert art["kind"] == "deck"
    assert art["download_url"] == f"/api/artifacts/{ref.id}"
