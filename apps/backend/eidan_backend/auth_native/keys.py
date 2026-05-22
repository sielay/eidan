# SPDX-License-Identifier: AGPL-3.0-or-later
"""RS256 keypair storage for native JWT signing (`docs/011 §11`).

The host needs a stable RSA keypair to sign access tokens (private
key) and to verify them from any process — backend, future MCP
clients, webhook receivers — without each instance generating its
own (and thus failing cross-node JWT verification).

Storage shape:

    eidan.auth_keypair (
      id              text PRIMARY KEY,     -- 'current' today
      private_pem_enc bytea NOT NULL,       -- encrypted with master key
      public_pem      text  NOT NULL,       -- plaintext (it's public)
      created_at      timestamptz
    )

``id`` is a stable label rather than a uuid so future rotation can
introduce a second row (``'current'`` + ``'next'``) while issued
access tokens drain. Today we only ever read ``'current'``.

The first call to :func:`ensure_keypair` against a fresh database
generates a 4096-bit RSA key, encrypts the private half with the
master vault key, and writes the row. Subsequent calls are no-ops.
Rotation = ``DELETE FROM eidan.auth_keypair`` + restart (the next
``ensure_keypair`` re-mints).
"""

from __future__ import annotations

import logging
from typing import Any

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa

from .vault_crypto import decrypt_value, encrypt_value

logger = logging.getLogger(__name__)

_RSA_KEY_SIZE = 4096
_PUBLIC_EXPONENT = 65537
_CURRENT_KEY_ID = "current"


class KeypairUnavailable(RuntimeError):
    """The keypair couldn't be loaded.

    Most common cause: the database row exists but the master key
    has changed since it was written, so decryption fails. Operator
    fix per ``docs/011 §12.3``: ``DELETE FROM eidan.auth_keypair`` to
    force regeneration on next boot.
    """


def _generate_keypair_pems() -> tuple[bytes, bytes]:
    """Mint a new 4096-bit RSA keypair, returning (private_pem, public_pem).

    Kept private to this module — callers should reach for
    :func:`ensure_keypair` which handles persistence.
    """
    private_key = rsa.generate_private_key(
        public_exponent=_PUBLIC_EXPONENT,
        key_size=_RSA_KEY_SIZE,
    )
    private_pem = private_key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    )
    public_pem = private_key.public_key().public_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PublicFormat.SubjectPublicKeyInfo,
    )
    return private_pem, public_pem


async def ensure_keypair(conn: Any) -> tuple[bytes, bytes]:
    """Idempotent load-or-generate of the signing keypair.

    Returns ``(private_pem, public_pem)``. First call against an
    empty table generates + persists; subsequent calls read the row.

    ``conn`` is an ``asyncpg.Connection`` (typed as ``Any`` so the
    module doesn't pull asyncpg into the type checker — that import
    is a host concern).

    Concurrency: two instances starting simultaneously could both
    decide the row is missing. The INSERT uses ``ON CONFLICT DO
    NOTHING`` so the loser's row is dropped and both ends read the
    winner via the follow-up SELECT — safe across multi-instance
    cold-start.
    """
    row = await conn.fetchrow(
        """
        SELECT private_pem_enc, public_pem
        FROM eidan.auth_keypair
        WHERE id = $1
        """,
        _CURRENT_KEY_ID,
    )
    if row is None:
        logger.info("[auth-native] minting fresh RS256 keypair (first start)")
        private_pem, public_pem = _generate_keypair_pems()
        private_enc = encrypt_value(private_pem)
        await conn.execute(
            """
            INSERT INTO eidan.auth_keypair
                (id, private_pem_enc, public_pem)
            VALUES ($1, $2, $3)
            ON CONFLICT (id) DO NOTHING
            """,
            _CURRENT_KEY_ID,
            private_enc,
            public_pem.decode("ascii"),
        )
        # Re-read to handle the ON CONFLICT case (a concurrent peer
        # inserted first; our row was dropped). Both ends end up with
        # the same authoritative keypair.
        row = await conn.fetchrow(
            """
            SELECT private_pem_enc, public_pem
            FROM eidan.auth_keypair
            WHERE id = $1
            """,
            _CURRENT_KEY_ID,
        )
        assert row is not None, "auth_keypair row missing after insert"

    try:
        private_pem = decrypt_value(bytes(row["private_pem_enc"]))
    except Exception as exc:  # noqa: BLE001 — wrap with operator-actionable text
        raise KeypairUnavailable(
            "Could not decrypt eidan.auth_keypair. The most common "
            "cause is EIDAN_AUTH_MASTER_KEY changing since the row was "
            "written. To recover, delete the row and restart so a "
            "fresh keypair is minted: "
            "DELETE FROM eidan.auth_keypair WHERE id = 'current';"
        ) from exc
    public_pem = row["public_pem"].encode("ascii")
    return private_pem, public_pem


async def load_public_pem(conn: Any) -> bytes:
    """Read just the public half (no decryption needed).

    Used by verifier-only code paths (a hypothetical webhook
    receiver, an external MCP client) that should not be able to
    sign — only verify.
    """
    row = await conn.fetchrow(
        """
        SELECT public_pem
        FROM eidan.auth_keypair
        WHERE id = $1
        """,
        _CURRENT_KEY_ID,
    )
    if row is None:
        raise KeypairUnavailable(
            "eidan.auth_keypair has no current key yet. The backend "
            "mints one on first start — restart the host once "
            "EIDAN_AUTH_MASTER_KEY is set."
        )
    return row["public_pem"].encode("ascii")


__all__ = [
    "KeypairUnavailable",
    "ensure_keypair",
    "load_public_pem",
]
