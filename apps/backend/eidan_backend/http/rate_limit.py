"""In-process rate limiter for webhook ingress (audit §5 fix 3/3).

``/api/webhooks/<plugin>/<slug>`` is the only public path that
accepts unauthenticated POSTs (third parties — Stripe, GitHub,
calendars — don't hold an Eidan JWT). Without a rate limit it's
a free dispatch endpoint; a misbehaving / malicious caller can
fan out behaviour invocations until the host's costs blow.

The limiter is **in-process** — single sliding window, no Redis.
That's right for the single-instance default; multi-instance
deployments either:

- run behind a reverse proxy that already rate-limits (Cloudflare /
  Caddy / nginx — the recommended posture), or
- accept that each instance has its own counters (the effective
  per-key budget is ``per_instance_rate × instance_count``).

Keyed on ``(plugin, slug, client_ip)``. The client IP comes from
``X-Forwarded-For`` when an upstream proxy sets it, otherwise from
the raw socket; an operator that doesn't trust the inbound header
sets ``EIDAN_WEBHOOK_TRUST_FORWARDED_FOR=0``.

Configuration:

- ``EIDAN_WEBHOOK_RATE_LIMIT_PER_MINUTE`` — calls per minute per
  (plugin, slug, ip). Default 60. Set to 0 to disable.
- ``EIDAN_WEBHOOK_TRUST_FORWARDED_FOR`` — accept X-Forwarded-For
  as the client IP. Default 1 (operators usually run behind a
  proxy).
"""

from __future__ import annotations

import asyncio
import os
import time
from collections import deque
from typing import Any

from starlette.requests import Request

# Default cap — operator can override via env. 60/min per
# (plugin, slug, ip) is loose enough that any legitimate webhook
# source (Stripe sends one event per state change) stays well
# under, but tight enough that a misconfigured retry loop trips it.
_DEFAULT_LIMIT_PER_MINUTE = 60
_WINDOW_SECONDS = 60.0


def _limit_per_minute() -> int:
    raw = os.environ.get("EIDAN_WEBHOOK_RATE_LIMIT_PER_MINUTE")
    if raw is None:
        return _DEFAULT_LIMIT_PER_MINUTE
    try:
        return max(int(raw), 0)
    except ValueError:
        return _DEFAULT_LIMIT_PER_MINUTE


def _trust_forwarded_for() -> bool:
    return os.environ.get("EIDAN_WEBHOOK_TRUST_FORWARDED_FOR", "1") not in (
        "0",
        "false",
        "no",
    )


def extract_client_ip(request: Request) -> str:
    """Pick the best-effort caller IP. Honour X-Forwarded-For only
    when the operator opts in; otherwise read the raw socket
    address. Returns ``"unknown"`` for the case where neither is
    available (uvicorn over a unix socket, some test ASGI clients).
    """
    if _trust_forwarded_for():
        forwarded = request.headers.get("x-forwarded-for")
        if forwarded:
            # First entry is the leftmost (origin); subsequent entries
            # are added by intermediate proxies. We trust the first.
            return forwarded.split(",", 1)[0].strip() or "unknown"
    client = request.client
    if client is not None and client.host:
        return client.host
    return "unknown"


class RateLimitExceeded(Exception):
    """Raised when a rate-limited key exceeds its budget.

    Carries the ``retry_after`` seconds so the route handler can
    populate the ``Retry-After`` header and the typed envelope's
    detail field.
    """

    def __init__(self, *, key: str, retry_after: int) -> None:
        super().__init__(f"rate limit exceeded for {key}; retry after {retry_after}s")
        self.key = key
        self.retry_after = retry_after


class WebhookRateLimiter:
    """Sliding-window in-process rate limiter.

    One ``deque`` of monotonic timestamps per key. ``check`` evicts
    timestamps older than the window, then either appends and
    returns or raises :class:`RateLimitExceeded`. Memory is bounded
    by the window — eviction keeps the deque length <= the limit.

    Concurrent calls against the same key are serialised behind a
    per-key ``asyncio.Lock`` so a thundering herd against one
    webhook doesn't double-count timestamps.
    """

    def __init__(
        self,
        *,
        limit_per_minute: int | None = None,
        window_seconds: float = _WINDOW_SECONDS,
    ) -> None:
        self._limit = limit_per_minute
        self._window = window_seconds
        self._counters: dict[str, deque[float]] = {}
        self._locks: dict[str, asyncio.Lock] = {}

    @property
    def limit_per_minute(self) -> int:
        # Late-bind so a test that monkeypatches the env between
        # construction and check sees the new value. The cost of one
        # env-var read per webhook is negligible.
        return self._limit if self._limit is not None else _limit_per_minute()

    async def check(self, key: str) -> None:
        """Record one hit for ``key`` and raise if it crosses the
        limit. ``key`` is opaque; the route picks the shape — typically
        ``f"{plugin}:{slug}:{ip}"``."""
        limit = self.limit_per_minute
        if limit <= 0:
            return  # disabled

        lock = self._locks.setdefault(key, asyncio.Lock())
        async with lock:
            now = time.monotonic()
            window = self._counters.setdefault(key, deque())
            cutoff = now - self._window
            while window and window[0] < cutoff:
                window.popleft()
            if len(window) >= limit:
                # The oldest timestamp in the window dictates when
                # one slot frees up. Round up so the operator sees an
                # integer retry-after.
                retry_after = max(int(window[0] + self._window - now), 1)
                raise RateLimitExceeded(key=key, retry_after=retry_after)
            window.append(now)


def get_or_create_limiter(app_state: Any) -> WebhookRateLimiter:
    """Lazy-init the limiter on the app state.

    The HTTP app factory doesn't construct it eagerly so tests can
    monkeypatch the env var before first use. Production fetches the
    same instance on every request via ``app.state``.
    """
    existing = getattr(app_state, "webhook_rate_limiter", None)
    if isinstance(existing, WebhookRateLimiter):
        return existing
    limiter = WebhookRateLimiter()
    app_state.webhook_rate_limiter = limiter
    return limiter


__all__ = [
    "RateLimitExceeded",
    "WebhookRateLimiter",
    "extract_client_ip",
    "get_or_create_limiter",
]
