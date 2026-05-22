"""Smoke tests for the eidan_app Postgres role (issue #36).

Per ``docs/011 §9.2``, the backend should connect as a dedicated
``eidan_app`` role with narrow privileges. The role is provisioned by
``migrations/versions/20260514_000005_eidan_app_role.py`` when
``EIDAN_CREATE_APP_ROLE=true`` is set in the environment.

The default test session does NOT enable that env var (the
``eidan_db`` fixture in conftest runs ``alembic upgrade head`` with
the operator's normal env, and the migration is opt-in), so this
module bootstraps a fake ``auth.users`` mirror and re-applies the
exact GRANT pattern the migration installs against the same
ephemeral database. The assertions then verify the permission model
described in the doc:

- ``SELECT (id, email) ON auth.users`` is allowed.
- ``SELECT raw_user_meta_data ON auth.users`` is denied — the
  per-column GRANT is the whole point.
- ``SELECT`` on a non-eidan, non-auth catalog (``pg_class``) is
  allowed; Postgres exposes catalogs to every role server-internally.
- The role has no ``BYPASSRLS`` attribute.
- DML on ``eidan.*`` works.

Re-applying the same SQL is also exercised, mirroring the
"migration is idempotent" acceptance criterion.
"""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path
from urllib.parse import urlparse

import psycopg
import pytest
from psycopg import sql

_REPO_ROOT = Path(__file__).resolve().parents[3]
_ALEMBIC_INI = _REPO_ROOT / "migrations" / "alembic.ini"

EIDAN_APP_PASSWORD = "smoke-test-app-password"  # noqa: S105 — local test only


def _connect_kwargs(url: str) -> dict[str, object]:
    parsed = urlparse(url)
    return {
        "host": parsed.hostname,
        "port": parsed.port,
        "user": parsed.username,
        "password": parsed.password or "",
        "dbname": parsed.path.lstrip("/"),
    }


def _grant_sql() -> list[str]:
    """The exact GRANT pattern installed by the role migration.

    Kept in sync with ``migrations/versions/20260514_000005_eidan_app_role.py``;
    if you change the migration, update this list.
    """
    return [
        "GRANT USAGE ON SCHEMA eidan TO eidan_app",
        (
            "GRANT SELECT, INSERT, UPDATE, DELETE "
            "ON ALL TABLES IN SCHEMA eidan TO eidan_app"
        ),
        "GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA eidan TO eidan_app",
        (
            "ALTER DEFAULT PRIVILEGES IN SCHEMA eidan "
            "GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO eidan_app"
        ),
        (
            "ALTER DEFAULT PRIVILEGES IN SCHEMA eidan "
            "GRANT USAGE, SELECT ON SEQUENCES TO eidan_app"
        ),
        "GRANT USAGE ON SCHEMA auth TO eidan_app",
        "GRANT SELECT (id, email) ON auth.users TO eidan_app",
    ]


def _bootstrap_app_role(superuser_url: str, password: str) -> None:
    """Create a fake ``auth.users`` and apply the migration's role + GRANTs.

    The fake ``auth.users`` mirrors Supabase's shape closely enough for
    the per-column GRANT to mean the same thing — id and email are
    granted, ``raw_user_meta_data`` is not.
    """
    with psycopg.connect(autocommit=True, **_connect_kwargs(superuser_url)) as conn:
        conn.execute("CREATE SCHEMA IF NOT EXISTS auth")
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS auth.users (
                id                  uuid PRIMARY KEY,
                email               text,
                raw_user_meta_data  jsonb NOT NULL DEFAULT '{}'::jsonb
            )
            """
        )
        # Mirror the migration's idempotent CREATE-or-ALTER pattern.
        # psycopg's sql.Literal handles password quoting safely; using
        # psycopg's composition here (rather than format(%L)) avoids the
        # %-vs-%L collision between psycopg's parameter style and
        # Postgres's format() literal placeholder.
        existing = conn.execute(
            "SELECT 1 FROM pg_roles WHERE rolname = 'eidan_app'"
        ).fetchone()
        if existing is None:
            conn.execute(
                sql.SQL(
                    "CREATE ROLE eidan_app LOGIN PASSWORD {pw} NOBYPASSRLS"
                ).format(pw=sql.Literal(password))
            )
        else:
            conn.execute(
                sql.SQL(
                    "ALTER ROLE eidan_app WITH LOGIN PASSWORD {pw} NOBYPASSRLS"
                ).format(pw=sql.Literal(password))
            )
        for stmt in _grant_sql():
            conn.execute(stmt)


def _teardown_app_role(superuser_url: str) -> None:
    with psycopg.connect(autocommit=True, **_connect_kwargs(superuser_url)) as conn:
        conn.execute(
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
        conn.execute("DROP TABLE IF EXISTS auth.users")
        conn.execute("DROP SCHEMA IF EXISTS auth")


def _eidan_app_url(superuser_url: str) -> str:
    parsed = urlparse(superuser_url)
    return (
        f"postgresql://eidan_app:{EIDAN_APP_PASSWORD}@"
        f"{parsed.hostname}:{parsed.port}{parsed.path}"
    )


@pytest.fixture
def eidan_app_url(eidan_db: str):
    _bootstrap_app_role(eidan_db, EIDAN_APP_PASSWORD)
    try:
        yield _eidan_app_url(eidan_db)
    finally:
        _teardown_app_role(eidan_db)


def test_eidan_app_role_is_not_superuser_and_does_not_bypass_rls(
    eidan_db: str, eidan_app_url: str
) -> None:
    with psycopg.connect(autocommit=True, **_connect_kwargs(eidan_db)) as conn:
        attrs = conn.execute(
            "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = 'eidan_app'"
        ).fetchone()
    assert attrs == (False, False)


def test_eidan_app_role_can_select_id_email_on_auth_users(
    eidan_app_url: str,
) -> None:
    with psycopg.connect(eidan_app_url) as conn:
        # Empty result is fine — the assertion is that the SELECT itself
        # doesn't raise InsufficientPrivilege.
        conn.execute("SELECT id, email FROM auth.users").fetchall()


def test_eidan_app_role_cannot_select_raw_user_meta_data(
    eidan_app_url: str,
) -> None:
    """The per-column GRANT excludes raw_user_meta_data; SELECT must fail."""
    with psycopg.connect(eidan_app_url) as conn:
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            conn.execute("SELECT raw_user_meta_data FROM auth.users").fetchall()


def test_eidan_app_role_can_read_pg_catalog(eidan_app_url: str) -> None:
    """Server-internal catalogs are visible to every role; sanity check."""
    with psycopg.connect(eidan_app_url) as conn:
        rows = conn.execute(
            "SELECT count(*) FROM pg_class WHERE relkind = 'r'"
        ).fetchone()
    assert rows is not None and rows[0] >= 1


def test_eidan_app_role_can_dml_eidan_tables(eidan_app_url: str) -> None:
    """End-to-end: insert a user row, read it back, delete it."""
    user_id = "00000000-0000-0000-0000-0000000000aa"
    with psycopg.connect(eidan_app_url, autocommit=True) as conn:
        conn.execute(
            "INSERT INTO eidan.users (id, email) VALUES (%s::uuid, %s)",
            (user_id, "smoke@example.com"),
        )
        try:
            row = conn.execute(
                "SELECT email FROM eidan.users WHERE id = %s::uuid",
                (user_id,),
            ).fetchone()
            assert row == ("smoke@example.com",)
            conn.execute(
                "UPDATE eidan.users SET email = %s WHERE id = %s::uuid",
                ("rotated@example.com", user_id),
            )
            row = conn.execute(
                "SELECT email FROM eidan.users WHERE id = %s::uuid",
                (user_id,),
            ).fetchone()
            assert row == ("rotated@example.com",)
        finally:
            conn.execute(
                "DELETE FROM eidan.users WHERE id = %s::uuid", (user_id,)
            )


def test_migration_provisions_role_when_env_var_is_set(postgresql_proc) -> None:
    """End-to-end: ``alembic upgrade head`` with EIDAN_CREATE_APP_ROLE=true.

    Spins up a fresh DB on the pytest-postgresql process, pre-creates a
    fake ``auth.users`` so the migration can hang the per-column GRANT
    on it, then runs the migration runner directly. This exercises the
    actual migration code path (set_config + DO/format(%L) + GRANTs)
    rather than the parallel SQL the rest of this module uses.
    """
    host = postgresql_proc.host
    port = postgresql_proc.port
    user = postgresql_proc.user
    password = postgresql_proc.password or ""
    dbname = "eidan_role_smoke"

    auth = f"{user}:{password}@" if password else f"{user}@"
    async_url = f"postgresql+asyncpg://{auth}{host}:{port}/{dbname}"

    with psycopg.connect(
        host=host,
        port=port,
        user=user,
        password=password,
        dbname="postgres",
        autocommit=True,
    ) as conn:
        conn.execute(f"DROP DATABASE IF EXISTS {dbname}")
        conn.execute("DROP ROLE IF EXISTS eidan_app")
        conn.execute(f"CREATE DATABASE {dbname}")

    with psycopg.connect(
        host=host, port=port, user=user, password=password,
        dbname=dbname, autocommit=True,
    ) as conn:
        conn.execute("CREATE SCHEMA auth")
        conn.execute(
            """
            CREATE TABLE auth.users (
                id                  uuid PRIMARY KEY,
                email               text,
                raw_user_meta_data  jsonb NOT NULL DEFAULT '{}'::jsonb
            )
            """
        )

    env = os.environ.copy()
    env["DATABASE_URL"] = async_url
    env["EIDAN_CREATE_APP_ROLE"] = "true"
    env["EIDAN_APP_DB_PASSWORD"] = EIDAN_APP_PASSWORD
    try:
        result = subprocess.run(
            [
                sys.executable, "-m", "alembic",
                "-c", str(_ALEMBIC_INI), "upgrade", "head",
            ],
            cwd=str(_REPO_ROOT),
            env=env,
            capture_output=True,
            text=True,
            check=False,
        )
        if result.returncode != 0:
            raise RuntimeError(
                f"alembic upgrade head failed:\n"
                f"stdout:\n{result.stdout}\nstderr:\n{result.stderr}"
            )

        # Role exists, has the right attributes, and the auth.users
        # GRANT applied because we pre-created the table.
        with psycopg.connect(
            host=host, port=port, user=user, password=password,
            dbname=dbname,
        ) as conn:
            row = conn.execute(
                "SELECT rolsuper, rolbypassrls, rolcanlogin "
                "FROM pg_roles WHERE rolname = 'eidan_app'"
            ).fetchone()
            assert row == (False, False, True)

        # And the role can actually log in and exercise its GRANTs.
        app_url = (
            f"postgresql://eidan_app:{EIDAN_APP_PASSWORD}@{host}:{port}/{dbname}"
        )
        with psycopg.connect(app_url) as conn:
            conn.execute("SELECT id, email FROM auth.users").fetchall()
            with pytest.raises(psycopg.errors.InsufficientPrivilege):
                conn.execute(
                    "SELECT raw_user_meta_data FROM auth.users"
                ).fetchall()
    finally:
        # Tear down the role and database so the process fixture is
        # left in a clean state for any later test that reuses it.
        with psycopg.connect(
            host=host, port=port, user=user, password=password,
            dbname="postgres", autocommit=True,
        ) as conn:
            conn.execute(
                "SELECT pg_terminate_backend(pid) FROM pg_stat_activity "
                "WHERE datname = %s AND pid <> pg_backend_pid()",
                (dbname,),
            )
            conn.execute(f"DROP DATABASE IF EXISTS {dbname}")
            conn.execute("DROP ROLE IF EXISTS eidan_app")


def test_grant_pattern_is_idempotent(eidan_db: str, eidan_app_url: str) -> None:
    """Re-running the migration's GRANTs against an existing role is a no-op."""
    with psycopg.connect(autocommit=True, **_connect_kwargs(eidan_db)) as conn:
        for stmt in _grant_sql():
            conn.execute(stmt)
        # Re-asserting the role with the same password also works
        # (rotation flow). The migration ALTERs on every re-run.
        conn.execute(
            sql.SQL(
                "ALTER ROLE eidan_app WITH LOGIN PASSWORD {pw} NOBYPASSRLS"
            ).format(pw=sql.Literal(EIDAN_APP_PASSWORD))
        )

    # And the connection still works after the second apply.
    with psycopg.connect(eidan_app_url) as conn:
        conn.execute("SELECT 1").fetchone()
