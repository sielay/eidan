# SPDX-License-Identifier: AGPL-3.0-or-later
"""HTTP route tests for GET /api/admin/jobs (#251).

Exercises the shape the /admin/activity jobs tab consumes: rows from
eidan.jobs surfaced newest-first with kind / status / surface /
claimed_by / result / error; a NULL result decodes to {}; an empty
queue yields an empty list rather than 500. Auth gating uses the same
Bearer-token harness as the other admin route tests.
"""

from __future__ import annotations

import json
from collections.abc import AsyncIterator

import pytest
from eidan_backend.db import create_pool
from eidan_backend.http.app import create_app

from .conftest import _get_test_keypair, build_identity, mint_test_token


def _auth_header() -> dict[str, str]:
    return {"Authorization": f"Bearer {mint_test_token(build_identity())}"}


@pytest.fixture
async def jobs_client(eidan_db: str) -> AsyncIterator:
    import httpx

    pool = await create_pool(eidan_db)
    async with pool.acquire() as conn:
        await conn.execute("TRUNCATE eidan.jobs CASCADE")

    private_pem, public_pem = _get_test_keypair()
    app = create_app(
        pool=pool,
        provider=None,
        default_model="claude-haiku-4-5-20251001",
        auth_private_pem=private_pem,
        auth_public_pem=public_pem,
    )
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(
        transport=transport, base_url="http://testserver"
    ) as client:
        yield client, pool
    await pool.close()


@pytest.mark.asyncio
async def test_list_jobs_empty(jobs_client) -> None:
    client, _ = jobs_client
    resp = await client.get("/api/admin/jobs", headers=_auth_header())
    assert resp.status_code == 200
    assert resp.json() == {"jobs": []}


@pytest.mark.asyncio
async def test_list_jobs_requires_auth(jobs_client) -> None:
    client, _ = jobs_client
    resp = await client.get("/api/admin/jobs")
    assert resp.status_code == 401


@pytest.mark.asyncio
async def test_list_jobs_surfaces_rows_newest_first(jobs_client) -> None:
    client, pool = jobs_client
    async with pool.acquire() as conn:
        # created_at set explicitly so ordering is deterministic.
        await conn.execute(
            """
            INSERT INTO eidan.jobs
                (kind, goal, status, surface, claimed_by, claimed_at,
                 result, error, created_at)
            VALUES
                ('code', 'older queued', 'queued', 'web', NULL, NULL,
                 NULL, NULL, now() - interval '2 minutes'),
                ('code', 'done one', 'done', 'agent', 'kasha',
                 now() - interval '1 minute', $1::jsonb, NULL,
                 now() - interval '1 minute'),
                ('code', 'failed one', 'failed', 'slack', 'fly',
                 now() - interval '30 seconds', NULL, 'boom',
                 now() - interval '30 seconds')
            """,
            json.dumps({"pr_url": "https://example/pr/1"}),
        )

    resp = await client.get("/api/admin/jobs", headers=_auth_header())
    assert resp.status_code == 200
    jobs = resp.json()["jobs"]
    assert [j["goal"] for j in jobs] == ["failed one", "done one", "older queued"]

    by_goal = {j["goal"]: j for j in jobs}

    queued = by_goal["older queued"]
    assert queued["status"] == "queued"
    assert queued["kind"] == "code"
    assert queued["surface"] == "web"
    assert queued["claimed_by"] is None
    assert queued["claimed_at"] is None
    # NULL result decodes to an empty object so the UI never sees null.
    assert queued["result"] == {}
    assert queued["error"] is None

    done = by_goal["done one"]
    assert done["status"] == "done"
    assert done["claimed_by"] == "kasha"
    assert done["claimed_at"] is not None
    assert done["result"] == {"pr_url": "https://example/pr/1"}

    failed = by_goal["failed one"]
    assert failed["status"] == "failed"
    assert failed["error"] == "boom"
