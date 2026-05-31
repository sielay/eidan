"""Entry point for the `eidan` CLI.

Two subcommand families under one binary:

- User mode (top-level): `eidan login`, `eidan logout`, `eidan repl`.
  Operates as the authenticated user; reads JWT from local keychain
  storage.
- Admin mode (`eidan admin ...`): `db migrate`, `db reset`,
  `plugin install/list/remove`. Operates as the unauthenticated
  operator process; reads DATABASE_URL and plugin-source config from
  the environment.
"""

from __future__ import annotations

import asyncio
import getpass
import os
from pathlib import Path

# Auto-load .env BEFORE anything imports backend modules so direct
# ``os.environ.get`` reads (the Alembic env.py, the Supabase OTP flow,
# the migration runner's subprocess) see the operator's config without
# requiring a manual ``source .env``. The lookup walks from the
# operator's cwd up to the repo root; the existing ``.env.example`` is
# never picked up. We don't override pre-set vars — a real CI / docker
# environment wins over a stale local .env.
from dotenv import load_dotenv as _load_dotenv

_load_dotenv(
    dotenv_path=_p if (_p := Path(os.getcwd()) / ".env").is_file() else None,
    override=False,
)
# Also try the repo root so `make repl` from a sub-directory still works.
_repo_root_env = Path(__file__).resolve().parents[3] / ".env"
if _repo_root_env.is_file():
    _load_dotenv(dotenv_path=_repo_root_env, override=False)

import typer  # noqa: E402
from rich.console import Console  # noqa: E402

from . import admin, auth_flow, doctor, lint, repl, scaffold, storage  # noqa: E402
from . import deploy as _deploy  # noqa: E402
from . import topology as _topology  # noqa: E402
from . import topology_editor as _topology_editor  # noqa: E402
from . import topology_view as _topology_view  # noqa: E402

app = typer.Typer(
    name="eidan",
    help="Eidan — self-hosted personal agent OS.",
    no_args_is_help=True,
    add_completion=False,
)


@app.callback()
def _root(
    verbose: bool = typer.Option(
        False,
        "--verbose",
        "-v",
        help="DEBUG-level logging; bumps EIDAN_LOG_LEVEL too so the backend follows.",
    ),
) -> None:
    if verbose:
        import logging

        logging.basicConfig(
            level=logging.DEBUG,
            format="%(asctime)s %(levelname)s %(name)s: %(message)s",
        )
        os.environ["EIDAN_LOG_LEVEL"] = "DEBUG"


admin_app = typer.Typer(
    name="admin",
    help="Operator-mode commands (migrations, plugin install). Env-var driven.",
    no_args_is_help=True,
    add_completion=False,
)
app.add_typer(admin_app, name="admin")

_console = Console()


# -----------------------------------------------------------------------------
# User mode
# -----------------------------------------------------------------------------


@app.command()
def login(
    email: str | None = typer.Option(
        None,
        "--email",
        "-e",
        help="Email to receive the magic link at. Must match EIDAN_AUTH_ALLOWED_EMAIL.",
    ),
    token: str | None = typer.Option(
        None,
        "--token",
        help="Paste an existing access JWT directly. Skips the magic-link round-trip.",
    ),
) -> None:
    """Sign in via Eidan's native magic-link flow.

    The CLI POSTs to ``/api/auth/magic-link`` on the backend (which
    must be running — set ``EIDAN_BACKEND_URL`` if it's not on the
    default ``http://localhost:8000``). The backend mails the
    operator a link + 6-digit code; in dev mode it also echoes both
    on the response body so the operator can paste back without
    SMTP. The CLI then POSTs ``/api/auth/verify`` with the code.
    """
    if token and email:
        _console.print(
            "[red]Pass either --email or --token, not both.[/red]"
        )
        raise typer.Exit(2)

    if token:
        storage.save(auth_flow.from_pasted_token(token))
        _console.print("[green]token stored.[/green]")
        return

    if not email:
        email = typer.prompt("email")

    async def _flow() -> None:
        try:
            response = await auth_flow.send_magic_link(email)
        except auth_flow.LoginError as exc:
            _console.print(f"[red]{exc}[/red]")
            raise typer.Exit(1) from exc
        # In dev the backend echoes the link + code on the response;
        # in production neither field is present.
        if "magic_link" in response:
            _console.print(
                f"[dim]dev: magic link {response['magic_link']}[/dim]"
            )
        if "code" in response:
            _console.print(
                f"[dim]dev: code {response['code']}[/dim]"
            )
        _console.print(
            f"sent a magic link to [cyan]{email}[/cyan]. "
            "Paste the 6-digit code from the email below."
        )
        code = getpass.getpass("code: ")
        try:
            stored = await auth_flow.verify_code(code.strip())
        except auth_flow.LoginError as exc:
            _console.print(f"[red]{exc}[/red]")
            raise typer.Exit(1) from exc
        storage.save(stored)
        _console.print(
            f"[green]signed in[/green] as "
            f"[cyan]{stored.email or email}[/cyan]."
        )

    asyncio.run(_flow())


@app.command()
def logout() -> None:
    """Discard the stored JWT."""
    storage.clear()
    _console.print("[green]signed out.[/green]")


@app.command(name="init")
def init_cmd(
    name: str | None = typer.Argument(
        None,
        help="Directory name for the new deploy config (created in cwd). "
        "Omit when passing --here.",
    ),
    here: bool = typer.Option(
        False,
        "--here",
        help="Scaffold into ./.eidan/ in the current directory (gitignored "
        "if you're inside the eidan checkout). Lighter than a sibling repo.",
    ),
    force: bool = typer.Option(
        False,
        "--force",
        help="Overwrite an existing directory at the target path.",
    ),
) -> None:
    """Scaffold a starter deploy config (topology.yml + helpers).

    Two flavours:

    - ``eidan init <name>`` — sibling directory ``./<name>/``. Useful
      if you want to keep deploy state in a private repo of its
      own. You ``git init`` it yourself.
    - ``eidan init --here`` — drops into ``./.eidan/`` of cwd.
      ``.eidan/`` is already gitignored at the eidan repo root, so
      operator-private files live alongside the source you cloned
      without polluting public history. Lighter workflow for solo
      operators.

    Either way the dir gets the same starter contents (``topology.yml``,
    ``.gitignore``, ``.vault-pass.example``, ``README.md``).
    Non-interactive — edit ``topology.yml`` by hand.
    """
    if here and name is not None:
        _console.print(
            "[red]Pass either <name> or --here, not both.[/red]"
        )
        raise typer.Exit(2)
    if not here and name is None:
        _console.print(
            "[red]Pass a <name> (e.g. `eidan init my-deployment`) or "
            "--here to scaffold into ./.eidan/.[/red]"
        )
        raise typer.Exit(2)

    try:
        target = scaffold.scaffold(name, force=force, here=here)
    except scaffold.ScaffoldTargetExists as exc:
        _console.print(f"[red]{exc}[/red]")
        raise typer.Exit(1) from exc
    except scaffold.ScaffoldError as exc:
        _console.print(f"[red]scaffold failed:[/red] {exc}")
        raise typer.Exit(1) from exc

    _console.print(
        f"[green]scaffolded[/green] at [cyan]{target}[/cyan]"
    )
    _console.print()
    _console.print("[bold]Next steps:[/bold]")
    if here:
        _console.print("  $EDITOR .eidan/topology.yml   # fill in your nodes")
        _console.print(
            "  cp .eidan/.vault-pass.example .eidan/.vault-pass && "
            "chmod 0600 .eidan/.vault-pass"
        )
        _console.print(
            "  ansible-vault encrypt_string --vault-id default@.eidan/.vault-pass \\"
        )
        _console.print(
            "    'your-secret' --name 'auth_master_key'    # paste into .eidan/topology.yml"
        )
        _console.print(
            "  eidan deploy --topology .eidan/topology.yml   # reconcile every node"
        )
    else:
        _console.print(f"  cd {name}")
        _console.print("  $EDITOR topology.yml          # fill in your nodes")
        _console.print("  cp .vault-pass.example .vault-pass && chmod 0600 .vault-pass")
        _console.print(
            "  ansible-vault encrypt_string --vault-id default@.vault-pass \\"
        )
        _console.print(
            "    'your-secret' --name 'auth_master_key'    # paste into topology.yml"
        )
        _console.print("  git init && git add . && git commit -m 'initial topology'")
        _console.print("  eidan deploy                  # reconcile every node")


@app.command(name="deploy")
def deploy_cmd(
    node: str | None = typer.Option(
        None,
        "--node",
        "-n",
        help="Reconcile just this node. Default: reconcile every node in the topology.",
    ),
    topology: Path | None = typer.Option(  # noqa: B008
        None,
        "--topology",
        "-t",
        help="Path to the topology file. Default: auto-discover "
        "./.eidan/topology.yml then ./topology.yml.",
    ),
    tags: list[str] = typer.Option(  # noqa: B008
        [],
        "--tags",
        help="Pass-through to ansible-playbook --tags. Repeat for multiple.",
    ),
    dry_run: bool = typer.Option(
        False,
        "--dry-run",
        help="ansible-playbook --check --diff: show what would change.",
    ),
    ask_vault_pass: bool = typer.Option(
        False,
        "--ask-vault-pass",
        help="Prompt for the ansible-vault password to decrypt topology secrets.",
    ),
) -> None:
    """Reconcile every node (or one) in the topology to its declared state.

    Reads ``topology.yml`` (or the path passed via ``--topology``),
    dispatches each node to the right per-target reconciler.
    Pi and Fly targets are wired up; Docker is a follow-up.

    Topology auto-discovery: when ``--topology`` is not passed, the
    CLI looks for ``./.eidan/topology.yml`` first (the in-checkout
    workflow shipped by ``eidan init --here``), then falls back to
    ``./topology.yml`` (sibling-directory workflow shipped by
    ``eidan init <name>``). Pass ``--topology`` explicitly to point
    at any other path.
    """
    if topology is None:
        in_checkout = Path(".eidan/topology.yml")
        sibling = Path("topology.yml")
        if in_checkout.is_file():
            topology = in_checkout
        elif sibling.is_file():
            topology = sibling
        else:
            _console.print(
                "[red]no topology.yml found.[/red] Looked at "
                f"{in_checkout} and {sibling}. Run `eidan init --here` "
                "to scaffold one, or pass --topology <path>."
            )
            raise typer.Exit(2)
    raise typer.Exit(
        _deploy.deploy(
            topology,
            node=node,
            tags=tags or None,
            dry_run=dry_run,
            ask_vault_pass=ask_vault_pass,
        )
    )


# -----------------------------------------------------------------------------
# Topology mutation + inspection (`eidan plugin`, `eidan node`)
# -----------------------------------------------------------------------------
# NOTE: distinct from `eidan admin plugin install/list/remove`, which
# operates on a running install's plugin tree. The commands here mutate
# the operator's topology.yml file in their ops repo.

plugin_topology_app = typer.Typer(
    name="plugin",
    help="Topology-side plugin commands (enable/disable per node).",
    no_args_is_help=True,
    add_completion=False,
)
node_app = typer.Typer(
    name="node",
    help="Topology inspection (`eidan node list`, `eidan node show <name>`).",
    no_args_is_help=True,
    add_completion=False,
)
app.add_typer(plugin_topology_app, name="plugin")
app.add_typer(node_app, name="node")


_DEFAULT_TOPOLOGY_PATH = Path("topology.yml")


@plugin_topology_app.command("disable")
def plugin_disable_cmd(
    plugin: str = typer.Argument(..., help="Plugin slug to disable."),
    node: str = typer.Option(..., "--node", "-n", help="Node name."),
    topology: Path = typer.Option(  # noqa: B008
        _DEFAULT_TOPOLOGY_PATH,
        "--topology",
        "-t",
        help="Path to topology.yml (default: ./topology.yml).",
    ),
) -> None:
    """Add ``plugin`` to ``nodes.<node>.disable`` in topology.yml.

    Mutates the file in place; comments and formatting are preserved.
    The next ``eidan deploy --node <node>`` renders the updated
    ``EIDAN_DISABLED_PLUGINS`` env var on the target host.
    """
    try:
        changed = _topology_editor.disable_plugin(
            topology, node_name=node, plugin=plugin
        )
    except _topology_editor.TopologyEditUnknownNode as exc:
        _console.print(f"[red]{exc}[/red]")
        raise typer.Exit(2) from exc
    except _topology_editor.TopologyEditError as exc:
        _console.print(f"[red]{exc}[/red]")
        raise typer.Exit(1) from exc
    if changed:
        _console.print(
            f"[green]disabled[/green] {plugin!r} on node [cyan]{node}[/cyan]"
        )
        _console.print(
            f"[dim]run `eidan deploy --node {node}` to apply on the host.[/dim]"
        )
    else:
        _console.print(
            f"[yellow]{plugin!r} already disabled on node {node!r}; no change[/yellow]"
        )


@plugin_topology_app.command("enable")
def plugin_enable_cmd(
    plugin: str = typer.Argument(..., help="Plugin slug to enable."),
    node: str = typer.Option(..., "--node", "-n", help="Node name."),
    topology: Path = typer.Option(  # noqa: B008
        _DEFAULT_TOPOLOGY_PATH,
        "--topology",
        "-t",
        help="Path to topology.yml (default: ./topology.yml).",
    ),
) -> None:
    """Remove ``plugin`` from ``nodes.<node>.disable`` in topology.yml.

    No-op if the plugin wasn't disabled. Mutation is local to the
    topology file — actual host state is updated on the next
    ``eidan deploy --node <node>``.
    """
    try:
        changed = _topology_editor.enable_plugin(
            topology, node_name=node, plugin=plugin
        )
    except _topology_editor.TopologyEditUnknownNode as exc:
        _console.print(f"[red]{exc}[/red]")
        raise typer.Exit(2) from exc
    except _topology_editor.TopologyEditError as exc:
        _console.print(f"[red]{exc}[/red]")
        raise typer.Exit(1) from exc
    if changed:
        _console.print(
            f"[green]enabled[/green] {plugin!r} on node [cyan]{node}[/cyan]"
        )
        _console.print(
            f"[dim]run `eidan deploy --node {node}` to apply on the host.[/dim]"
        )
    else:
        _console.print(
            f"[yellow]{plugin!r} not in disable list on node {node!r}; no change[/yellow]"
        )


@node_app.command("list")
def node_list_cmd(
    topology: Path = typer.Option(  # noqa: B008
        _DEFAULT_TOPOLOGY_PATH,
        "--topology",
        "-t",
        help="Path to topology.yml (default: ./topology.yml).",
    ),
) -> None:
    """Print a table of every node — name, target, bundles, disabled plugins."""
    try:
        loaded = _topology.load_topology(topology)
    except _topology.TopologyError as exc:
        _console.print(f"[red]{exc}[/red]")
        raise typer.Exit(2) from exc
    _topology_view.render_node_list(loaded, console=_console)


@node_app.command("show")
def node_show_cmd(
    name: str = typer.Argument(..., help="Node name to show."),
    topology: Path = typer.Option(  # noqa: B008
        _DEFAULT_TOPOLOGY_PATH,
        "--topology",
        "-t",
        help="Path to topology.yml (default: ./topology.yml).",
    ),
) -> None:
    """Print one node's fully-resolved view (defaults merged in)."""
    try:
        loaded = _topology.load_topology(topology)
        node = loaded.resolve_node(name)
    except _topology.TopologyError as exc:
        _console.print(f"[red]{exc}[/red]")
        raise typer.Exit(2) from exc
    _topology_view.render_node_show(node, console=_console)


@app.command(name="debug-auth")
def debug_auth() -> None:
    """Decode the stored access token (unverified) and dump its claims.

    Use this when `eidan repl` rejects the stored token — it surfaces
    the header + claims so the operator can confirm whether the token
    was issued by the running backend (``iss=eidan`` / ``aud=eidan``)
    and whether ``exp`` is still in the future.
    """
    import json
    import time
    from datetime import UTC, datetime

    from jose import jwt as jose_jwt
    from jose.exceptions import JOSEError

    auth = storage.load()
    if not auth:
        _console.print(
            "[red]No stored token.[/red] Run `eidan login` first."
        )
        raise typer.Exit(1)

    try:
        header = jose_jwt.get_unverified_header(auth.access_token)
        claims = jose_jwt.get_unverified_claims(auth.access_token)
    except JOSEError as exc:
        _console.print(f"[red]Failed to decode token:[/red] {exc}")
        raise typer.Exit(1) from exc

    _console.print("[bold]Stored token — header[/bold]")
    _console.print(json.dumps(header, indent=2))
    _console.print()
    _console.print("[bold]Stored token — claims[/bold]")
    _console.print(json.dumps(claims, indent=2, default=str))

    exp = claims.get("exp")
    if isinstance(exp, int):
        delta = exp - int(time.time())
        when = datetime.fromtimestamp(exp, tz=UTC).isoformat()
        if delta < 0:
            _console.print(
                f"[yellow]⚠ token expired {-delta}s ago ({when})[/yellow]"
            )
        else:
            _console.print(f"[dim]exp: {when} (in {delta}s)[/dim]")

    _console.print()
    _console.print("[bold]Configured (env)[/bold]")
    env_keys = (
        "EIDAN_BACKEND_URL",
        "EIDAN_AUTH_ALLOWED_EMAIL",
    )
    for k in env_keys:
        _console.print(f"  {k}={os.environ.get(k, '<unset>')}")

    issues: list[str] = []
    actual_iss = claims.get("iss")
    if actual_iss != "eidan":
        issues.append(
            f"iss is {actual_iss!r}; native tokens carry 'eidan'."
        )
    actual_aud = claims.get("aud")
    if actual_aud != "eidan":
        issues.append(
            f"aud is {actual_aud!r}; native tokens carry 'eidan'."
        )

    _console.print()
    if issues:
        for line in issues:
            _console.print(f"[yellow]⚠ {line}[/yellow]")
        _console.print(
            "\n[dim]Token doesn't look like one issued by this "
            "backend. Run `eidan logout` then `eidan login` to "
            "claim a fresh one.[/dim]"
        )
    else:
        _console.print(
            "[green]iss + aud align with the native issuer.[/green] "
            "If the REPL still rejects the token, the signing keypair "
            "has rotated — sign in again."
        )


@app.command(name="repl")
def repl_cmd() -> None:
    """Open an interactive REPL against the agent loop."""
    raise typer.Exit(repl.main())


@app.command(name="seance")
def seance_cmd(
    list_: bool = typer.Option(
        False,
        "--list",
        help="List candidate predecessor conversations and exit.",
    ),
    conv: str | None = typer.Option(
        None,
        "--conv",
        help="Conversation id (uuid) to consult. Required unless --list.",
    ),
    prompt: str | None = typer.Option(
        None,
        "-p",
        "--prompt",
        help=(
            "Question to ask of the predecessor conversation. "
            "Pass '-' to read from stdin."
        ),
    ),
    limit: int = typer.Option(
        20,
        "--limit",
        help="Maximum conversations to surface with --list (default 20).",
    ),
    email: str | None = typer.Option(
        None,
        "--email",
        help=(
            "Operate on the user with this email. Default: the single "
            "user in eidan.users (single-operator install)."
        ),
    ),
) -> None:
    """Predecessor-session lookup ("seance") per `docs/023`.

    One-shot mode: ``--conv <id> -p "<question>"`` loads the
    conversation's transcript and asks the model your question with
    that transcript as context. Prints the answer to stdout.

    Discovery mode: ``--list`` prints recent conversations the
    operator can target.
    """
    from . import seance

    if list_:
        raise typer.Exit(seance.seance_list(email=email, limit=limit))
    if not conv or not prompt:
        typer.echo(
            "Usage: eidan seance --list  |  eidan seance --conv <id> -p '<q>'",
            err=True,
        )
        raise typer.Exit(2)
    raise typer.Exit(seance.seance_ask(conv=conv, prompt=prompt, email=email))


# -----------------------------------------------------------------------------
# Admin mode
# -----------------------------------------------------------------------------


db_app = typer.Typer(
    name="db",
    help="Database operations.",
    no_args_is_help=True,
    add_completion=False,
)
plugin_app = typer.Typer(
    name="plugin",
    help="Plugin install / list / remove / lint.",
    no_args_is_help=True,
    add_completion=False,
)
agent_app = typer.Typer(
    name="agent",
    help="Inspect / edit the per-user agent_context row (persona overrides).",
    no_args_is_help=True,
    add_completion=False,
)
release_app = typer.Typer(
    name="release",
    help="Release-time checks (forbidden-string gate, etc.).",
    no_args_is_help=True,
    add_completion=False,
)
admin_app.add_typer(db_app, name="db")
admin_app.add_typer(plugin_app, name="plugin")
admin_app.add_typer(agent_app, name="agent")
admin_app.add_typer(release_app, name="release")


@db_app.command("migrate")
def admin_db_migrate() -> None:
    raise typer.Exit(admin.db_migrate())


@db_app.command("reset")
def admin_db_reset() -> None:
    raise typer.Exit(admin.db_reset())


@plugin_app.command("install")
def admin_plugin_install(
    bundle: str | None = typer.Argument(
        None, help="Bundle name (when installing from GitHub)."
    ),
    from_dir: str | None = typer.Option(
        None,
        "--from-dir",
        help="Install from a local directory of checked-out bundle repos "
        "(useful during plugin development). Overrides EIDAN_PLUGIN_SOURCE.",
    ),
    force: bool = typer.Option(
        False,
        "--force",
        help="Overwrite an existing plugins/<name>/ directory.",
    ),
) -> None:
    """Install a paid bundle. See `eidan_cli.admin:plugin_install`."""
    raise typer.Exit(admin.plugin_install(bundle, from_dir, force=force))


@plugin_app.command("list")
def admin_plugin_list() -> None:
    """List installed plugins. See `eidan_cli.admin:plugin_list`."""
    raise typer.Exit(admin.plugin_list())


@plugin_app.command("remove")
def admin_plugin_remove(
    target: str | None = typer.Argument(
        None,
        help="Bundle name (matches manifest `bundle.name`) or single plugin name.",
    ),
) -> None:
    """Uninstall a bundle or single plugin. See `eidan_cli.admin:plugin_remove`."""
    raise typer.Exit(admin.plugin_remove(target))


@plugin_app.command("sync")
def admin_plugin_sync(
    dry_run: bool = typer.Option(
        False,
        "--dry-run",
        help="Print the plan but make no changes.",
    ),
    prune: bool = typer.Option(
        False,
        "--prune",
        help="Also remove plugins on disk that are not in plugins/.lock "
        "(only plugins shipped in a bundle — repo-shipped core is never pruned).",
    ),
) -> None:
    """Reconcile plugins/.lock against the installed tree.

    See ``eidan_cli.admin:plugin_sync``.
    """
    raise typer.Exit(admin.plugin_sync(dry_run=dry_run, prune=prune))


@plugin_app.command("lint")
def admin_plugin_lint(
    name: str | None = typer.Argument(
        None,
        help="Plugin slug to lint. Omit and pass --all to lint every installed plugin.",
    ),
    all_: bool = typer.Option(
        False,
        "--all",
        help="Lint every plugin under plugins/.",
    ),
) -> None:
    """Lint a plugin's manifest + sources. See `eidan_cli.lint:plugin_lint`."""
    raise typer.Exit(lint.plugin_lint(name, all_))


@agent_app.command("show")
def admin_agent_show(
    email: str | None = typer.Option(
        None,
        "--email",
        help="Operate on the user with this email. Default: the single user.",
    ),
) -> None:
    """Print the resolved user's default agent_context row + effective persona."""
    raise typer.Exit(admin.agent_show(email))


@agent_app.command("set-persona")
def admin_agent_set_persona(
    persona: str | None = typer.Argument(
        None,
        help="Persona prompt text. Pass '-' to read it from stdin.",
    ),
    email: str | None = typer.Option(
        None,
        "--email",
        help="Operate on the user with this email. Default: the single user.",
    ),
) -> None:
    """Set user_overrides.system_prompt for the resolved user's default agent."""
    raise typer.Exit(admin.agent_set_persona(persona, email))


@agent_app.command("clear-persona")
def admin_agent_clear_persona(
    email: str | None = typer.Option(
        None,
        "--email",
        help="Operate on the user with this email. Default: the single user.",
    ),
) -> None:
    """Remove user_overrides.system_prompt for the resolved user's default agent."""
    raise typer.Exit(admin.agent_clear_persona(email))


@release_app.command("sanitise")
def admin_release_sanitise(
    dry_run: bool = typer.Option(
        True,
        "--dry-run/--enforce",
        help=(
            "Dry-run prints hits and exits 0 (default — operator inspection). "
            "--enforce returns non-zero on any hit so the runbook can abort."
        ),
    ),
) -> None:
    """Run the forbidden-string gate from `docs/016 §3.6` locally."""
    raise typer.Exit(admin.release_sanitise(dry_run=dry_run))


@admin_app.command("doctor")
def admin_doctor() -> None:
    """Verify the operator's install — env vars, DB, JWKS, migrations, plugins."""
    raise typer.Exit(doctor.doctor())


@admin_app.command("server")
def admin_server(
    host: str | None = typer.Option(
        None,
        "--host",
        help="Bind address. Overrides EIDAN_HTTP_HOST.",
    ),
    port: int | None = typer.Option(
        None,
        "--port",
        "-p",
        help="Bind port. Overrides EIDAN_HTTP_PORT.",
    ),
) -> None:
    """Start the FastAPI backend (the HTTP surface for the web UI)."""
    from eidan_backend.http.server import run

    run(host=host, port=port)


if __name__ == "__main__":
    app()
