# SPDX-License-Identifier: AGPL-3.0-or-later
"""Conversation title tests — auto-title, PATCH rename, regenerate (issue #48).

End-to-end against the real Postgres + scripted provider stack used by
``test_http.py``. Auto-title fires as a fire-and-forget task from the
``/api/turn`` handler after the SSE ``complete`` frame, so the tests
that assert on the persisted title poll the row briefly to ride out
the scheduling lag.
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from uuid import UUID

import httpx
import pytest
from eidan_backend.db import create_pool
from eidan_backend.http.app import create_app

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


def _auth_header(identity=None) -> dict[str, str]:
    identity = identity or build_identity()
    return {"Authorization": f"Bearer {mint_test_token(identity)}"}


@pytest.fixture
async def http_client(eidan_db: str, stub_provider) -> AsyncIterator:
    """Local client fixture — same shape as test_http.py's but scripts
    the provider with a *5th* turn (the auto-title summary that fires
    after every ``/api/turn`` ``complete`` per issue #48)."""
    pool = await create_pool(eidan_db)
    async with pool.acquire() as conn:
        await conn.execute(
            "TRUNCATE eidan.llm_calls, eidan.messages, eidan.conversations "
            "RESTART IDENTITY CASCADE"
        )

    provider = stub_provider(
        [
            ScriptedTurn(text='["chitchat"]'),
            ScriptedTurn(text="claude-sonnet-4-6"),
            ScriptedTurn(text='{"actions": []}'),
            ScriptedTurn(text="hi from the http surface"),
            # Auto-title turn: ≤60 chars, no quotes, no trailing dot.
            ScriptedTurn(text="Greeting Exchange"),
        ]
    )
    app = await _build_app(pool, provider)
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(
        transport=transport, base_url="http://testserver"
    ) as client:
        yield client, pool, provider, _auth_header
    await pool.close()


async def _wait_for_title(
    pool, conversation_id: UUID, *, deadline_seconds: float = 2.0
) -> str | None:
    """Poll the row until the auto-title task lands or the deadline
    elapses. The task is fire-and-forget from inside the SSE handler;
    asserting on it requires riding out the scheduling lag."""
    deadline = asyncio.get_event_loop().time() + deadline_seconds
    while asyncio.get_event_loop().time() < deadline:
        async with pool.acquire() as conn:
            value = await conn.fetchval(
                "SELECT title FROM eidan.conversations WHERE id = $1",
                conversation_id,
            )
        if value is not None:
            return value
        await asyncio.sleep(0.05)
    return None


async def _run_one_turn(client, conversation_id, headers) -> None:
    async with client.stream(
        "POST",
        "/api/turn",
        headers=headers,
        json={
            "conversation_id": conversation_id,
            "text": "hello",
            "sent_at_utc": "2026-05-14T22:13:00Z",
            "user_tz": "Europe/London",
        },
    ) as stream:
        assert stream.status_code == 200
        async for _ in stream.aiter_text():
            pass


@pytest.mark.asyncio
async def test_first_turn_auto_titles_the_conversation(http_client) -> None:
    """A conversation starts titleless; after the first turn completes,
    the background task summarises the opening exchange into a sidebar
    label and the next GET sees it."""
    client, pool, _, mint = http_client
    identity = build_identity()
    headers = mint(identity)

    resp = await client.post(
        "/api/conversations", headers=headers, json={"title": None}
    )
    assert resp.status_code == 200
    conversation_id = resp.json()["id"]

    await _run_one_turn(client, conversation_id, headers)

    title = await _wait_for_title(pool, UUID(conversation_id))
    assert title == "Greeting Exchange"


@pytest.mark.asyncio
async def test_auto_title_is_idempotent_on_existing_title(
    eidan_db, stub_provider
) -> None:
    """If the operator already set a title (or a prior auto-title
    landed), a subsequent turn does NOT overwrite it — the SQL guard
    is ``title IS NULL``."""
    pool = await create_pool(eidan_db)
    async with pool.acquire() as conn:
        await conn.execute(
            "TRUNCATE eidan.llm_calls, eidan.messages, eidan.conversations "
            "RESTART IDENTITY CASCADE"
        )

    # Five-call script: turn pipeline (4) + auto-title (would be 5th, but
    # we'll create the conversation with a pre-set title so this 5th
    # call should still run but the SQL update guard prevents overwrite.
    provider = stub_provider(
        [
            ScriptedTurn(text='["chitchat"]'),
            ScriptedTurn(text="claude-sonnet-4-6"),
            ScriptedTurn(text='{"actions": []}'),
            ScriptedTurn(text="hi"),
            ScriptedTurn(text="Some Other Title"),
        ]
    )
    app = await _build_app(pool, provider)
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(
        transport=transport, base_url="http://testserver"
    ) as client:
        identity = build_identity()
        headers = _auth_header(identity)

        resp = await client.post(
            "/api/conversations",
            headers=headers,
            json={"title": "Operator Pinned"},
        )
        assert resp.status_code == 200
        conversation_id = resp.json()["id"]

        await _run_one_turn(client, conversation_id, headers)

        # Give the background task a moment to run + lose against the
        # ``title IS NULL`` SQL guard.
        await asyncio.sleep(0.2)

        async with pool.acquire() as conn:
            title = await conn.fetchval(
                "SELECT title FROM eidan.conversations WHERE id = $1",
                UUID(conversation_id),
            )
        assert title == "Operator Pinned"
    await pool.close()


@pytest.mark.asyncio
async def test_patch_conversation_title_sets_and_clears(http_client) -> None:
    """PATCH writes the title; PATCH with null clears it back to
    autogen-eligible."""
    client, pool, _, mint = http_client
    identity = build_identity()
    headers = mint(identity)

    resp = await client.post(
        "/api/conversations", headers=headers, json={"title": "initial"}
    )
    conversation_id = resp.json()["id"]

    # Set.
    resp = await client.patch(
        f"/api/conversations/{conversation_id}",
        headers=headers,
        json={"title": "Renamed by operator"},
    )
    assert resp.status_code == 200, resp.text
    assert resp.json() == {
        "id": conversation_id,
        "title": "Renamed by operator",
    }

    # Whitespace-only collapses to null.
    resp = await client.patch(
        f"/api/conversations/{conversation_id}",
        headers=headers,
        json={"title": "   "},
    )
    assert resp.status_code == 200
    assert resp.json()["title"] is None

    # Explicit null also clears.
    resp = await client.patch(
        f"/api/conversations/{conversation_id}",
        headers=headers,
        json={"title": None},
    )
    assert resp.status_code == 200
    assert resp.json()["title"] is None

    async with pool.acquire() as conn:
        stored = await conn.fetchval(
            "SELECT title FROM eidan.conversations WHERE id = $1",
            UUID(conversation_id),
        )
    assert stored is None


@pytest.mark.asyncio
async def test_patch_rejects_unknown_owner(http_client) -> None:
    """A PATCH against another user's conversation returns 404, not 403
    — same envelope as the other ownership-guarded routes."""
    from eidan_backend.identity import Identity

    client, _, _, mint = http_client
    alice = Identity(
        user_id="00000000-0000-0000-0000-00000000aaaa",
        email="alice@example.com",
        session_id=None,
        aal="aal1",
        raw_claims={},
    )
    bob = Identity(
        user_id="00000000-0000-0000-0000-00000000bbbb",
        email="bob@example.com",
        session_id=None,
        aal="aal1",
        raw_claims={},
    )

    resp = await client.post(
        "/api/conversations",
        headers=mint(alice),
        json={"title": "alice"},
    )
    conversation_id = resp.json()["id"]

    resp = await client.patch(
        f"/api/conversations/{conversation_id}",
        headers=mint(bob),
        json={"title": "stolen"},
    )
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_patch_requires_auth(http_client) -> None:
    client, _, _, _ = http_client
    resp = await client.patch(
        "/api/conversations/00000000-0000-0000-0000-000000000001",
        json={"title": "x"},
    )
    assert resp.status_code == 401


@pytest.mark.asyncio
async def test_regenerate_title_runs_the_summary(
    eidan_db, stub_provider
) -> None:
    """POST /regenerate_title triggers the cheap summary inline and
    overwrites whatever title the row had."""
    pool = await create_pool(eidan_db)
    async with pool.acquire() as conn:
        await conn.execute(
            "TRUNCATE eidan.llm_calls, eidan.messages, eidan.conversations "
            "RESTART IDENTITY CASCADE"
        )

    provider = stub_provider(
        [
            ScriptedTurn(text='["chitchat"]'),
            ScriptedTurn(text="claude-sonnet-4-6"),
            ScriptedTurn(text='{"actions": []}'),
            ScriptedTurn(text="primary reply"),
            ScriptedTurn(text="Auto Title"),  # auto-title after turn
            ScriptedTurn(text="Regenerated Title"),  # regenerate endpoint
        ]
    )
    app = await _build_app(pool, provider)
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(
        transport=transport, base_url="http://testserver"
    ) as client:
        identity = build_identity()
        headers = _auth_header(identity)

        resp = await client.post(
            "/api/conversations", headers=headers, json={}
        )
        conversation_id = resp.json()["id"]

        await _run_one_turn(client, conversation_id, headers)
        first = await _wait_for_title(pool, UUID(conversation_id))
        assert first == "Auto Title"

        # Regenerate — picks up the next scripted call.
        resp = await client.post(
            f"/api/conversations/{conversation_id}/regenerate_title",
            headers=headers,
        )
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body == {"id": conversation_id, "title": "Regenerated Title"}

        async with pool.acquire() as conn:
            stored = await conn.fetchval(
                "SELECT title FROM eidan.conversations WHERE id = $1",
                UUID(conversation_id),
            )
        assert stored == "Regenerated Title"
    await pool.close()


@pytest.mark.asyncio
async def test_regenerate_with_no_messages_clears_title(http_client) -> None:
    """A conversation with no turns yet can't be summarised — the
    endpoint clears any existing title so the next first-turn lands
    the auto-title path on a fresh row."""
    client, pool, _, mint = http_client
    identity = build_identity()
    headers = mint(identity)

    resp = await client.post(
        "/api/conversations", headers=headers, json={"title": "stale"}
    )
    conversation_id = resp.json()["id"]

    resp = await client.post(
        f"/api/conversations/{conversation_id}/regenerate_title",
        headers=headers,
    )
    assert resp.status_code == 200
    assert resp.json() == {"id": conversation_id, "title": None}

    async with pool.acquire() as conn:
        stored = await conn.fetchval(
            "SELECT title FROM eidan.conversations WHERE id = $1",
            UUID(conversation_id),
        )
    assert stored is None
