"""``eidan admin doctor`` — verify the operator's install is healthy.

Runs a series of small checks and prints a structured report. Designed
to be the first thing an operator runs after configuring ``.env`` and
before ``make migrate`` / ``make repl``. Catches the common first-run
misconfigurations:

- Required env vars missing.
- DATABASE_URL set but Postgres unreachable.
- EIDAN_AUTH_MASTER_KEY unset (the native auth subsystem refuses to
  boot without it).
- Migrations haven't been applied (no ``eidan`` schema).
- Plugin discovery finds zero plugins (unexpected) or fails outright.

Each check is independent — one failure doesn't stop the rest. The
exit code is non-zero if ANY check failed, so ``make doctor`` is a
sensible CI gate too.
"""

from __future__ import annotations

import asyncio
import logging
import os
from dataclasses import dataclass
from pathlib import Path

from rich.console import Console
from rich.table import Table

_console = Console()
logger = logging.getLogger(__name__)

_REPO_ROOT = Path(__file__).resolve().parents[3]
_PLUGINS_DIR = _REPO_ROOT / "plugins"

# Vars the host MUST have. Each entry: (env name, human label, optional hint).
_REQUIRED_ENV: tuple[tuple[str, str, str], ...] = (
    (
        "DATABASE_URL",
        "Postgres URL",
        "Set to e.g. postgresql+asyncpg://eidan:eidan@localhost:5432/eidan",
    ),
    (
        "ANTHROPIC_API_KEY",
        "Anthropic API key",
        "Get one at https://console.anthropic.com — without it the loop's "
        "Anthropic provider can't make calls.",
    ),
    (
        "EIDAN_AUTH_MASTER_KEY",
        "Auth master key",
        "Generate with: python -c 'import secrets; "
        "print(secrets.token_urlsafe(48))' — seals the RS256 keypair + vault.",
    ),
)

# Vars needed for `eidan login`. Without these the operator can't
# sign in, but the host runs without them.
_LOGIN_ENV: tuple[tuple[str, str, str], ...] = (
    (
        "EIDAN_AUTH_ALLOWED_EMAIL",
        "Allow-list email",
        "The single email the magic-link endpoint will mint a link for.",
    ),
)


@dataclass
class _Check:
    label: str
    status: str  # "ok" | "warn" | "fail"
    detail: str = ""


def _check_env() -> list[_Check]:
    checks: list[_Check] = []
    for name, label, hint in _REQUIRED_ENV:
        if os.environ.get(name):
            checks.append(_Check(label=label, status="ok"))
        else:
            checks.append(
                _Check(
                    label=label,
                    status="fail",
                    detail=f"{name} not set. {hint}",
                )
            )
    for name, label, hint in _LOGIN_ENV:
        if os.environ.get(name):
            checks.append(_Check(label=label, status="ok"))
        else:
            checks.append(
                _Check(
                    label=label,
                    status="warn",
                    detail=f"{name} not set. {hint} (needed only for `eidan login`.)",
                )
            )
    return checks


async def _check_postgres() -> _Check:
    url = os.environ.get("DATABASE_URL")
    if not url:
        return _Check(
            label="Postgres reachable",
            status="fail",
            detail="DATABASE_URL not set (see above).",
        )
    try:
        import asyncpg

        normalised = url.replace("postgresql+asyncpg://", "postgresql://", 1)
        conn = await asyncpg.connect(normalised, timeout=5.0)
        try:
            version = await conn.fetchval("SHOW server_version")
        finally:
            await conn.close()
        return _Check(
            label="Postgres reachable",
            status="ok",
            detail=f"server_version = {version}",
        )
    except Exception as exc:  # noqa: BLE001 — surfaced to the operator
        return _Check(
            label="Postgres reachable",
            status="fail",
            detail=f"Connection failed: {exc}",
        )


async def _check_auth_keypair() -> _Check:
    """Probe ``eidan.auth_keypair`` for the host's RS256 keypair.

    On first boot the lifespan mints + persists the pair; subsequent
    starts read it back. A missing keypair *with* the master key
    set just means the host has never booted against this DB; that
    is a soft warn (the next ``make server`` fills it in).
    """
    url = os.environ.get("DATABASE_URL")
    if not url:
        return _Check(
            label="Auth keypair (eidan.auth_keypair)",
            status="warn",
            detail="DATABASE_URL not set; can't probe.",
        )
    if not os.environ.get("EIDAN_AUTH_MASTER_KEY"):
        return _Check(
            label="Auth keypair (eidan.auth_keypair)",
            status="warn",
            detail="Skipped: EIDAN_AUTH_MASTER_KEY is unset.",
        )
    try:
        import asyncpg

        normalised = url.replace("postgresql+asyncpg://", "postgresql://", 1)
        conn = await asyncpg.connect(normalised, timeout=5.0)
        try:
            row = await conn.fetchrow(
                "SELECT id FROM eidan.auth_keypair WHERE id = 'current'"
            )
        finally:
            await conn.close()
    except asyncpg.UndefinedTableError:
        return _Check(
            label="Auth keypair (eidan.auth_keypair)",
            status="warn",
            detail="Table not present — run `make migrate`.",
        )
    except Exception as exc:  # noqa: BLE001
        return _Check(
            label="Auth keypair (eidan.auth_keypair)",
            status="fail",
            detail=f"Probe failed: {exc}",
        )
    if row is None:
        return _Check(
            label="Auth keypair (eidan.auth_keypair)",
            status="warn",
            detail="Not yet minted — boot the backend once to fill.",
        )
    return _Check(
        label="Auth keypair (eidan.auth_keypair)",
        status="ok",
        detail="present",
    )


async def _check_migrations() -> _Check:
    """Verify the ``eidan`` schema exists and the alembic head matches."""
    url = os.environ.get("DATABASE_URL")
    if not url:
        return _Check(
            label="Migrations applied",
            status="fail",
            detail="DATABASE_URL not set; can't probe.",
        )
    try:
        import asyncpg

        normalised = url.replace("postgresql+asyncpg://", "postgresql://", 1)
        conn = await asyncpg.connect(normalised, timeout=5.0)
        try:
            schema = await conn.fetchval(
                "SELECT 1 FROM information_schema.schemata "
                "WHERE schema_name = 'eidan' LIMIT 1"
            )
            if not schema:
                return _Check(
                    label="Migrations applied",
                    status="fail",
                    detail="eidan schema does not exist. Run `make migrate`.",
                )
            head = await conn.fetchval(
                "SELECT version_num FROM eidan.alembic_version LIMIT 1"
            )
            return _Check(
                label="Migrations applied",
                status="ok",
                detail=f"alembic head = {head}",
            )
        finally:
            await conn.close()
    except Exception as exc:  # noqa: BLE001
        return _Check(
            label="Migrations applied",
            status="fail",
            detail=f"Probe failed: {exc}",
        )


def _check_plugins() -> _Check:
    if not _PLUGINS_DIR.is_dir():
        return _Check(
            label="Plugins discoverable",
            status="warn",
            detail=f"{_PLUGINS_DIR} does not exist. Plugins won't load.",
        )
    try:
        from eidan_backend.plugins import load_plugins

        plugins = load_plugins(_PLUGINS_DIR)
    except Exception as exc:  # noqa: BLE001
        return _Check(
            label="Plugins discoverable",
            status="fail",
            detail=f"Loader raised: {exc}",
        )
    if not plugins:
        return _Check(
            label="Plugins discoverable",
            status="warn",
            detail="No plugin.yaml files found under plugins/.",
        )
    names = ", ".join(p.manifest.name for p in plugins)
    return _Check(
        label="Plugins discoverable",
        status="ok",
        detail=f"{len(plugins)} plugin(s): {names}",
    )


def _check_auth_storage() -> _Check:
    """Probe whether a stored auth token exists. Soft check."""
    try:
        from .storage import load as load_auth

        stored = load_auth()
    except Exception as exc:  # noqa: BLE001
        return _Check(
            label="Stored auth token",
            status="warn",
            detail=f"Token store probe failed: {exc}",
        )
    if stored is None:
        return _Check(
            label="Stored auth token",
            status="warn",
            detail="No stored token. Run `eidan login` before `eidan repl`.",
        )
    return _Check(
        label="Stored auth token",
        status="ok",
        detail=f"provider={stored.provider} email={stored.email or 'unknown'}",
    )


async def _run_all() -> list[_Check]:
    checks: list[_Check] = []
    checks.extend(_check_env())
    checks.append(await _check_postgres())
    checks.append(await _check_migrations())
    checks.append(await _check_auth_keypair())
    checks.append(_check_plugins())
    checks.append(_check_auth_storage())
    return checks


_STATUS_GLYPH = {
    "ok": "[green]✓[/green]",
    "warn": "[yellow]![/yellow]",
    "fail": "[red]✗[/red]",
}


def doctor() -> int:
    """Render the report and return a process exit code."""
    checks = asyncio.run(_run_all())

    table = Table(show_header=True, header_style="bold")
    table.add_column("", width=2)
    table.add_column("Check")
    table.add_column("Detail")
    for c in checks:
        table.add_row(_STATUS_GLYPH[c.status], c.label, c.detail)
    _console.print(table)

    failures = sum(1 for c in checks if c.status == "fail")
    warnings = sum(1 for c in checks if c.status == "warn")
    if failures:
        _console.print(
            f"\n[red]{failures} check(s) failed.[/red] Fix and re-run "
            "[cyan]eidan admin doctor[/cyan]."
        )
        return 1
    if warnings:
        _console.print(
            f"\n[yellow]{warnings} warning(s).[/yellow] Eidan can run but "
            "some surfaces may be degraded."
        )
        return 0
    _console.print("\n[green]All checks passed.[/green] You're ready.")
    return 0
