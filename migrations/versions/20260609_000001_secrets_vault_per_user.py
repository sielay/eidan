# SPDX-License-Identifier: AGPL-3.0-or-later
"""secrets_vault: per-user scope + expiry + audit (docs/031 Phase 1)

Closes the gap between docs/012's spec and the built vault (docs/031 §1):
the vault was instance-global (`unique (scope, key)`); this makes it
per-user as 012 §4.1 specifies, so a hosted deployment can hold each
user's own integration credentials, encrypted and isolated.

- `user_id` (FK users, NULL = instance/system scope) + `expires_at` (TTL).
- Uniqueness becomes `(user_id, scope, key)`. Postgres 17, so the index
  uses `NULLS NOT DISTINCT`: instance rows (NULL user) stay unique on
  `(scope, key)` exactly as before, while per-user rows are unique per
  user. The old `(scope, key)` constraint is dropped — the two writers
  that targeted it (`a2a_vault`, `api_keys`) are updated in lockstep to
  the new conflict target.
- `secrets_audit` (012 §8): an append-only log of write/delete/denied.

Additive for existing reads: every current row gets `user_id = NULL`
and is read exactly as before via `user_id IS NULL`.
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op

revision: str = "20260609000001"
down_revision: str | None = "20260608000002"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # --- per-user + TTL columns -------------------------------------------
    op.execute(
        "ALTER TABLE eidan.secrets_vault "
        "ADD COLUMN user_id uuid REFERENCES eidan.users(id) ON DELETE CASCADE"
    )
    op.execute(
        "ALTER TABLE eidan.secrets_vault ADD COLUMN expires_at timestamptz"
    )

    # --- swap instance-global uniqueness for per-user uniqueness ----------
    # NULLS NOT DISTINCT (PG15+) makes NULL user_ids collide, so instance
    # rows keep their old (scope, key) uniqueness while per-user rows are
    # distinct per user.
    op.execute(
        "ALTER TABLE eidan.secrets_vault "
        "DROP CONSTRAINT secrets_vault_scope_key_unique"
    )
    op.execute(
        "CREATE UNIQUE INDEX secrets_vault_user_scope_key_unique "
        "ON eidan.secrets_vault (user_id, scope, key) NULLS NOT DISTINCT"
    )
    op.execute(
        "CREATE INDEX secrets_vault_expires_at_idx "
        "ON eidan.secrets_vault (expires_at) WHERE expires_at IS NOT NULL"
    )

    # --- audit trail (012 §8) ---------------------------------------------
    op.execute(
        """
        CREATE TABLE eidan.secrets_audit (
            id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
            user_id     uuid,
            scope       text        NOT NULL,
            key         text        NOT NULL,
            action      text        NOT NULL
                        CHECK (action IN ('read', 'write', 'delete', 'denied')),
            actor       text,
            created_at  timestamptz NOT NULL DEFAULT now()
        )
        """
    )
    op.execute(
        "CREATE INDEX secrets_audit_created_idx "
        "ON eidan.secrets_audit (created_at DESC)"
    )


def downgrade() -> None:
    op.execute("DROP TABLE IF EXISTS eidan.secrets_audit")
    op.execute("DROP INDEX IF EXISTS eidan.secrets_vault_expires_at_idx")
    op.execute("DROP INDEX IF EXISTS eidan.secrets_vault_user_scope_key_unique")
    op.execute(
        "ALTER TABLE eidan.secrets_vault "
        "ADD CONSTRAINT secrets_vault_scope_key_unique UNIQUE (scope, key)"
    )
    op.execute("ALTER TABLE eidan.secrets_vault DROP COLUMN expires_at")
    op.execute("ALTER TABLE eidan.secrets_vault DROP COLUMN user_id")
