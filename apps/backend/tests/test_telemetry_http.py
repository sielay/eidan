# SPDX-License-Identifier: AGPL-3.0-or-later
"""HTTP route tests for /api/admin/nodes + /api/admin/nodes/{id}/events.

Exercises the read-side shape: payload coercion, after_seq paging,
conversation_id filtering, the 404 on an unknown node_id. Auth is
asserted via the same Bearer-token harness ``test_http.py`` uses."""

from __future__ import annotations

from collections.abc import AsyncIterator
from uuid import uuid4

import pytest
from eidan_backend.db import create_pool
from eidan_backend.http.app import create_app
from eidan_backend.node_identity import NodeIdentity
from eidan_backend.telemetry import TelemetryEmitter

from .conftest import _get_test_keypair, build_identity, mint_test_token


def _auth_header() -> dict[str, str]:
    return {"Authorization": f"Bearer {mint_test_token(build_identity())}"}


@pytest.fixture
async def telemetry_client(eidan_db: str) -> AsyncIterator:
    import httpx

    pool = await create_pool(eidan_db)
    async with pool.acquire() as conn:
        await conn.execute(
            "TRUNCATE eidan.node_events, eidan.node_heartbeats CASCADE"
        )

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


async def _seed(
    pool,
    node_id: str,
    node_type: str = "pi",
    emit_count: int = 0,
    plugins: list[dict[str, str]] | None = None,
    served_kinds: list[dict] | None = None,
):
    """Seed a heartbeat + N events for the given node."""
    identity = NodeIdentity(
        node_id=node_id, node_type=node_type, metadata={"hostname": "test"}
    )
    emitter = TelemetryEmitter(
        pool=pool,
        identity=identity,
        heartbeat_interval_seconds=3600,
        plugins=plugins,
        served_kinds=served_kinds,
    )
    await emitter.start()
    for i in range(emit_count):
        await emitter.emit_event(f"test.{i}", {"i": i})
    await emitter.stop()


@pytest.mark.asyncio
async def test_list_nodes_returns_heartbeats(telemetry_client) -> None:
    client, pool = telemetry_client
    await _seed(pool, "pi-raspberry", "pi", emit_count=0)
    await _seed(pool, "m-fly-1", "fly", emit_count=0)

    resp = await client.get("/api/admin/nodes", headers=_auth_header())
    assert resp.status_code == 200
    body = resp.json()
    by_id = {n["node_id"]: n for n in body["nodes"]}
    assert {"pi-raspberry", "m-fly-1"} <= by_id.keys()
    assert by_id["pi-raspberry"]["node_type"] == "pi"
    assert by_id["m-fly-1"]["node_type"] == "fly"
    assert by_id["pi-raspberry"]["status"] == "online"
    assert by_id["pi-raspberry"]["metadata"]["hostname"] == "test"
    assert isinstance(by_id["pi-raspberry"]["seconds_since"], int)


@pytest.mark.asyncio
async def test_list_nodes_exposes_plugins(telemetry_client) -> None:
    """`/api/admin/nodes` surfaces each heartbeat's plugin snapshot
    so the admin pane can confirm what landed on a given node
    (issue #52). Different nodes are allowed to report different
    sets — the Pi and a Fly machine carry their own per-process
    discovery results."""
    client, pool = telemetry_client
    await _seed(
        pool,
        "pi-with-plugins",
        "pi",
        plugins=[
            {"name": "calendar", "version": "1.2.3", "tier": "pro"},
            {"name": "telegram", "version": "0.4.0", "tier": "core"},
        ],
    )
    await _seed(pool, "fly-bare", "fly", plugins=[])

    resp = await client.get("/api/admin/nodes", headers=_auth_header())
    assert resp.status_code == 200
    body = resp.json()
    by_id = {n["node_id"]: n for n in body["nodes"]}
    pi_plugins = by_id["pi-with-plugins"]["plugins"]
    assert {p["name"] for p in pi_plugins} == {"calendar", "telegram"}
    calendar = next(p for p in pi_plugins if p["name"] == "calendar")
    assert calendar["version"] == "1.2.3"
    assert calendar["tier"] == "pro"
    # A node with no plugins surfaces an explicit empty array so
    # the UI doesn't have to guard for missing keys.
    assert by_id["fly-bare"]["plugins"] == []


@pytest.mark.asyncio
async def test_list_nodes_exposes_served_kinds(telemetry_client) -> None:
    """`/api/admin/nodes` surfaces each heartbeat's served-kinds
    advertisement (issue #249) so the admin pane shows which kinds a
    node serves from the delegation queue and with what capacity. A
    node that serves no kinds returns an explicit empty array."""
    client, pool = telemetry_client
    await _seed(
        pool,
        "pi-coder",
        "pi",
        served_kinds=[{"kind": "code", "capacity": 2}],
    )
    await _seed(pool, "fly-api", "fly", served_kinds=[])

    resp = await client.get("/api/admin/nodes", headers=_auth_header())
    assert resp.status_code == 200
    body = resp.json()
    by_id = {n["node_id"]: n for n in body["nodes"]}
    coder_kinds = by_id["pi-coder"]["served_kinds"]
    assert {k["kind"] for k in coder_kinds} == {"code"}
    assert next(k for k in coder_kinds if k["kind"] == "code")["capacity"] == 2
    # A node that serves nothing surfaces an explicit empty array.
    assert by_id["fly-api"]["served_kinds"] == []


@pytest.mark.asyncio
async def test_list_nodes_requires_auth(telemetry_client) -> None:
    client, _ = telemetry_client
    resp = await client.get("/api/admin/nodes")
    assert resp.status_code == 401


@pytest.mark.asyncio
async def test_node_events_unknown_node_returns_404(telemetry_client) -> None:
    client, _ = telemetry_client
    resp = await client.get(
        "/api/admin/nodes/never-heartbeated/events",
        headers=_auth_header(),
    )
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_node_events_default_returns_desc(telemetry_client) -> None:
    """Default (no after_seq, no conversation_id) returns latest first."""
    client, pool = telemetry_client
    await _seed(pool, "tail-node", emit_count=3)

    resp = await client.get(
        "/api/admin/nodes/tail-node/events", headers=_auth_header()
    )
    assert resp.status_code == 200
    body = resp.json()
    # _seed() drives TelemetryEmitter directly — no bootstrap(),
    # so no `node.boot` / `plugin.activate` rows. start() upserts
    # the heartbeat (one row in node_heartbeats, none in
    # node_events); emit_event x 3 then produces seq 1, 2, 3 in
    # order. DESC: seq=3 first.
    types = [e["type"] for e in body["events"]]
    assert types == ["test.2", "test.1", "test.0"]
    # id is "{node_id}:{seq}", same as potem.
    assert all(
        e["id"] == f"tail-node:{e['seq']}" for e in body["events"]
    )


@pytest.mark.asyncio
async def test_node_events_after_seq_paging(telemetry_client) -> None:
    """after_seq returns only rows past that seq."""
    client, pool = telemetry_client
    await _seed(pool, "page-node", emit_count=5)

    # Fetch newest first to find the max seq.
    full = await client.get(
        "/api/admin/nodes/page-node/events", headers=_auth_header()
    )
    seqs = sorted(e["seq"] for e in full.json()["events"])
    max_seq = seqs[-1]

    # Ask for events strictly past max_seq → empty.
    resp = await client.get(
        f"/api/admin/nodes/page-node/events?after_seq={max_seq}",
        headers=_auth_header(),
    )
    assert resp.json()["events"] == []

    # Ask past max_seq - 2 → exactly two rows (max_seq-1, max_seq).
    resp = await client.get(
        f"/api/admin/nodes/page-node/events?after_seq={max_seq - 2}",
        headers=_auth_header(),
    )
    page_seqs = sorted(e["seq"] for e in resp.json()["events"])
    assert page_seqs == [max_seq - 1, max_seq]


@pytest.mark.asyncio
async def test_node_events_conversation_filter_returns_asc(
    telemetry_client,
) -> None:
    """With conversation_id, the route filters AND switches to ASC
    (chronological order, mirrors chat-message tail)."""
    client, pool = telemetry_client
    conv_id = uuid4()
    identity = NodeIdentity(
        node_id="conv-route-node",
        node_type="local",
        metadata={"hostname": "test"},
    )
    emitter = TelemetryEmitter(
        pool=pool, identity=identity, heartbeat_interval_seconds=3600
    )
    await emitter.start()
    try:
        await emitter.emit_event("a", {}, conversation_id=conv_id)
        await emitter.emit_event("noise", {})  # different (NULL) conversation
        await emitter.emit_event("b", {}, conversation_id=conv_id)
        await emitter.emit_event("c", {}, conversation_id=conv_id)
    finally:
        await emitter.stop()

    resp = await client.get(
        f"/api/admin/nodes/conv-route-node/events?conversation_id={conv_id}",
        headers=_auth_header(),
    )
    assert resp.status_code == 200
    body = resp.json()
    types = [e["type"] for e in body["events"]]
    # Filtered to conv_id only AND ascending.
    assert types == ["a", "b", "c"]
    assert all(e["conversation_id"] == str(conv_id) for e in body["events"])
