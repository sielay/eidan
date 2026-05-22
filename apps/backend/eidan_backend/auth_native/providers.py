# SPDX-License-Identifier: AGPL-3.0-or-later
"""Pluggable auth provider interface (`docs/011 §19`).

Magic-link is the only provider Eidan ships today. OAuth (Google,
GitHub) and SSO (SAML, OIDC) belong in the paid baseline bundle
that handles multi-user installs; the protocol below pins their
shape so adding one is a drop-in.

This module is interface-only — no concrete OAuth flow lives in
core. The magic-link "provider" is a thin wrapper around
:func:`eidan_backend.auth_native.magic_link.issue_magic_link` /
``consume_magic_link`` so the existing routes keep their direct
imports; the protocol just gives future providers a place to slot
in.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Protocol, runtime_checkable


@dataclass(frozen=True, slots=True)
class InitiateResult:
    """Returned from :meth:`AuthProvider.initiate`.

    For magic-link providers ``next_action`` is ``"await_verify"``
    and the operator clicks an email link / pastes a code. For
    OAuth providers ``next_action`` is ``"redirect"`` and the UI
    bounces to ``redirect_url``.
    """

    next_action: str  # "await_verify" | "redirect"
    redirect_url: str | None = None
    # Free-form per-provider hints (e.g. nonce, state token, dev
    # echo of the magic link). Surface contract per provider.
    metadata: dict[str, Any] | None = None


@dataclass(frozen=True, slots=True)
class VerifyResult:
    """Returned from :meth:`AuthProvider.verify`.

    On success the route handler upserts the user row + mints the
    JWT pair. ``email`` is the trusted identity claim coming out
    of the provider; the host's allow-list gate runs *before* the
    JWT mint, not here.
    """

    email: str
    # Provider-specific raw response for audit logs.
    raw: dict[str, Any] | None = None


@runtime_checkable
class AuthProvider(Protocol):
    """The seam every new auth provider implements.

    Two methods. ``initiate`` kicks off the flow (sends an email
    for magic-link, returns a redirect URL for OAuth). ``verify``
    finishes it (consumes the magic-link token, or exchanges the
    OAuth code).

    Providers are stateless w.r.t. the host: the host owns the DB
    pool and passes ``conn`` in. Provider implementations only
    care about their own protocol shape (SMTP, OAuth endpoints,
    etc.).
    """

    # Stable slug used in /api/auth/config's ``providers`` list +
    # in the request URL (``/api/auth/oauth/<name>/callback``).
    name: str

    async def initiate(self, conn: Any, **kwargs: Any) -> InitiateResult:
        """Start a login attempt. The kwargs are provider-specific
        (``email=`` for magic-link, ``redirect_to=`` for OAuth)."""
        ...

    async def verify(self, conn: Any, **kwargs: Any) -> VerifyResult:
        """Complete a login attempt. The kwargs are provider-specific
        (``token=`` / ``code=`` for magic-link, ``code=``/``state=``
        for OAuth)."""
        ...


class NotConfigured(Exception):
    """Raised when a provider is requested but isn't enabled.

    The route handler maps this to a 503 so the UI can degrade
    gracefully (hide the button + show "this login method isn't
    configured on this server").
    """


__all__ = [
    "AuthProvider",
    "InitiateResult",
    "NotConfigured",
    "VerifyResult",
]
