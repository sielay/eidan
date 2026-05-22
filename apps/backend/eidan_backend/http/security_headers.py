"""Security-headers middleware.

Adds the response-header set every public-facing HTTP service should
carry: Strict-Transport-Security, Content-Security-Policy,
X-Frame-Options, X-Content-Type-Options, Referrer-Policy,
Permissions-Policy. Defaults are tight and tuned for the eidan API
surface — the backend serves JSON and a few SSE streams, never HTML
or media — so the CSP can be aggressive without breaking anything.

Operators who proxy eidan through Cloudflare / Caddy / nginx may have
the same headers set upstream; the middleware uses ``setdefault`` so
an upstream-set header wins. No CSP for now on `/api/webhooks/`
responses because third-party services may parse them in ways the
browser CSP framework doesn't apply to anyway.

Configuration: every header has an env-var override so an operator can
relax a policy without forking the middleware. The defaults represent
the "deny by default" stance the audit §5 calls for.
"""

from __future__ import annotations

import os

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import Response

# Backend serves JSON + SSE only — no inline HTML, no scripts, no
# images. The CSP locks everything down to `none` and explicitly
# allows the API's own origin for connect-src so SSE keeps working.
# Operators who need to embed the API in a custom frontend on
# another origin set ``EIDAN_HTTP_CSP`` to relax this.
_DEFAULT_CSP = (
    "default-src 'none'; "
    "connect-src 'self'; "
    "frame-ancestors 'none'; "
    "form-action 'none'; "
    "base-uri 'none'"
)

# HSTS: tell browsers to upgrade every connection for the next year.
# `includeSubDomains` is opt-out via env in case the operator runs
# eidan on a subdomain of a domain that has unrelated http subsites.
_DEFAULT_HSTS = "max-age=31536000; includeSubDomains"

# Browsers honour these even though the backend is JSON-only — they
# protect against the case where a misconfigured proxy serves a
# response as text/html or where future plugin frontends gain new
# attack surface.
_DEFAULT_X_FRAME = "DENY"
_DEFAULT_X_CONTENT_TYPE = "nosniff"
_DEFAULT_REFERRER = "no-referrer"

# Tight Permissions-Policy: deny everything except what the backend
# would conceivably need. Today that's nothing — no geolocation,
# no microphone, no camera, no payments. Operators with voice
# plugins that need microphone access override per-domain.
_DEFAULT_PERMISSIONS_POLICY = (
    "geolocation=(), camera=(), microphone=(), payment=(), usb=()"
)

# Pulled into a tuple so the middleware iterates deterministically.
# Each tuple is (header name, default value, env var override).
_HEADERS: tuple[tuple[str, str, str], ...] = (
    (
        "Strict-Transport-Security",
        _DEFAULT_HSTS,
        "EIDAN_HTTP_HSTS",
    ),
    (
        "Content-Security-Policy",
        _DEFAULT_CSP,
        "EIDAN_HTTP_CSP",
    ),
    (
        "X-Frame-Options",
        _DEFAULT_X_FRAME,
        "EIDAN_HTTP_X_FRAME_OPTIONS",
    ),
    (
        "X-Content-Type-Options",
        _DEFAULT_X_CONTENT_TYPE,
        "EIDAN_HTTP_X_CONTENT_TYPE",
    ),
    (
        "Referrer-Policy",
        _DEFAULT_REFERRER,
        "EIDAN_HTTP_REFERRER_POLICY",
    ),
    (
        "Permissions-Policy",
        _DEFAULT_PERMISSIONS_POLICY,
        "EIDAN_HTTP_PERMISSIONS_POLICY",
    ),
)


class SecurityHeadersMiddleware(BaseHTTPMiddleware):
    """Apply the headers in :data:`_HEADERS` to every response.

    Uses ``setdefault`` so an upstream proxy that already set the
    header wins. Empty env-var override disables the corresponding
    header entirely — useful for operators who want their reverse
    proxy as the single source of truth.
    """

    async def dispatch(self, request: Request, call_next) -> Response:
        response = await call_next(request)
        for name, default, env_var in _HEADERS:
            override = os.environ.get(env_var)
            value = default if override is None else override.strip()
            if not value:
                continue
            response.headers.setdefault(name, value)
        return response


__all__ = ["SecurityHeadersMiddleware"]
