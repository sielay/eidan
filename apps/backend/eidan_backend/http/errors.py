"""Error envelope used by the HTTP surface.

The wire shape comes from ``docs/011 §10.1``: a single ``error`` object
with ``code``, ``message``, and an optional ``details`` payload. The
``code`` belongs to the closed set in ``docs/011 §10.2`` and is stable
across minor versions.

Auth-side errors (``auth.*``) are mapped here from
:class:`eidan_backend.identity.AuthError`; the route handlers do not
need to know the mapping.
"""

from __future__ import annotations

from fastapi import Request
from fastapi.responses import JSONResponse

# Codes that mean "we did not recognise you" (HTTP 401).
_AUTH_401_CODES: frozenset[str] = frozenset(
    {
        "auth.missing_token",
        "auth.malformed_token",
        "auth.invalid_signature",
        "auth.token_expired",
        "auth.invalid_claims",
        "auth.unknown_kid",
    }
)

# Codes that mean "we recognised you, the answer is no" (HTTP 403).
_AUTH_403_CODES: frozenset[str] = frozenset(
    {
        "auth.wrong_audience",
        "auth.user_disabled",
        "auth.plugin_scope_denied",
    }
)


def auth_status_for(code: str) -> int:
    if code in _AUTH_403_CODES:
        return 403
    return 401


def error_payload(
    code: str,
    message: str,
    *,
    details: dict | None = None,
    request_id: str | None = None,
) -> dict:
    """Build the wire-shape error envelope from `docs/011 §10.1`.

    ``request_id`` lands when the middleware has populated
    ``request.state.request_id`` (every authenticated request does so;
    public paths like ``/api/auth/config`` may not).
    """
    inner: dict = {"code": code, "message": message}
    if request_id is not None:
        inner["request_id"] = request_id
    if details is not None:
        inner["details"] = details
    return {"error": inner}


def auth_error_response(
    request: Request,
    *,
    code: str,
    message: str,
    details: dict | None = None,
) -> JSONResponse:
    """Build the canonical 401/403 response for an auth failure."""
    status = auth_status_for(code)
    headers: dict[str, str] = {}
    if status == 401:
        rfc6750_error = code.split(".", 1)[-1]
        headers["WWW-Authenticate"] = (
            f'Bearer realm="eidan", error="{rfc6750_error}"'
        )
    request_id = getattr(request.state, "request_id", None)
    if isinstance(request_id, str):
        headers["X-Request-Id"] = request_id
    return JSONResponse(
        status_code=status,
        content=error_payload(
            code, message, details=details, request_id=request_id
        ),
        headers=headers,
    )
