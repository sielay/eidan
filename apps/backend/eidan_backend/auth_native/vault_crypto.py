# SPDX-License-Identifier: AGPL-3.0-or-later
"""At-rest encryption for native auth state (`docs/011 §12`).

Eidan's native auth keeps three things encrypted in Postgres:

1. The RS256 private key (``eidan.auth_keypair.private_pem_enc``).
2. TOTP secrets (``eidan.auth_mfa_totp.secret_enc``).
3. Plugin secrets (``eidan.secrets_vault.value_enc``), replacing the
   Supabase Vault tier in :mod:`eidan_backend.secrets`.

The encryption primitive is :class:`cryptography.fernet.Fernet`
(AES-128-CBC + HMAC-SHA256, urlsafe-base64 envelope). The key is
derived from the operator-set ``EIDAN_AUTH_MASTER_KEY`` env var
via HKDF-SHA256 with a fixed application-bound salt so the same
passphrase always yields the same key (idempotent across restarts
and across instances in a multi-node deployment).

Why HKDF rather than PBKDF2: HKDF is the correct primitive for
deriving symmetric keys from already-uniformly-distributed key
material. We're not stretching a password into a key (PBKDF2's job);
we're deriving a domain-bound key from a high-entropy secret. HKDF
also doesn't have a configurable iteration count, which removes one
class of operator footgun.

The salt is fixed (and public) by design. Salts protect against
rainbow-table attacks on weak passwords; HKDF doesn't rely on it
for entropy.
"""

from __future__ import annotations

import os
from base64 import urlsafe_b64encode

from cryptography.fernet import Fernet
from cryptography.fernet import InvalidToken as FernetInvalidToken
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

# Fixed application-bound salt. Public; documented in docs/011.
_HKDF_SALT = b"eidan-auth-master-key/v1"
_HKDF_INFO = b"eidan vault encryption"


class MasterKeyMissing(RuntimeError):
    """Raised when an encrypt/decrypt is attempted without the master
    key configured.

    The host validates this at boot — the auth subsystem should never
    encounter it at runtime — but having a typed error makes the
    failure mode obvious if a future code path forgets to check.
    """


def master_key_configured() -> bool:
    """Cheap probe used by bootstrap / doctor to surface a clear
    "set EIDAN_AUTH_MASTER_KEY" error rather than crashing inside an
    encrypt call.
    """
    return bool(os.environ.get("EIDAN_AUTH_MASTER_KEY"))


def _derive_fernet_key() -> bytes:
    """Derive a 32-byte Fernet key from ``EIDAN_AUTH_MASTER_KEY``.

    Fernet expects a urlsafe-base64-encoded 32-byte key (44 chars
    with padding). We HKDF-derive 32 raw bytes and base64-encode
    them on the way out so callers get a value ``Fernet(...)``
    accepts directly.
    """
    raw = os.environ.get("EIDAN_AUTH_MASTER_KEY")
    if not raw:
        raise MasterKeyMissing(
            "EIDAN_AUTH_MASTER_KEY is not set. Generate one with "
            "`python -c 'import secrets; print(secrets.token_urlsafe(48))'` "
            "and add it to .env. See docs/011 §12 for rotation guidance."
        )
    kdf = HKDF(
        algorithm=hashes.SHA256(),
        length=32,
        salt=_HKDF_SALT,
        info=_HKDF_INFO,
    )
    derived = kdf.derive(raw.encode("utf-8"))
    return urlsafe_b64encode(derived)


def encrypt_value(plaintext: bytes) -> bytes:
    """Seal ``plaintext`` with the master-derived Fernet key.

    Returns the raw Fernet token (still urlsafe-base64 internally; the
    bytes are stored in ``bytea`` columns as-is). Use
    :func:`decrypt_value` to reverse.

    The caller passes bytes so binary payloads (RSA private key DER /
    PEM, TOTP secret) round-trip cleanly without UTF-8 assumptions.
    Plaintext strings should be ``.encode("utf-8")``'d at the call
    site.
    """
    key = _derive_fernet_key()
    return Fernet(key).encrypt(plaintext)


def decrypt_value(ciphertext: bytes) -> bytes:
    """Reverse of :func:`encrypt_value`.

    Raises :class:`cryptography.fernet.InvalidToken` on tamper /
    wrong key / corrupted bytes. Callers should let this propagate —
    a silent fallback to plaintext would be a footgun.
    """
    key = _derive_fernet_key()
    return Fernet(key).decrypt(ciphertext)


__all__ = [
    "FernetInvalidToken",
    "MasterKeyMissing",
    "decrypt_value",
    "encrypt_value",
    "master_key_configured",
]
