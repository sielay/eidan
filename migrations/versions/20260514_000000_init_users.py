"""init users + updated_at machinery

Revision ID: 20260514000000
Revises:
Create Date: 2026-05-14

Establishes prerequisites for every memory-model table:
- pgcrypto extension (for gen_random_uuid())
- eidan.set_updated_at() trigger function
- eidan.users — id mirrors Supabase auth.users.id; populated on first
  JWT validation (docs/011 §6).
"""
from __future__ import annotations

from collections.abc import Sequence

from alembic import op

revision: str = "20260514000000"
down_revision: str | None = None
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute("CREATE EXTENSION IF NOT EXISTS pgcrypto")

    op.execute(
        """
        CREATE OR REPLACE FUNCTION eidan.set_updated_at()
        RETURNS trigger
        LANGUAGE plpgsql
        AS $$
        BEGIN
            NEW.updated_at := now();
            RETURN NEW;
        END;
        $$
        """
    )

    op.execute(
        """
        CREATE TABLE eidan.users (
            id          uuid        PRIMARY KEY,
            email       text        UNIQUE,
            metadata    jsonb       NOT NULL DEFAULT '{}'::jsonb,
            created_at  timestamptz NOT NULL DEFAULT now(),
            updated_at  timestamptz NOT NULL DEFAULT now()
        )
        """
    )

    op.execute(
        """
        CREATE TRIGGER trg_users_updated_at
        BEFORE UPDATE ON eidan.users
        FOR EACH ROW EXECUTE FUNCTION eidan.set_updated_at()
        """
    )


def downgrade() -> None:
    op.execute("DROP TRIGGER IF EXISTS trg_users_updated_at ON eidan.users")
    op.execute("DROP TABLE IF EXISTS eidan.users")
    op.execute("DROP FUNCTION IF EXISTS eidan.set_updated_at()")
