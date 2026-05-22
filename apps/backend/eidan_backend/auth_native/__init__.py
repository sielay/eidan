# SPDX-License-Identifier: AGPL-3.0-or-later
"""Native auth subsystem (replaces Supabase Auth + Vault).

Pinned in ``docs/011``. The module is split into focused submodules:

- :mod:`.vault_crypto` — at-rest encryption helpers built on the
  operator-provided ``EIDAN_AUTH_MASTER_KEY``.
- :mod:`.keys`         — RS256 keypair load-or-generate, persisted in
  ``eidan.auth_keypair`` so multi-instance deployments share one
  signer/verifier pair.
- :mod:`.jwt_native`   — issue + verify access JWTs (RS256), mint
  refresh tokens (opaque, server-side revocable).

Nothing in here is host-aware: the host pulls these primitives into
the FastAPI middleware (``auth.AuthMiddleware``) and the CLI's
``eidan login`` flow once the endpoints land.
"""

from __future__ import annotations

from .jwt_native import (
    InvalidToken,
    NativeIdentity,
    issue_access_token,
    mint_refresh_token,
    verify_access_token,
)
from .keys import KeypairUnavailable, ensure_keypair, load_public_pem
from .vault_crypto import (
    MasterKeyMissing,
    decrypt_value,
    encrypt_value,
    master_key_configured,
)

__all__ = [
    "InvalidToken",
    "KeypairUnavailable",
    "MasterKeyMissing",
    "NativeIdentity",
    "decrypt_value",
    "encrypt_value",
    "ensure_keypair",
    "issue_access_token",
    "load_public_pem",
    "master_key_configured",
    "mint_refresh_token",
    "verify_access_token",
]
