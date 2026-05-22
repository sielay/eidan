"""eidan_app Postgres role + narrow GRANTs

Revision ID: 20260514000005
Revises: 20260514000004
Create Date: 2026-05-14

Per ``docs/011 §9.2``, the backend should connect as a dedicated
``eidan_app`` login role with narrow privileges:

- owns ``eidan.*`` (full DML across the schema, plus default
  privileges so future tables inherit the same grants)
- ``SELECT (id, email)`` on ``auth.users`` only — no other
  ``auth.*`` column is granted
- explicitly NOT granted ``BYPASSRLS``

Phase 1 used whatever role ``DATABASE_URL`` provides (typically a
superuser in dev). This migration provisions the role properly.

The migration is opt-in: it only fires when ``EIDAN_CREATE_APP_ROLE``
is set to ``true`` in the environment. In production, set
``EIDAN_CREATE_APP_ROLE=true`` and ``EIDAN_APP_DB_PASSWORD=<secret>``
once at first deploy, then point ``DATABASE_URL`` at the new role.
In dev / test the default behaviour is a no-op so the existing
single-superuser flow keeps working.

The ``GRANT`` on ``auth.users`` is conditional on the table actually
existing — Supabase ships ``auth.users`` in every supported
deployment, but local test rigs do not, and the migration must
upgrade cleanly in both. A NOTICE is raised when the GRANT is
skipped so an operator who expected it can catch the mismatch.
"""

from __future__ import annotations

import os
from collections.abc import Sequence

from alembic import op
from sqlalchemy import text

revision: str = "20260514000005"
down_revision: str | None = "20260514000004"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def _truthy(value: str | None) -> bool:
    return (value or "").strip().lower() in {"1", "true", "yes", "on"}


def upgrade() -> None:
    if not _truthy(os.environ.get("EIDAN_CREATE_APP_ROLE")):
        op.execute(
            "DO $$ BEGIN RAISE NOTICE "
            "'eidan_app role migration skipped (EIDAN_CREATE_APP_ROLE not set)'; "
            "END $$"
        )
        return

    password = os.environ.get("EIDAN_APP_DB_PASSWORD")
    if not password:
        raise RuntimeError(
            "EIDAN_CREATE_APP_ROLE=true but EIDAN_APP_DB_PASSWORD is not set. "
            "Set the password to provision the eidan_app role; the migration "
            "uses it as the LOGIN password (docs/011 §9.2)."
        )

    # CREATE/ALTER ROLE does not accept bound parameters in plain SQL,
    # and asyncpg's ``$N`` placeholders cannot be threaded into a DO
    # block's dynamic EXECUTE either. Stash the password in a
    # transaction-local GUC and read it back via current_setting() —
    # the GUC is bound through SQLAlchemy so the literal never sees
    # string interpolation in Python.
    op.execute(
        text("SELECT set_config('eidan.app_password', :pw, true)").bindparams(
            pw=password
        )
    )

    # Idempotent role provisioning. CREATE on first run, ALTER on
    # re-runs so the operator can rotate the password by re-applying.
    # NOBYPASSRLS is asserted on both branches per docs/011 §9.2.
    op.execute(
        """
        DO $do$
        BEGIN
            IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'eidan_app') THEN
                EXECUTE format(
                    'CREATE ROLE eidan_app LOGIN PASSWORD %L NOBYPASSRLS',
                    current_setting('eidan.app_password')
                );
            ELSE
                EXECUTE format(
                    'ALTER ROLE eidan_app WITH LOGIN PASSWORD %L NOBYPASSRLS',
                    current_setting('eidan.app_password')
                );
            END IF;
        END
        $do$
        """
    )

    # Schema + table grants. GRANT statements are naturally idempotent.
    op.execute("GRANT USAGE ON SCHEMA eidan TO eidan_app")
    op.execute(
        "GRANT SELECT, INSERT, UPDATE, DELETE "
        "ON ALL TABLES IN SCHEMA eidan TO eidan_app"
    )
    op.execute(
        "GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA eidan TO eidan_app"
    )
    # Future tables / sequences in eidan inherit the same grants. The
    # default-privileges row is keyed on (grantor, schema, object_type),
    # so re-running this is an idempotent upsert in pg_default_acl.
    op.execute(
        "ALTER DEFAULT PRIVILEGES IN SCHEMA eidan "
        "GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO eidan_app"
    )
    op.execute(
        "ALTER DEFAULT PRIVILEGES IN SCHEMA eidan "
        "GRANT USAGE, SELECT ON SEQUENCES TO eidan_app"
    )

    # auth.users grants — Supabase ships this table; local rigs may not.
    # Skip silently (with a NOTICE) when the table is absent rather than
    # forcing every dev to provision a fake auth schema.
    op.execute(
        """
        DO $do$
        BEGIN
            IF EXISTS (
                SELECT 1
                FROM information_schema.tables
                WHERE table_schema = 'auth' AND table_name = 'users'
            ) THEN
                EXECUTE 'GRANT USAGE ON SCHEMA auth TO eidan_app';
                EXECUTE 'GRANT SELECT (id, email) ON auth.users TO eidan_app';
            ELSE
                RAISE NOTICE
                    'auth.users not present; skipped GRANT SELECT (id, email) '
                    'to eidan_app. Re-run this migration after Supabase '
                    'provisioning if running against a hosted Supabase project.';
            END IF;
        END
        $do$
        """
    )


def downgrade() -> None:
    if not _truthy(os.environ.get("EIDAN_CREATE_APP_ROLE")):
        return

    # DROP OWNED BY clears the role's grants across every database object
    # before DROP ROLE; without it Postgres refuses to drop a role that
    # still owns privileges. Wrapped in IF EXISTS so a downgrade against
    # a database that never created the role is a no-op.
    op.execute(
        """
        DO $do$
        BEGIN
            IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'eidan_app') THEN
                EXECUTE 'REVOKE ALL ON ALL TABLES IN SCHEMA eidan FROM eidan_app';
                EXECUTE 'REVOKE ALL ON ALL SEQUENCES IN SCHEMA eidan FROM eidan_app';
                EXECUTE 'REVOKE ALL ON SCHEMA eidan FROM eidan_app';
                EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA eidan '
                        'REVOKE ALL ON TABLES FROM eidan_app';
                EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA eidan '
                        'REVOKE ALL ON SEQUENCES FROM eidan_app';
                IF EXISTS (
                    SELECT 1
                    FROM information_schema.tables
                    WHERE table_schema = 'auth' AND table_name = 'users'
                ) THEN
                    EXECUTE 'REVOKE ALL ON auth.users FROM eidan_app';
                    EXECUTE 'REVOKE ALL ON SCHEMA auth FROM eidan_app';
                END IF;
                EXECUTE 'DROP OWNED BY eidan_app';
                EXECUTE 'DROP ROLE eidan_app';
            END IF;
        END
        $do$
        """
    )
