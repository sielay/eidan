"""Tests for SecurityHeadersMiddleware (audit §5 fix).

The middleware adds CSP / HSTS / X-Frame / X-Content-Type /
Referrer-Policy / Permissions-Policy headers on every response.
Operators can override per-header via env vars; an empty override
disables that one header. Upstream-set values win (setdefault).

These tests stand up a minimal Starlette app — the middleware is
JSON-shape-agnostic so a tiny test app is enough to verify the
header pipeline.
"""

from __future__ import annotations

import pytest
from eidan_backend.http.security_headers import SecurityHeadersMiddleware
from fastapi import FastAPI


def _build_test_app() -> FastAPI:
    app = FastAPI()
    app.add_middleware(SecurityHeadersMiddleware)

    @app.get("/probe")
    async def probe() -> dict:
        return {"ok": True}

    @app.get("/already-set")
    async def already_set():
        from fastapi.responses import JSONResponse

        return JSONResponse(
            {"ok": True},
            headers={
                "Content-Security-Policy": "default-src 'self'",
            },
        )

    return app


@pytest.mark.asyncio
async def test_default_headers_land_on_every_response() -> None:
    import httpx

    app = _build_test_app()
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(
        transport=transport, base_url="http://testserver"
    ) as client:
        resp = await client.get("/probe")
    assert resp.status_code == 200
    assert "max-age=31536000" in resp.headers["strict-transport-security"]
    assert "frame-ancestors 'none'" in resp.headers["content-security-policy"]
    assert resp.headers["x-frame-options"] == "DENY"
    assert resp.headers["x-content-type-options"] == "nosniff"
    assert resp.headers["referrer-policy"] == "no-referrer"
    assert "geolocation=()" in resp.headers["permissions-policy"]


@pytest.mark.asyncio
async def test_route_supplied_header_wins_over_default() -> None:
    """A route handler that sets ``Content-Security-Policy`` itself
    keeps its value — the middleware uses setdefault."""
    import httpx

    app = _build_test_app()
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(
        transport=transport, base_url="http://testserver"
    ) as client:
        resp = await client.get("/already-set")
    assert resp.headers["content-security-policy"] == "default-src 'self'"


@pytest.mark.asyncio
async def test_env_override_replaces_default(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("EIDAN_HTTP_CSP", "default-src 'self' https://api.example.test")
    import httpx

    app = _build_test_app()
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(
        transport=transport, base_url="http://testserver"
    ) as client:
        resp = await client.get("/probe")
    assert (
        resp.headers["content-security-policy"]
        == "default-src 'self' https://api.example.test"
    )


@pytest.mark.asyncio
async def test_empty_env_override_omits_the_header(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Setting the env var to empty / whitespace disables that
    header. Useful when an upstream reverse proxy is the single
    source of truth and the backend should stay out of its way."""
    monkeypatch.setenv("EIDAN_HTTP_REFERRER_POLICY", "")
    import httpx

    app = _build_test_app()
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(
        transport=transport, base_url="http://testserver"
    ) as client:
        resp = await client.get("/probe")
    assert "referrer-policy" not in {h.lower() for h in resp.headers.keys()}
