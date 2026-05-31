# SPDX-License-Identifier: AGPL-3.0-or-later
"""HTTP surface tests for editable knowledge rows (issue #49).

Exercises ``PATCH /api/knowledge/{id}`` and
``DELETE /api/knowledge/{id}`` end-to-end against the ephemeral
Postgres fixture: the optimistic-concurrency 409, the
link-extractor wire-up on body change, the soft-delete contract,
and the cross-user isolation guard.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from datetime import UTC, datetime
from uuid import UUID, uuid4

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
    identity = identity or build_identity()
    return {"Authorization": f"Bearer {mint_test_token(identity)}"}


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
        yield client, pool, _auth_header
    await pool.close()


async def _seed_user(pool, user_id: UUID, email: str = "test@example.com") -> None:
    async with pool.acquire() as conn:
        await conn.execute(
            "INSERT INTO eidan.users (id, email) VALUES ($1, $2) "
            "ON CONFLICT (id) DO NOTHING",
            user_id,
            email,
        )


async def _seed_knowledge(
    pool,
    *,
    user_id: UUID,
    body: str,
    slug: str | None = None,
    title: str = "Untitled",
    skill: str = "general",
) -> tuple[UUID, datetime]:
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            """
            INSERT INTO eidan.knowledge
                (user_id, slug, title, skill, body, source)
            VALUES ($1, $2, $3, $4, $5, 'agent')
            RETURNING id, updated_at
            """,
            user_id,
            slug,
            title,
            skill,
            body,
        )
    return row["id"], row["updated_at"]


@pytest.mark.asyncio
async def test_patch_updates_title_and_body(http_client) -> None:
    client, pool, mint = http_client
    identity = build_identity()
    headers = mint(identity)
    user_uuid = UUID(identity.user_id)
    await _seed_user(pool, user_uuid)

    row_id, updated_at = await _seed_knowledge(
        pool, user_id=user_uuid, body="initial body", title="Old"
    )

    resp = await client.patch(
        f"/api/knowledge/{row_id}",
        headers=headers,
        json={
            "title": "New",
            "body": "Updated body with [[fresh-link]] inside.",
            "expected_updated_at": updated_at.astimezone(UTC).isoformat(),
        },
    )
    assert resp.status_code == 200, resp.text
    payload = resp.json()["knowledge"]
    assert payload["title"] == "New"
    assert "fresh-link" in payload["body"]
    new_updated = datetime.fromisoformat(payload["updated_at"])
    assert new_updated > updated_at

    async with pool.acquire() as conn:
        # The link extractor ran in the same transaction.
        links = await conn.fetch(
            "SELECT to_slug FROM eidan.knowledge_links "
            "WHERE from_knowledge_id = $1",
            row_id,
        )
    assert [link["to_slug"] for link in links] == ["fresh-link"]


@pytest.mark.asyncio
async def test_patch_skill_only_does_not_re_extract_links(http_client) -> None:
    client, pool, mint = http_client
    identity = build_identity()
    headers = mint(identity)
    user_uuid = UUID(identity.user_id)
    await _seed_user(pool, user_uuid)

    row_id, updated_at = await _seed_knowledge(
        pool, user_id=user_uuid, body="Body with [[stale-link]] inside."
    )
    # Pre-seed a stale link row to assert it is *not* rewritten when
    # only ``skill`` is touched.
    async with pool.acquire() as conn:
        await conn.execute(
            """
            INSERT INTO eidan.knowledge_links
                (user_id, from_knowledge_id, to_knowledge_id, to_slug,
                 link_type, position_offset, surrounding_context)
            VALUES ($1, $2, NULL, 'sentinel', 'wikilink', 0, 'sentinel')
            """,
            user_uuid,
            row_id,
        )

    resp = await client.patch(
        f"/api/knowledge/{row_id}",
        headers=headers,
        json={
            "skill": "coding",
            "expected_updated_at": updated_at.astimezone(UTC).isoformat(),
        },
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["knowledge"]["skill"] == "coding"

    async with pool.acquire() as conn:
        slugs = [
            row["to_slug"]
            for row in await conn.fetch(
                "SELECT to_slug FROM eidan.knowledge_links "
                "WHERE from_knowledge_id = $1",
                row_id,
            )
        ]
    assert "sentinel" in slugs, "skill-only patch must not re-extract links"


@pytest.mark.asyncio
async def test_patch_returns_409_on_stale_timestamp(http_client) -> None:
    client, pool, mint = http_client
    identity = build_identity()
    headers = mint(identity)
    user_uuid = UUID(identity.user_id)
    await _seed_user(pool, user_uuid)

    row_id, original = await _seed_knowledge(
        pool, user_id=user_uuid, body="original"
    )

    # Simulate an agent-side write that bumps updated_at after the
    # operator's fetch but before their save.
    async with pool.acquire() as conn:
        await conn.execute(
            "UPDATE eidan.knowledge "
            "SET body = $1, updated_at = now() + interval '1 second' "
            "WHERE id = $2",
            "agent-written body",
            row_id,
        )

    resp = await client.patch(
        f"/api/knowledge/{row_id}",
        headers=headers,
        json={
            "body": "operator overwrite",
            "expected_updated_at": original.astimezone(UTC).isoformat(),
        },
    )
    assert resp.status_code == 409, resp.text

    async with pool.acquire() as conn:
        body = await conn.fetchval(
            "SELECT body FROM eidan.knowledge WHERE id = $1", row_id
        )
    assert body == "agent-written body", "409 must not clobber the agent write"


@pytest.mark.asyncio
async def test_patch_404_for_missing_row(http_client) -> None:
    client, pool, mint = http_client
    identity = build_identity()
    headers = mint(identity)
    await _seed_user(pool, UUID(identity.user_id))

    resp = await client.patch(
        f"/api/knowledge/{uuid4()}",
        headers=headers,
        json={
            "body": "noop",
            "expected_updated_at": datetime.now(UTC).isoformat(),
        },
    )
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_patch_rejects_empty_payload(http_client) -> None:
    client, pool, mint = http_client
    identity = build_identity()
    headers = mint(identity)
    user_uuid = UUID(identity.user_id)
    await _seed_user(pool, user_uuid)
    row_id, updated_at = await _seed_knowledge(pool, user_id=user_uuid, body="x")

    resp = await client.patch(
        f"/api/knowledge/{row_id}",
        headers=headers,
        json={"expected_updated_at": updated_at.astimezone(UTC).isoformat()},
    )
    assert resp.status_code == 400


@pytest.mark.asyncio
async def test_patch_isolates_users(http_client) -> None:
    """An operator must not be able to PATCH another user's row."""
    client, pool, mint = http_client
    identity = build_identity()
    headers = mint(identity)
    other_user = UUID("00000000-0000-0000-0000-00000000beef")
    await _seed_user(pool, UUID(identity.user_id))
    await _seed_user(pool, other_user, email="other@example.com")

    row_id, updated_at = await _seed_knowledge(
        pool, user_id=other_user, body="not yours"
    )

    resp = await client.patch(
        f"/api/knowledge/{row_id}",
        headers=headers,
        json={
            "body": "stolen",
            "expected_updated_at": updated_at.astimezone(UTC).isoformat(),
        },
    )
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_delete_soft_deletes_row(http_client) -> None:
    client, pool, mint = http_client
    identity = build_identity()
    headers = mint(identity)
    user_uuid = UUID(identity.user_id)
    await _seed_user(pool, user_uuid)
    row_id, _ = await _seed_knowledge(pool, user_id=user_uuid, body="bye")

    resp = await client.delete(f"/api/knowledge/{row_id}", headers=headers)
    assert resp.status_code == 204

    # Row still in the table, but soft-deleted; GET hides it.
    async with pool.acquire() as conn:
        deleted_at = await conn.fetchval(
            "SELECT deleted_at FROM eidan.knowledge WHERE id = $1", row_id
        )
    assert deleted_at is not None

    get_resp = await client.get(f"/api/knowledge/{row_id}", headers=headers)
    assert get_resp.status_code == 404


@pytest.mark.asyncio
async def test_delete_is_idempotent(http_client) -> None:
    client, pool, mint = http_client
    identity = build_identity()
    headers = mint(identity)
    user_uuid = UUID(identity.user_id)
    await _seed_user(pool, user_uuid)
    row_id, _ = await _seed_knowledge(pool, user_id=user_uuid, body="bye")

    first = await client.delete(f"/api/knowledge/{row_id}", headers=headers)
    second = await client.delete(f"/api/knowledge/{row_id}", headers=headers)
    assert first.status_code == 204
    assert second.status_code == 204


@pytest.mark.asyncio
async def test_delete_404_for_unknown_row(http_client) -> None:
    client, pool, mint = http_client
    identity = build_identity()
    headers = mint(identity)
    await _seed_user(pool, UUID(identity.user_id))

    resp = await client.delete(f"/api/knowledge/{uuid4()}", headers=headers)
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_delete_isolates_users(http_client) -> None:
    client, pool, mint = http_client
    identity = build_identity()
    headers = mint(identity)
    other_user = UUID("00000000-0000-0000-0000-00000000beef")
    await _seed_user(pool, UUID(identity.user_id))
    await _seed_user(pool, other_user, email="other@example.com")
    row_id, _ = await _seed_knowledge(pool, user_id=other_user, body="not yours")

    resp = await client.delete(f"/api/knowledge/{row_id}", headers=headers)
    assert resp.status_code == 404

    async with pool.acquire() as conn:
        deleted_at = await conn.fetchval(
            "SELECT deleted_at FROM eidan.knowledge WHERE id = $1", row_id
        )
    assert deleted_at is None, "other user's row must remain untouched"
