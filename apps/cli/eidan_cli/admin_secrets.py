# SPDX-License-Identifier: AGPL-3.0-or-later
"""``eidan admin secrets`` — operator CLI to provision vault secrets.

Implements the operator surface specified in ``docs/012 §9.1``. Plugins
read third-party credentials via ``ctx.secret("<scope>.<key>")``, which
resolves env → ``eidan.secrets_vault`` → per-agent override. This adds
the missing *write* path for the vault tier (previously the Slack
adapter pointed operators at a command that did not exist — see #202).

Like the rest of ``eidan admin`` it connects directly to the database
(``DATABASE_URL``) and seals values with ``EIDAN_AUTH_MASTER_KEY`` — the
same two env vars the migrate path already relies on.

The plaintext value is **never** accepted as a CLI argument (it would
leak into shell history / the process table) and is never printed: it
is read from an interactive hidden prompt, ``--stdin``, or
``--from-file`` (docs/012 §9.1).

Scope: ``set`` / ``list`` / ``delete``. ``get`` and ``audit --tail``
from §9.1 are deferred to a follow-up.
"""

from __future__ import annotations

import asyncio
import os
import sys
from pathlib import Path

import typer
from rich.console import Console
from rich.table import Table

secrets_app = typer.Typer(
    name="secrets",
    help="Provision vault secrets (set / list / delete) read by plugins.",
    no_args_is_help=True,
    add_completion=False,
)

_console = Console()


def _need_database_url() -> str:
    """Return a plain ``postgresql://`` URL or exit with guidance.

    Mirrors ``eidan admin`` — asyncpg wants the bare scheme, not the
    SQLAlchemy ``+asyncpg`` variant the topology carries.
    """
    url = os.environ.get("DATABASE_URL")
    if not url:
        _console.print(
            "[red]DATABASE_URL is not set.[/red] `eidan admin secrets` reads "
            "it from the environment (same as the other admin commands)."
        )
        raise typer.Exit(2)
    return url.replace("postgresql+asyncpg://", "postgresql://", 1)


def _require_master_key() -> None:
    from eidan_backend.auth_native.vault_crypto import master_key_configured

    if not master_key_configured():
        _console.print(
            "[red]EIDAN_AUTH_MASTER_KEY is not set.[/red] It seals the value "
            "at rest; export the same key the backend uses and retry."
        )
        raise typer.Exit(2)


def _read_value(use_stdin: bool, from_file: Path | None, key: str) -> str:
    """Read the secret value from exactly one safe source.

    Never from argv (docs/012 §9.1). Trailing newline is stripped so a
    piped value or editor-saved file doesn't store a stray ``\\n``.
    """
    if use_stdin and from_file is not None:
        _console.print("[red]Pass at most one of --stdin / --from-file.[/red]")
        raise typer.Exit(2)
    if use_stdin:
        raw = sys.stdin.read().rstrip("\n")
    elif from_file is not None:
        raw = from_file.read_text(encoding="utf-8").rstrip("\n")
    else:
        # Hidden interactive prompt — value is not echoed.
        raw = typer.prompt(f"value for {key}", hide_input=True)
    if not raw:
        _console.print("[red]Refusing to store an empty value.[/red]")
        raise typer.Exit(2)
    return raw


@secrets_app.command("set")
def secrets_set(
    key: str = typer.Argument(
        ..., help='Dotted key, e.g. "slack.bot_token". No dot → scope "core".'
    ),
    use_stdin: bool = typer.Option(
        False, "--stdin", help="Read the value from stdin (e.g. piped)."
    ),
    from_file: Path | None = typer.Option(  # noqa: B008
        None, "--from-file", help="Read the value from a file."
    ),
) -> None:
    """Seal a value and upsert it into ``eidan.secrets_vault`` under KEY.

    The value is read from a hidden prompt (default), ``--stdin``, or
    ``--from-file`` — never from argv. The stored row is read back and
    decrypted to confirm the round-trip before reporting success (per
    the logging doctrine); the value is never printed.
    """
    raw = _read_value(use_stdin, from_file, key)
    _require_master_key()
    url = _need_database_url()

    from eidan_backend.auth_native.vault_crypto import decrypt_value, encrypt_value
    from eidan_backend.secrets import split_secret_key

    scope, subkey = split_secret_key(key)
    value_enc = encrypt_value(raw.encode("utf-8"))
    expected = raw.encode("utf-8")

    async def _run() -> str | None:
        import asyncpg

        conn = await asyncpg.connect(url)
        try:
            row = await conn.fetchrow(
                """
                INSERT INTO eidan.secrets_vault (scope, key, value_enc)
                VALUES ($1, $2, $3)
                ON CONFLICT (user_id, scope, key)
                DO UPDATE SET value_enc = EXCLUDED.value_enc
                RETURNING id, value_enc
                """,
                scope,
                subkey,
                value_enc,
            )
        finally:
            await conn.close()
        if row is None:
            return None
        if decrypt_value(bytes(row["value_enc"])) != expected:
            return None
        return str(row["id"])

    secret_id = asyncio.run(_run())
    if not secret_id:
        _console.print(
            "[red]Read-back verification failed[/red] — the stored value did "
            "not round-trip. Secret may be unusable; check the master key."
        )
        raise typer.Exit(1)
    _console.print(
        f"[green]set[/green] {scope}.{subkey} "
        f"(vault row {secret_id}) — value not shown"
    )


@secrets_app.command("list")
def secrets_list() -> None:
    """List stored secret keys (``scope.key``). Never prints values."""
    url = _need_database_url()

    async def _run() -> list:
        import asyncpg

        conn = await asyncpg.connect(url)
        try:
            return await conn.fetch(
                "SELECT scope, key, updated_at FROM eidan.secrets_vault "
                "ORDER BY scope, key"
            )
        finally:
            await conn.close()

    rows = asyncio.run(_run())
    if not rows:
        _console.print("No secrets stored.")
        return
    table = Table("key", "updated_at")
    for r in rows:
        table.add_row(f"{r['scope']}.{r['key']}", str(r["updated_at"]))
    _console.print(table)


@secrets_app.command("delete")
def secrets_delete(
    key: str = typer.Argument(..., help='Dotted key, e.g. "slack.bot_token".'),
) -> None:
    """Delete a stored secret by KEY."""
    url = _need_database_url()
    from eidan_backend.secrets import split_secret_key

    scope, subkey = split_secret_key(key)

    async def _run() -> str:
        import asyncpg

        conn = await asyncpg.connect(url)
        try:
            return await conn.execute(
                "DELETE FROM eidan.secrets_vault WHERE scope = $1 AND key = $2",
                scope,
                subkey,
            )
        finally:
            await conn.close()

    status = asyncio.run(_run())
    deleted = status.rsplit(" ", 1)[-1] if status else "0"
    if deleted == "0":
        _console.print(f"[yellow]no secret found[/yellow] for {scope}.{subkey}")
        raise typer.Exit(1)
    _console.print(f"[green]deleted[/green] {scope}.{subkey}")
