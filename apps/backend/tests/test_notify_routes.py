# SPDX-License-Identifier: AGPL-3.0-or-later
"""Tests for topology-driven notification routing (notify_routes.py)."""

from __future__ import annotations

import pytest
from eidan_backend.notify_routes import (
    NotificationRouteResolver,
    Route,
    load_routes,
    make_route_resolver,
)

# ---- load_routes ---------------------------------------------------------


def test_load_routes_parses_valid():
    raw = (
        '{"node.startup": {"channel": "slack", "target": "#eidan-deployments"},'
        ' "sentry": {"channel": "slack", "target": "#eidan-sentry"}}'
    )
    routes = load_routes(raw)
    assert routes["node.startup"] == Route("slack", "#eidan-deployments")
    assert routes["sentry"] == Route("slack", "#eidan-sentry")


@pytest.mark.parametrize("raw", [None, "", "   ", "not-json", "[1,2]", "42"])
def test_load_routes_bad_input_is_empty(raw):
    # Malformed / non-object input never raises — returns {}.
    assert load_routes(raw) == {}


def test_load_routes_skips_route_without_channel():
    raw = '{"ok": {"channel": "slack", "target": "#x"}, "bad": {"target": "#y"}}'
    routes = load_routes(raw)
    assert "ok" in routes and "bad" not in routes


def test_load_routes_target_optional():
    routes = load_routes('{"t": {"channel": "slack"}}')
    assert routes["t"] == Route("slack", None)


# ---- resolver ------------------------------------------------------------


class _FakeRouter:
    def __init__(self):
        self.calls = []
        self.raise_on_notify = False

    async def notify(self, *, channel, text, user_id=None, metadata=None):
        if self.raise_on_notify:
            raise RuntimeError("slack down")
        self.calls.append(
            {"channel": channel, "text": text, "metadata": metadata}
        )
        return {"ok": True}


@pytest.mark.asyncio
async def test_emit_routes_slack_target_to_slack_channel():
    router = _FakeRouter()
    resolver = NotificationRouteResolver(
        router, {"sentry": Route("slack", "#eidan-sentry")}
    )
    result = await resolver.emit("sentry", "high pattern", severity="warn")
    assert result == {"ok": True}
    call = router.calls[0]
    assert call["channel"] == "slack"
    assert call["metadata"]["slack_channel"] == "#eidan-sentry"
    assert call["metadata"]["severity"] == "warn"
    assert call["metadata"]["topic"] == "sentry"


@pytest.mark.asyncio
async def test_emit_maps_telegram_target_to_chat_id():
    router = _FakeRouter()
    resolver = NotificationRouteResolver(
        router, {"t": Route("telegram", "12345")}
    )
    await resolver.emit("t", "hi")
    assert router.calls[0]["metadata"]["chat_id"] == "12345"


@pytest.mark.asyncio
async def test_emit_unrouted_topic_is_noop():
    router = _FakeRouter()
    resolver = NotificationRouteResolver(router, {})
    assert await resolver.emit("nope", "x") is None
    assert router.calls == []


@pytest.mark.asyncio
async def test_emit_swallows_router_errors():
    router = _FakeRouter()
    router.raise_on_notify = True
    resolver = NotificationRouteResolver(router, {"t": Route("slack", "#x")})
    # A delivery failure must not propagate to the caller.
    assert await resolver.emit("t", "x") is None


def test_make_route_resolver_none_without_router():
    assert make_route_resolver(None) is None


def test_make_route_resolver_reads_env(monkeypatch):
    monkeypatch.setenv(
        "EIDAN_NOTIFY_ROUTES",
        '{"node.startup": {"channel": "slack", "target": "#d"}}',
    )
    resolver = make_route_resolver(_FakeRouter())
    assert resolver is not None
    assert resolver.routes["node.startup"] == Route("slack", "#d")
