# SPDX-License-Identifier: AGPL-3.0-or-later
"""init native auth + secrets vault

Revision ID: 20260521000001
Revises: 20260520000001
Create Date: 2026-05-21

Removes Eidan's dependency on Supabase by standing up the storage
backing for native auth (magic-link sessions, refresh-token
revocation, TOTP scaffold) plus an in-Postgres replacement for the
Supabase Vault that the secrets layer previously fell back to.

All cryptographic state lives in Postgres so multi-instance
deployments share it (the alternative — keys/secrets on a local
filesystem — would have meant every node generating its own
keypair, which would break cross-node JWT verification). The
encryption key for at-rest values is the operator's
``EIDAN_AUTH_MASTER_KEY`` env var (see ``docs/011``).

Tables created:

- ``eidan.auth_sessions`` — refresh tokens (revocable).
- ``eidan.auth_magic_links`` — outstanding email login links + codes.
- ``eidan.auth_mfa_totp`` — operator's TOTP secret, encrypted.
- ``eidan.auth_keypair`` — RS256 keypair singleton, encrypted.
- ``eidan.secrets_vault`` — generic encrypted secrets (replaces the
  Supabase Vault tier in ``eidan_backend.secrets``).

``eidan.users`` is left untouched; it remains the canonical user
identity. Today the operator pin (``EIDAN_AUTH_ALLOWED_EMAIL``)
restricts inserts to exactly one row.
"""
from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "20260521000001"
down_revision: str | None = "20260520000001"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # ---- auth_sessions -----------------------------------------------------
    # One row per active refresh token. Access JWTs are stateless and
    # self-verify off the public key in eidan.auth_keypair; refresh
    # tokens are server-side so logout / revoke is possible.
    op.create_table(
        "auth_sessions",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column(
            "user_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("eidan.users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        # Hash, never the raw token — same posture as password storage:
        # a DB read can't be replayed as a refresh.
        sa.Column("refresh_token_hash", sa.Text(), nullable=False, unique=True),
        sa.Column(
            "expires_at",
            postgresql.TIMESTAMP(timezone=True),
            nullable=False,
        ),
        # Set when the operator hits /api/auth/logout (or a session
        # cleanup job nukes expired rows).
        sa.Column(
            "revoked_at",
            postgresql.TIMESTAMP(timezone=True),
            nullable=True,
        ),
        # Soft audit fields for the operator's "active sessions" view.
        sa.Column("user_agent", sa.Text(), nullable=True),
        sa.Column("ip_address", postgresql.INET, nullable=True),
        sa.Column(
            "created_at",
            postgresql.TIMESTAMP(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.Column(
            "last_used_at",
            postgresql.TIMESTAMP(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        schema="eidan",
    )
    op.create_index(
        "idx_auth_sessions_user_active",
        "auth_sessions",
        ["user_id", sa.text("expires_at DESC")],
        schema="eidan",
        postgresql_where=sa.text("revoked_at IS NULL"),
    )

    # ---- auth_magic_links --------------------------------------------------
    # Issued at /api/auth/magic-link; consumed at /api/auth/verify.
    # 15-minute TTL pinned by the loop (see auth_native.magic_link).
    op.create_table(
        "auth_magic_links",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column("email", sa.Text(), nullable=False),
        # Same hashing posture as auth_sessions. The raw token lands in
        # the magic-link URL emailed to the operator.
        sa.Column("token_hash", sa.Text(), nullable=False, unique=True),
        # Short numeric code (6 digits) the operator can paste back in
        # if they can't click the email's URL (mobile mail clients
        # that mangle links, etc.).
        sa.Column("code", sa.Text(), nullable=False),
        sa.Column(
            "expires_at",
            postgresql.TIMESTAMP(timezone=True),
            nullable=False,
        ),
        sa.Column(
            "consumed_at",
            postgresql.TIMESTAMP(timezone=True),
            nullable=True,
        ),
        sa.Column(
            "created_at",
            postgresql.TIMESTAMP(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        schema="eidan",
    )
    # Read path: "is this token still pending?" Partial index on the
    # unconsumed window keeps it cheap. We can't include
    # ``expires_at > now()`` in the predicate — Postgres rejects
    # non-IMMUTABLE functions in index predicates. The consume path
    # filters on expiry at query time; the index just narrows the
    # already-small set of rows where ``consumed_at IS NULL``.
    op.create_index(
        "idx_auth_magic_links_pending",
        "auth_magic_links",
        ["token_hash"],
        schema="eidan",
        postgresql_where=sa.text("consumed_at IS NULL"),
    )

    # ---- auth_mfa_totp -----------------------------------------------------
    # One row per user that has TOTP enabled. The secret itself is
    # encrypted at rest with EIDAN_AUTH_MASTER_KEY (libsodium SecretBox)
    # so a DB dump alone doesn't compromise it.
    op.create_table(
        "auth_mfa_totp",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column(
            "user_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("eidan.users.id", ondelete="CASCADE"),
            nullable=False,
            unique=True,
        ),
        sa.Column("secret_enc", postgresql.BYTEA, nullable=False),
        # ``verified_at`` stays NULL during enrolment until the operator
        # confirms the first code from their authenticator app.
        sa.Column(
            "verified_at",
            postgresql.TIMESTAMP(timezone=True),
            nullable=True,
        ),
        sa.Column(
            "created_at",
            postgresql.TIMESTAMP(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        schema="eidan",
    )

    # ---- auth_keypair ------------------------------------------------------
    # Singleton-ish: ``id`` is a stable label (default 'current') so a
    # future rotation can keep the old row around for a grace window
    # while issued access tokens drain. The private PEM is encrypted
    # at rest; the public PEM stays plaintext so any consumer (a
    # future external MCP client, a webhook receiver) can verify
    # signatures off a SELECT alone.
    op.create_table(
        "auth_keypair",
        sa.Column("id", sa.Text(), primary_key=True),
        sa.Column("private_pem_enc", postgresql.BYTEA, nullable=False),
        sa.Column("public_pem", sa.Text(), nullable=False),
        sa.Column(
            "created_at",
            postgresql.TIMESTAMP(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        schema="eidan",
    )

    # ---- secrets_vault -----------------------------------------------------
    # Replaces the Supabase Vault tier in eidan_backend.secrets.
    # Scope namespaces the key (``plugin:sentry``, ``plugin:imap``,
    # ``core``) so two plugins can both ask for ``smtp_password`` without
    # colliding. Value is sealed with EIDAN_AUTH_MASTER_KEY.
    op.create_table(
        "secrets_vault",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column("scope", sa.Text(), nullable=False),
        sa.Column("key", sa.Text(), nullable=False),
        sa.Column("value_enc", postgresql.BYTEA, nullable=False),
        sa.Column(
            "created_at",
            postgresql.TIMESTAMP(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.Column(
            "updated_at",
            postgresql.TIMESTAMP(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.UniqueConstraint("scope", "key", name="secrets_vault_scope_key_unique"),
        schema="eidan",
    )
    op.execute(
        """
        CREATE TRIGGER trg_secrets_vault_updated_at
        BEFORE UPDATE ON eidan.secrets_vault
        FOR EACH ROW EXECUTE FUNCTION eidan.set_updated_at()
        """
    )


def downgrade() -> None:
    op.execute(
        "DROP TRIGGER IF EXISTS trg_secrets_vault_updated_at "
        "ON eidan.secrets_vault"
    )
    op.drop_table("secrets_vault", schema="eidan")
    op.drop_table("auth_keypair", schema="eidan")
    op.drop_table("auth_mfa_totp", schema="eidan")
    op.drop_index(
        "idx_auth_magic_links_pending",
        table_name="auth_magic_links",
        schema="eidan",
    )
    op.drop_table("auth_magic_links", schema="eidan")
    op.drop_index(
        "idx_auth_sessions_user_active",
        table_name="auth_sessions",
        schema="eidan",
    )
    op.drop_table("auth_sessions", schema="eidan")
