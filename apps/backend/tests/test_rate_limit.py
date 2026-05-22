"""Webhook rate limit tests (audit §5 fix 3/3).

Two halves:

- :class:`WebhookRateLimiter` unit tests — exercise the
  sliding-window logic directly. The limiter is per-process so
  these tests run isolated; each constructs a fresh limiter.
- HTTP integration tests — POST /api/webhooks/<plugin>/<slug>
  repeatedly and verify the 429 + Retry-After lands at the cap.
"""

from __future__ import annotations

import pytest
from apscheduler.schedulers.asyncio import AsyncIOScheduler
from eidan_backend.behaviours import (
    Behaviour,
    BehaviourDispatcher,
    BehaviourRegistry,
    BehaviourResult,
    TriggerEvent,
    parse_trigger,
)
from eidan_backend.http.rate_limit import (
    RateLimitExceeded,
    WebhookRateLimiter,
)

# ---- limiter unit tests --------------------------------------------------


@pytest.mark.asyncio
async def test_limit_allows_under_cap() -> None:
    limiter = WebhookRateLimiter(limit_per_minute=3)
    await limiter.check("k")
    await limiter.check("k")
    await limiter.check("k")
    # Three calls allowed, the fourth trips.


@pytest.mark.asyncio
async def test_limit_raises_at_cap() -> None:
    limiter = WebhookRateLimiter(limit_per_minute=2)
    await limiter.check("k")
    await limiter.check("k")
    with pytest.raises(RateLimitExceeded) as exc:
        await limiter.check("k")
    assert exc.value.key == "k"
    assert exc.value.retry_after >= 1


@pytest.mark.asyncio
async def test_disabled_when_limit_is_zero() -> None:
    limiter = WebhookRateLimiter(limit_per_minute=0)
    for _ in range(100):
        await limiter.check("k")  # zero = disabled


@pytest.mark.asyncio
async def test_separate_keys_have_separate_budgets() -> None:
    limiter = WebhookRateLimiter(limit_per_minute=1)
    await limiter.check("a")
    await limiter.check("b")  # different key, separate budget
    with pytest.raises(RateLimitExceeded):
        await limiter.check("a")
    with pytest.raises(RateLimitExceeded):
        await limiter.check("b")


@pytest.mark.asyncio
async def test_window_slides_with_short_window() -> None:
    """Use a very short window so the test doesn't sleep a minute.
    After the window elapses the oldest timestamps evict and the
    next check succeeds again."""
    import asyncio

    limiter = WebhookRateLimiter(limit_per_minute=1, window_seconds=0.05)
    await limiter.check("k")
    with pytest.raises(RateLimitExceeded):
        await limiter.check("k")
    # Wait past the window — the slot frees up.
    await asyncio.sleep(0.1)
    await limiter.check("k")


@pytest.mark.asyncio
async def test_env_override_changes_limit(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Without a constructor-passed limit the limiter reads the env
    var late (per call) so monkeypatching mid-test takes effect."""
    monkeypatch.setenv("EIDAN_WEBHOOK_RATE_LIMIT_PER_MINUTE", "1")
    limiter = WebhookRateLimiter()  # picks up env-var default
    await limiter.check("k")
    with pytest.raises(RateLimitExceeded):
        await limiter.check("k")

    # Raise the cap; the next check should succeed now that the
    # limit env var has changed (the limiter re-reads it on every
    # call when the constructor value is None).
    monkeypatch.setenv("EIDAN_WEBHOOK_RATE_LIMIT_PER_MINUTE", "10")
    await limiter.check("k")


# ---- HTTP integration test -----------------------------------------------


@pytest.mark.asyncio
async def test_webhook_route_returns_429_at_cap(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Drive the webhook route past the rate cap and verify the
    typed 429 envelope + Retry-After header."""
    import httpx
    from eidan_backend.http.auth import AuthMiddleware
    from eidan_backend.http.routes import router
    from fastapi import FastAPI

    monkeypatch.setenv("EIDAN_WEBHOOK_RATE_LIMIT_PER_MINUTE", "2")

    async def handler(event: TriggerEvent) -> BehaviourResult:
        return BehaviourResult(ok=True)

    registry = BehaviourRegistry()
    registry.register(
        Behaviour(
            id="probe:incoming",
            trigger=parse_trigger("webhook:incoming"),
            handler=handler,
        )
    )
    dispatcher = BehaviourDispatcher(registry, scheduler=AsyncIOScheduler())

    app = FastAPI()
    app.state.behaviour_dispatcher = dispatcher
    app.state.auth_public_pem = None
    app.add_middleware(AuthMiddleware)
    app.include_router(router)

    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(
        transport=transport, base_url="http://testserver"
    ) as client:
        ok1 = await client.post("/api/webhooks/probe/incoming", json={})
        ok2 = await client.post("/api/webhooks/probe/incoming", json={})
        rate_limited = await client.post(
            "/api/webhooks/probe/incoming", json={}
        )
        assert ok1.status_code == 200
        assert ok2.status_code == 200
        assert rate_limited.status_code == 429
        body = rate_limited.json()
        assert body["detail"]["code"] == "webhook.rate_limited"
        assert body["detail"]["retry_after_seconds"] >= 1
        assert "retry-after" in {k.lower() for k in rate_limited.headers.keys()}


@pytest.mark.asyncio
async def test_webhook_rate_limit_per_ip_isolation(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Different X-Forwarded-For headers get separate budgets."""
    import httpx
    from eidan_backend.http.auth import AuthMiddleware
    from eidan_backend.http.routes import router
    from fastapi import FastAPI

    monkeypatch.setenv("EIDAN_WEBHOOK_RATE_LIMIT_PER_MINUTE", "1")
    monkeypatch.setenv("EIDAN_WEBHOOK_TRUST_FORWARDED_FOR", "1")

    async def handler(event: TriggerEvent) -> BehaviourResult:
        return BehaviourResult(ok=True)

    registry = BehaviourRegistry()
    registry.register(
        Behaviour(
            id="probe:incoming",
            trigger=parse_trigger("webhook:incoming"),
            handler=handler,
        )
    )
    dispatcher = BehaviourDispatcher(registry, scheduler=AsyncIOScheduler())

    app = FastAPI()
    app.state.behaviour_dispatcher = dispatcher
    app.state.auth_public_pem = None
    app.add_middleware(AuthMiddleware)
    app.include_router(router)

    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(
        transport=transport, base_url="http://testserver"
    ) as client:
        # IP A gets one hit then blocked.
        r1 = await client.post(
            "/api/webhooks/probe/incoming",
            json={},
            headers={"X-Forwarded-For": "10.0.0.1"},
        )
        r2 = await client.post(
            "/api/webhooks/probe/incoming",
            json={},
            headers={"X-Forwarded-For": "10.0.0.1"},
        )
        # IP B starts fresh — separate budget.
        r3 = await client.post(
            "/api/webhooks/probe/incoming",
            json={},
            headers={"X-Forwarded-For": "10.0.0.2"},
        )
        assert r1.status_code == 200
        assert r2.status_code == 429
        assert r3.status_code == 200
