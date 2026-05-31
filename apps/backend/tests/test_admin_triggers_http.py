# SPDX-License-Identifier: AGPL-3.0-or-later
"""HTTP route tests for GET /api/admin/triggers.

Exercises the shape that the /admin/activity triggers tab consumes:
registry rows are surfaced with plugin / kind / spec / next_run_ts,
dlq_count counts only pending behaviour_dlq rows, an empty registry
yields an empty list rather than 500. Auth gating is asserted via the
same Bearer-token harness the other admin route tests use.
"""

from __future__ import annotations

from collections.abc import AsyncIterator

import pytest
from apscheduler.schedulers.asyncio import AsyncIOScheduler
from eidan_backend.behaviours import (
    Behaviour,
    BehaviourDispatcher,
    BehaviourRegistry,
    Trigger,
)
from eidan_backend.db import create_pool
from eidan_backend.http.app import create_app

from .conftest import _get_test_keypair, build_identity, mint_test_token


def _auth_header() -> dict[str, str]:
    return {"Authorization": f"Bearer {mint_test_token(build_identity())}"}


async def _noop_handler(_event):  # pragma: no cover - never fired in these tests
    return None


@pytest.fixture
async def triggers_client(eidan_db: str) -> AsyncIterator:
    import httpx

    pool = await create_pool(eidan_db)
    async with pool.acquire() as conn:
        await conn.execute("TRUNCATE eidan.behaviour_dlq")

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
        yield client, pool, app
    await pool.close()


@pytest.mark.asyncio
async def test_list_triggers_empty_when_no_registry(triggers_client) -> None:
    """Test app builds without bootstrap — registry is None.

    The route degrades to an empty list rather than 500 so the admin
    pane works on a fresh deployment with no plugins activated yet.
    """
    client, _, _ = triggers_client
    resp = await client.get("/api/admin/triggers", headers=_auth_header())
    assert resp.status_code == 200
    body = resp.json()
    assert body == {"triggers": [], "dlq_count": 0}


@pytest.mark.asyncio
async def test_list_triggers_requires_auth(triggers_client) -> None:
    client, _, _ = triggers_client
    resp = await client.get("/api/admin/triggers")
    assert resp.status_code == 401


@pytest.mark.asyncio
async def test_list_triggers_surfaces_registered_behaviours(
    triggers_client,
) -> None:
    """Wire up a registry + dispatcher and confirm the route reads them."""
    client, _, app = triggers_client
    registry = BehaviourRegistry()
    registry.register(
        Behaviour(
            id="sentry:tick",
            trigger=Trigger(kind="cron", spec="*/15 * * * *"),
            handler=_noop_handler,
        )
    )
    registry.register(
        Behaviour(
            id="example:on-note",
            trigger=Trigger(kind="event", spec="notes.created"),
            handler=_noop_handler,
        )
    )
    scheduler = AsyncIOScheduler()
    dispatcher = BehaviourDispatcher(registry, scheduler=scheduler)
    # Start the dispatcher so the cron job lands in APScheduler and
    # next_run_time is populated. Event triggers don't need scheduling.
    dispatcher.start()
    try:
        app.state.behaviour_registry = registry
        app.state.behaviour_dispatcher = dispatcher

        resp = await client.get("/api/admin/triggers", headers=_auth_header())
        assert resp.status_code == 200
        body = resp.json()
        by_id = {t["behaviour_id"]: t for t in body["triggers"]}
        assert {"sentry:tick", "example:on-note"} == by_id.keys()

        cron_row = by_id["sentry:tick"]
        assert cron_row["plugin"] == "sentry"
        assert cron_row["kind"] == "cron"
        assert cron_row["spec"] == "*/15 * * * *"
        # APScheduler has a next-fire time for cron jobs once started.
        assert cron_row["next_run_ts"] is not None

        event_row = by_id["example:on-note"]
        assert event_row["plugin"] == "example"
        assert event_row["kind"] == "event"
        # Event subscribers don't have a scheduled firing.
        assert event_row["next_run_ts"] is None
    finally:
        dispatcher.shutdown()


@pytest.mark.asyncio
async def test_list_triggers_dlq_count_only_pending(triggers_client) -> None:
    """dlq_count must reflect only ``status='pending'`` rows.

    Acknowledged / resolved rows are intentionally excluded — once an
    operator has triaged a failure it shouldn't keep ringing the alarm.
    """
    client, pool, _ = triggers_client
    async with pool.acquire() as conn:
        # Two pending, one acknowledged, one resolved.
        await conn.executemany(
            """
            INSERT INTO eidan.behaviour_dlq
                (behaviour_id, trigger_kind, idempotency_key,
                 error_class, error_message, status)
            VALUES ($1, 'cron', $2, 'RuntimeError', 'boom', $3)
            """,
            [
                ("sentry:tick", "k1", "pending"),
                ("sentry:tick", "k2", "pending"),
                ("sentry:tick", "k3", "acknowledged"),
                ("sentry:tick", "k4", "resolved"),
            ],
        )

    resp = await client.get("/api/admin/triggers", headers=_auth_header())
    assert resp.status_code == 200
    assert resp.json()["dlq_count"] == 2
