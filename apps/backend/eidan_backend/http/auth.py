"""Bearer-token authentication middleware (native, `docs/011 §11`).

Per ``docs/011 §4``, the middleware:

1. Generates / propagates a per-request trace id and pins it to
   ``request.state.request_id`` so error envelopes carry it.
2. Skips paths in :data:`UNAUTHENTICATED_PATHS` (publishable config,
   native auth surfaces, liveness, readiness, version) and
   :data:`UNAUTHENTICATED_PREFIXES` (plugin webhooks).
3. Extracts the bearer token from ``Authorization: Bearer <jwt>``.
4. Verifies it via the host-cached RS256 public key
   (``request.app.state.auth_public_pem``).
5. Stashes the resulting :class:`Identity` on ``request.state.identity``
   for downstream route handlers.

Failures map to the typed 401 / 403 envelope (``docs/011 §10.2``).
"""

from __future__ import annotations

import logging
import uuid

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import Response

from ..auth_native import InvalidToken, verify_access_token
from ..identity import Identity
from .errors import auth_error_response

logger = logging.getLogger(__name__)

# Inbound header an upstream proxy may set; we honour it instead of
# minting a fresh id so the trace id matches the proxy's logs.
_REQUEST_ID_HEADER = "x-request-id"

# Paths that bypass auth entirely (`docs/011 §4.2`). The native
# auth endpoints accept unauthenticated traffic by design — they
# either issue or exchange credentials, so requiring a credential
# to call them would be circular. The agent card is also public —
# remote A2A agents fetch it for discovery before sending requests.
UNAUTHENTICATED_PATHS: frozenset[str] = frozenset(
    {
        "/api/auth/config",
        "/api/auth/magic-link",
        "/api/auth/verify",
        "/api/auth/refresh",
        "/api/auth/logout",
        "/api/healthz",
        "/api/readyz",
        "/api/version",
        "/.well-known/agent-card.json",
    }
)

# Path prefixes that bypass auth. Plugin webhooks are called by
# external services (Stripe, GitHub, IMAP poll services, …) that do
# not hold an Eidan JWT; the plugin's own handler is responsible for
# verifying the inbound signature against its declared vault secret
# (`docs/001 §1.4`, `docs/012`).
UNAUTHENTICATED_PREFIXES: tuple[str, ...] = ("/api/webhooks/",)


def _extract_bearer(request: Request) -> str | None:
    header = request.headers.get("authorization")
    if not header:
        return None
    parts = header.split(" ", 1)
    if len(parts) != 2 or parts[0].lower() != "bearer":
        return None
    token = parts[1].strip()
    return token or None


class AuthMiddleware(BaseHTTPMiddleware):
    """Validates the per-request bearer token against the native
    RS256 public key.

    The public key is loaded once at startup by the bootstrap and
    cached on ``app.state.auth_public_pem``. A missing key is a
    configuration bug and surfaces as a 500 — we deliberately do
    not silently downgrade to "no auth required" if the key is
    absent.
    """

    async def dispatch(self, request: Request, call_next) -> Response:
        # Pin a trace id on every request. Honouring an inbound
        # ``X-Request-Id`` keeps the proxy's logs in step with ours; in
        # production an upstream reverse proxy usually sets one, in dev
        # we mint a fresh uuid4.
        incoming = request.headers.get(_REQUEST_ID_HEADER)
        request.state.request_id = incoming or str(uuid.uuid4())

        path = request.url.path
        if path in UNAUTHENTICATED_PATHS:
            response = await call_next(request)
            response.headers.setdefault(
                "X-Request-Id", request.state.request_id
            )
            return response
        if any(path.startswith(p) for p in UNAUTHENTICATED_PREFIXES):
            response = await call_next(request)
            response.headers.setdefault(
                "X-Request-Id", request.state.request_id
            )
            return response

        token = _extract_bearer(request)
        if token is None:
            return auth_error_response(
                request,
                code="auth.missing_token",
                message="Missing Authorization: Bearer <jwt> header.",
            )

        public_pem: bytes | None = getattr(
            request.app.state, "auth_public_pem", None
        )
        if public_pem is None:
            return auth_error_response(
                request,
                code="auth.invalid_signature",
                message="Auth verifier is not configured.",
            )

        try:
            native_identity = verify_access_token(token, public_pem=public_pem)
        except InvalidToken as exc:
            # Don't surface the verifier's exception text to the caller
            # (CodeQL: stack-trace exposure) — log it server-side, return a
            # generic message.
            logger.debug("access token verification failed: %s", exc)
            return auth_error_response(
                request,
                code="auth.invalid_signature",
                message="invalid token",
            )

        # Adapt :class:`NativeIdentity` → :class:`Identity` so the
        # downstream code (loop, persistence, plugins) reads the
        # same shape it always has. ``aal`` defaults to ``aal1`` —
        # we'll bump it to ``aal2`` after the MFA scaffold lights up.
        # ``iat`` lands in raw_claims so /api/cost/summary's session
        # scope can window against the JWT's issuance time.
        identity = Identity(
            user_id=native_identity.user_id,
            email=native_identity.email,
            session_id=native_identity.session_id,
            aal="aal1",
            raw_claims={
                "sub": native_identity.user_id,
                "email": native_identity.email,
                "sid": native_identity.session_id,
                "iat": int(native_identity.issued_at.timestamp()),
                "exp": int(native_identity.expires_at.timestamp()),
            },
        )

        request.state.identity = identity
        response = await call_next(request)
        # Echo the trace id back to the caller so the UI can show it
        # alongside any human-reported error. Use setdefault so a route
        # handler that sets its own id (rare) wins.
        response.headers.setdefault(
            "X-Request-Id", request.state.request_id
        )
        return response
