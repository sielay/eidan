# SPDX-License-Identifier: AGPL-3.0-or-later
"""Interactive CLI surfaces — menu + `eidan init` wizard.

This module is the "no flags? talk to me" half of the CLI. The
flag-driven typer commands in :mod:`eidan_cli.main` keep working
unchanged — scripts still pass ``--node fly-prod`` and don't see
a prompt. What this module adds:

- :func:`run_menu` — top-level discoverable picker. Operators who
  run plain ``eidan`` get a list of things they can do. Selected
  options route back into the typer command graph.
- :func:`run_init_wizard` — guided ``eidan init`` flow that
  collects a single-node topology by prompting field-by-field and
  writes ``.eidan/topology.yml`` with the resolved values.

Wizard scope today: single-node, write-once. The operator can
re-run the wizard or hand-edit the resulting YAML for multi-node
setups. The follow-up slice in #104 adds a node-add subcommand
that walks through additional nodes without re-asking the global
fields. Live connection probes (Postgres ping, provider test
call) are also deferred — they'd pull asyncpg/anthropic into the
CLI process hot path, and the cost-of-mistake here is low (the
operator runs ``eidan deploy`` next, which surfaces config
errors loudly).

We use ``questionary`` rather than rolling our own prompts on
top of ``rich``. The contract is small (select / text / password /
checkbox / confirm), and ``questionary`` already handles arrow-
key navigation, ANSI redraws, and Ctrl-C cancellation across the
terminals operators actually use.
"""

from __future__ import annotations

import re
import secrets
import urllib.parse as _urlparse
from pathlib import Path
from typing import TYPE_CHECKING, Any

import questionary

from . import scaffold

if TYPE_CHECKING:
    from collections.abc import Callable


# Fallback bundle slugs when we can't reach GitHub via `gh`. The
# wizard prefers a live `gh repo list` so the operator sees the
# bundles their auth can actually see; this list is the last resort
# for offline / un-authed laptops.
_FALLBACK_BUNDLES = (
    "eidan-pro",
    "eidan-lifestyle",
    "eidan-business",
    "eidan-coding",
    "eidan-canary",
)

# Default GitHub org to query for `eidan-*` bundle repos. Operators
# forking to their own org can edit topology.yml afterward.
_DEFAULT_BUNDLE_ORG = "sielay"

# Provider names + the env-var key each one's api_key lands in for
# the rendered topology. Ollama is the no-key case — local model
# server, no auth.
_PROVIDERS = {
    "anthropic": "Anthropic (Claude)",
    "openai": "OpenAI (GPT)",
    "gemini": "Google Gemini",
    "mistral": "Mistral",
    "ollama": "Ollama (local, no API key)",
}

# Default model per provider — sane starting points for a brand-new
# operator. They can edit topology.yml afterward.
_DEFAULT_MODELS = {
    "anthropic": "claude-sonnet-4-6",
    "openai": "gpt-4o-mini",
    "gemini": "gemini-1.5-flash",
    "mistral": "mistral-small-latest",
    "ollama": "phi3",
}


def _generate_master_key() -> str:
    """Mint a fresh EIDAN_AUTH_MASTER_KEY. Same shape as the manual
    ``python3 -c "import secrets; print(secrets.token_urlsafe(48))"``
    step the bootstrap docs used to recommend."""
    return secrets.token_urlsafe(48)


def _ask(prompt: questionary.Question) -> Any:
    """Run a questionary prompt; raise :class:`InteractiveCancelled`
    when the user hits Ctrl-C. ``questionary`` returns ``None`` on
    Ctrl-C and on Ctrl-D in some terminals — we treat both as
    "cancelled" so the caller bails out cleanly rather than writing
    a half-collected topology."""
    answer = prompt.ask()
    if answer is None:
        raise InteractiveCancelled
    return answer


class InteractiveCancelled(Exception):
    """The operator hit Ctrl-C (or Ctrl-D) during a prompt. The
    caller catches this and exits with a friendly "cancelled"
    message instead of a traceback."""


def run_menu(
    *,
    on_init: Callable[[], None],
    on_deploy: Callable[[], None],
    on_plugin: Callable[[], None],
    on_node: Callable[[], None],
) -> None:
    """Top-level interactive menu. Each callback is the existing
    typer command's interactive entry — the menu never bypasses
    typer's argument-validation guarantees.

    Callbacks rather than direct command invocation so this module
    stays free of a hard dependency on ``main.py`` (which imports
    everything; circular imports would bite). The caller in
    :mod:`eidan_cli.main` wires the routes."""
    try:
        choice = _ask(
            questionary.select(
                "What would you like to do?",
                choices=[
                    questionary.Choice(
                        "Set up a new deployment (eidan init)", "init"
                    ),
                    questionary.Choice(
                        "Deploy to configured nodes (eidan deploy)", "deploy"
                    ),
                    questionary.Choice(
                        "Manage plugins on a node (eidan plugin)", "plugin"
                    ),
                    questionary.Choice(
                        "Inspect / manage nodes (eidan node)", "node"
                    ),
                    questionary.Choice("Exit", "exit"),
                ],
            )
        )
    except InteractiveCancelled:
        return
    if choice == "exit":
        return
    routes = {
        "init": on_init,
        "deploy": on_deploy,
        "plugin": on_plugin,
        "node": on_node,
    }
    routes[choice]()


def _ask_target(default: str | None = None) -> str:
    """Pick a deploy target. Two real options today (pi / fly)
    plus a future "docker" stub we don't ship a reconciler for yet
    — surface only the supported pair."""
    return _ask(
        questionary.select(
            "Where will this deployment run?",
            choices=[
                questionary.Choice(
                    "Raspberry Pi / always-on Linux box (target: pi)", "pi"
                ),
                questionary.Choice(
                    "Fly.io app (target: fly)", "fly"
                ),
            ],
            default=default,
        )
    )


def _default_ssh_key_path() -> str:
    """Pick the operator's most likely SSH private-key path.

    Walks ``~/.ssh/`` looking for canonical key names. Prefers
    ``id_ed25519`` (modern + recommended), then ``id_rsa`` (still
    widely used), then ECDSA / DSA. Returns the FIRST existing key
    as ``~/.ssh/<name>`` so questionary can display it tilde-style.

    If none of the canonical files exist yet, returns the
    ``id_ed25519`` placeholder so the prompt at least suggests the
    modern shape.
    """
    home = Path.home()
    for name in ("id_ed25519", "id_rsa", "id_ecdsa", "id_dsa"):
        if (home / ".ssh" / name).is_file():
            return f"~/.ssh/{name}"
    return "~/.ssh/id_ed25519"


def _ask_pi_fields() -> dict[str, Any]:
    """Pi-specific topology fields. Keys map 1:1 to the topology
    schema so the caller can splat the dict into the node dict."""
    host = _ask(
        questionary.text(
            "Pi hostname or IP (e.g. 192.168.1.100 or kasha.local):",
            validate=lambda s: bool(s.strip())
            or "hostname is required",
        )
    )
    ssh_user = _ask(
        questionary.text(
            "SSH user on the Pi (the sudoer account, NOT the eidan service user):",
            default="pi",
            validate=lambda s: bool(s.strip()) or "ssh_user is required",
        )
    )
    ssh_key = _ask(
        questionary.text(
            "SSH private key path (leave blank to use your default agent):",
            default=_default_ssh_key_path(),
        )
    )
    out: dict[str, Any] = {
        "host": host.strip(),
        "ssh_user": ssh_user.strip(),
    }
    if ssh_key.strip():
        out["ssh_key"] = ssh_key.strip()
    return out


def _fly_app_exists(app: str) -> bool | None:
    """Return ``True`` if ``app`` is in the operator's ``fly apps list``,
    ``False`` if Fly says it doesn't exist, ``None`` if we can't tell
    (``fly`` missing on PATH, auth not configured, network blip).

    The ``None`` case is deliberately distinct from ``False`` — when
    we can't probe, we shouldn't offer to create either. Falling
    back to the manual instruction is honest.
    """
    import shutil
    import subprocess

    if shutil.which("fly") is None:
        return None
    try:
        result = subprocess.run(  # noqa: S603
            ["fly", "apps", "list", "--json"],
            capture_output=True,
            text=True,
            check=False,
            timeout=15,
        )
    except (subprocess.TimeoutExpired, OSError):
        return None
    if result.returncode != 0:
        # Most common cause: `fly auth login` not done. Surface the
        # stderr so the operator sees the actual reason; return None
        # so the caller falls back to manual instructions.
        if result.stderr.strip():
            questionary.print(
                f"  (could not check Fly: {result.stderr.strip().splitlines()[0]})",
                style="fg:#888888",
            )
        return None
    try:
        import json as _json

        apps = _json.loads(result.stdout or "[]")
    except _json.JSONDecodeError:
        return None
    return any(
        isinstance(entry, dict) and entry.get("Name") == app
        for entry in apps
    )


def _create_fly_app(app: str, org: str) -> bool:
    """Run ``fly apps create <app> --org <org>``. Returns ``True`` on
    success, ``False`` if Fly refused (e.g. name already taken by
    another account in Fly's global namespace). stdout/stderr stream
    through so the operator sees the create progress + any error
    inline."""
    import subprocess

    result = subprocess.run(  # noqa: S603
        ["fly", "apps", "create", app, "--org", org],
        check=False,
    )
    return result.returncode == 0


def _ensure_fly_app(app: str) -> None:
    """If ``app`` doesn't exist on Fly, offer to create it. Best-
    effort: if we can't probe (``fly`` missing, not logged in), fall
    back to the manual instruction with the exact command. We never
    create silently — every ``fly apps create`` is gated on an
    explicit operator yes."""
    exists = _fly_app_exists(app)
    if exists is True:
        return
    if exists is None:
        questionary.print(
            f"  (couldn't probe Fly; ensure the app exists before deploy: "
            f"fly apps create {app})",
            style="fg:#888888",
        )
        return
    create = _ask(
        questionary.confirm(
            f"Fly app {app!r} doesn't exist. Create it now?",
            default=True,
        )
    )
    if not create:
        questionary.print(
            f"  (skipped; create manually before deploy: fly apps create {app})",
            style="fg:#888888",
        )
        return
    org = _ask(
        questionary.text(
            "Fly org slug (press enter for 'personal'):",
            default="personal",
        )
    ).strip() or "personal"
    if not _create_fly_app(app, org):
        questionary.print(
            "  (`fly apps create` failed; check the output above and "
            "either pick a different name or create manually)",
            style="fg:#ff8800",
        )


def _ask_fly_fields() -> dict[str, Any]:
    """Fly-specific topology fields. ``app`` + ``region`` are required;
    ``cors_origins`` is required IF the operator is hosting a
    browser-facing frontend (Vercel, GitHub Pages, custom domain)
    that calls the backend's API — without it the browser drops
    every cross-origin response with a CORS error.

    If the named app doesn't exist on Fly yet, we offer to create
    it inline rather than send the operator off to run
    ``fly apps create`` themselves."""
    app = _ask(
        questionary.text(
            "Fly app name:",
            validate=lambda s: bool(s.strip()) or "app name is required",
        )
    ).strip()
    _ensure_fly_app(app)
    region = _ask(
        questionary.text(
            "Fly region code (e.g. lhr, fra, ord — see `fly platform regions`):",
            default="lhr",
            validate=lambda s: bool(s.strip()) or "region is required",
        )
    )
    cors_origins_raw = _ask(
        questionary.text(
            "Browser frontend origins for CORS "
            "(comma-separated; e.g. https://app.example.com,https://www.example.com). "
            "Leave empty if you'll only hit the API directly (curl / CLI):",
            default="",
        )
    )
    out: dict[str, Any] = {"app": app, "region": region.strip()}
    cors_list = [
        # Strip trailing `/` here too: operators paste browser
        # URLs with the slash, but CORS comparisons happen against
        # the browser's Origin header which never includes it.
        origin.strip().rstrip("/")
        for origin in cors_origins_raw.split(",")
        if origin.strip()
    ]
    if cors_list:
        out["cors_origins"] = cors_list
    return out


def _ask_provider() -> dict[str, Any]:
    """LLM provider + (where applicable) API key + default model."""
    name = _ask(
        questionary.select(
            "Which LLM provider?",
            choices=[
                questionary.Choice(label, value)
                for value, label in _PROVIDERS.items()
            ],
            default="anthropic",
        )
    )
    provider: dict[str, Any] = {
        "name": name,
        "default_model": _DEFAULT_MODELS[name],
    }
    if name != "ollama":
        api_key = _ask(
            questionary.password(
                f"{_PROVIDERS[name]} API key (input hidden):",
                validate=lambda s: bool(s.strip())
                or "api_key is required for non-ollama providers",
            )
        )
        provider["api_key"] = api_key.strip()
    default_model = _ask(
        questionary.text(
            f"Default model (press enter for {_DEFAULT_MODELS[name]}):",
            default=_DEFAULT_MODELS[name],
        )
    )
    provider["default_model"] = default_model.strip() or _DEFAULT_MODELS[name]
    return provider


def _list_eidan_bundles(org: str) -> list[str] | None:
    """Query GitHub via ``gh repo list <org> --json name`` for
    ``eidan-*`` repos the operator's auth can see.

    Returns the filtered + sorted list, or ``None`` when we can't
    reach GitHub (``gh`` missing on PATH, ``gh auth login`` not
    done, network blip). The caller falls back to a static list in
    those cases.
    """
    import shutil
    import subprocess

    if shutil.which("gh") is None:
        return None
    try:
        result = subprocess.run(  # noqa: S603
            ["gh", "repo", "list", org, "--limit", "100", "--json", "name"],
            capture_output=True,
            text=True,
            check=False,
            timeout=15,
        )
    except (subprocess.TimeoutExpired, OSError):
        return None
    if result.returncode != 0:
        return None
    try:
        import json as _json

        repos = _json.loads(result.stdout or "[]")
    except _json.JSONDecodeError:
        return None
    names = [
        r["name"]
        for r in repos
        if isinstance(r, dict) and isinstance(r.get("name"), str)
    ]
    # Filter: `eidan-*` slugs, excluding the landing site (not a
    # bundle) and `eidan` itself (the core repo). Stable sort so
    # the operator sees the same order across runs.
    return sorted(
        n for n in names
        if n.startswith("eidan-") and n != "eidan-landing"
    )


def _ask_bundles() -> list[str]:
    """Multi-select bundles. The list comes from ``gh repo list``
    so we offer exactly the bundle repos the operator's GitHub
    auth can see — no false promises about closed-source bundles
    they don't have access to. Falls back to a static list when
    ``gh`` is unavailable. Empty list is fine — core-only deploy."""
    bundles = _list_eidan_bundles(_DEFAULT_BUNDLE_ORG)
    if bundles is None:
        bundles = list(_FALLBACK_BUNDLES)
        questionary.print(
            f"  (gh CLI unavailable; offering the default "
            f"{_DEFAULT_BUNDLE_ORG}/* list. Run `gh auth login` to "
            "see your account's actual access.)",
            style="fg:#888888",
        )
    if not bundles:
        questionary.print(
            f"  (no eidan-* repos found on {_DEFAULT_BUNDLE_ORG}; "
            "pick none for a core-only deploy)",
            style="fg:#888888",
        )
        return []
    selected = _ask(
        questionary.checkbox(
            "Which paid bundles do you want to install? "
            "(space to toggle, enter to confirm; pick none for a "
            "core-only deploy)",
            choices=[
                questionary.Choice(name, name) for name in bundles
            ],
        )
    )
    return list(selected)


def _ask_database_url() -> str:
    """Collect Postgres connection parameters as separate fields and
    assemble the asyncpg URL.

    Hides the password so the operator can dictate it into a
    password manager without it appearing in their terminal
    scrollback. URL-encodes the password so chars like ``@`` /
    ``:`` / ``#`` don't break the URL parser downstream.
    """
    host = _ask(
        questionary.text(
            "Postgres host:",
            default="127.0.0.1",
            validate=lambda s: bool(s.strip()) or "host is required",
        )
    ).strip()
    port = _ask(
        questionary.text(
            "Postgres port:",
            default="5432",
            validate=lambda s: s.strip().isdigit() or "port must be numeric",
        )
    ).strip()
    database = _ask(
        questionary.text(
            "Postgres database name:",
            default="eidan",
            validate=lambda s: bool(s.strip()) or "database is required",
        )
    ).strip()
    user = _ask(
        questionary.text(
            "Postgres user:",
            default="eidan_app",
            validate=lambda s: bool(s.strip()) or "user is required",
        )
    ).strip()
    password = _ask(
        questionary.password(
            "Postgres password (hidden — record it in a password manager now):",
            validate=lambda s: bool(s) or "password is required",
        )
    )
    pw_quoted = _urlparse.quote_plus(password)
    return f"postgresql+asyncpg://{user}:{pw_quoted}@{host}:{port}/{database}"


def _read_existing_master_key(topology_path: Path) -> str | None:
    """If ``topology.yml`` exists and carries an ``auth_master_key:``
    line, return its value so the wizard can offer to reuse it.

    Naive regex parse — the wizard always writes the key as a
    plain or double-quoted scalar on its own line. Operators who
    hand-edited the file to a ``!vault`` encrypted form get
    ``None`` back (we can't decrypt mid-wizard); they're prompted
    to paste the plaintext key, and the operator can re-vault it
    afterward. Placeholder values from a stub-only scaffold also
    return ``None``.
    """
    if not topology_path.is_file():
        return None
    try:
        body = topology_path.read_text(encoding="utf-8")
    except OSError:
        return None
    match = re.search(
        r'^\s*auth_master_key:\s*(?:"([^"]+)"|(\S+))',
        body,
        re.MULTILINE,
    )
    if not match:
        return None
    value = (match.group(1) or match.group(2) or "").strip()
    if value in ("", "REPLACE-WITH-secrets.token_urlsafe-48"):
        return None
    if value.startswith("!"):
        # ansible-vault encrypted scalar; can't reuse from here.
        return None
    return value


def _ask_auth(existing_key: str | None) -> tuple[str, str, bool]:
    """Returns ``(master_key, email, key_is_freshly_generated)``.

    The ``key_is_freshly_generated`` flag tells the caller whether
    to display the "record this offline" reminder — only true for
    a brand-new key the operator hasn't seen before.

    Behaviour:
    - If ``existing_key`` is set (re-running the wizard on an
      existing topology, OR the operator preserved a prior init's
      output), default to reusing it.
    - Otherwise the operator picks between generating a new key
      (single-node deploy or first-of-many) and pasting an
      existing key (the node joins an existing deployment).
    """
    email = _ask(
        questionary.text(
            "Operator email (the single account allowed to log in):",
            validate=lambda s: "@" in s.strip()
            or "looks like an email is required here",
        )
    ).strip()

    if existing_key:
        reuse = _ask(
            questionary.confirm(
                "Existing master key found in topology.yml — reuse it? "
                "(say no to enter a different key or generate a new one)",
                default=True,
            )
        )
        if reuse:
            return existing_key, email, False

    source = _ask(
        questionary.select(
            "Master key for this deployment:",
            choices=[
                questionary.Choice(
                    "Generate a new key (single-node deploy or first of many)",
                    "generate",
                ),
                questionary.Choice(
                    "Paste an existing key (this node joins an existing deployment)",
                    "paste",
                ),
            ],
            default="generate",
        )
    )
    if source == "generate":
        return _generate_master_key(), email, True
    pasted = _ask(
        questionary.password(
            "Paste the existing master key (input hidden):",
            validate=lambda s: bool(s.strip()) or "master key is required",
        )
    ).strip()
    return pasted, email, False


def _format_yaml_value(value: Any) -> str:
    """Quote a value for safe YAML output. We deliberately avoid
    pulling in PyYAML's dumper here because the wizard writes its
    own targeted topology — full YAML serialisation would obscure
    the resulting file's shape for an operator reading it."""
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, list):
        if not value:
            return "[]"
        items = ", ".join(_format_yaml_value(v) for v in value)
        return f"[{items}]"
    s = str(value)
    if any(c in s for c in " :#@") or s == "":
        return f'"{s}"'
    return s


def _render_topology_yaml(
    *,
    node_name: str,
    target: str,
    target_fields: dict[str, Any],
    database_url: str,
    auth_master_key: str,
    auth_allowed_email: str,
    provider: dict[str, Any],
    bundles: list[str],
) -> str:
    """Build the YAML body for the rendered topology.yml.

    Hand-formatted (vs. yaml.safe_dump) so the comments survive and
    the visual shape matches DEPLOY_*_BOOTSTRAP.md's examples — an
    operator opening the file in their editor recognises the layout
    from the docs."""
    lines: list[str] = [
        "# Generated by `eidan init`. Edit by hand to add more nodes",
        "# or change values. The CLI honours your edits — it never",
        "# overwrites this file unless you re-run the wizard.",
        "schema: 1",
        "nodes:",
        f"  {node_name}:",
        f"    target: {target}",
    ]
    for key, value in target_fields.items():
        lines.append(f"    {key}: {_format_yaml_value(value)}")
    lines.append(f"    database_url: {_format_yaml_value(database_url)}")
    lines.append(
        f"    auth_master_key: {_format_yaml_value(auth_master_key)}"
    )
    lines.append(
        f"    auth_allowed_email: {_format_yaml_value(auth_allowed_email)}"
    )
    lines.append("    provider:")
    for key, value in provider.items():
        lines.append(f"      {key}: {_format_yaml_value(value)}")
    if bundles:
        lines.append(f"    bundles: {_format_yaml_value(bundles)}")
    lines.append("")
    return "\n".join(lines)


def run_init_wizard(
    *,
    target_dir: Path,
    force: bool = False,
) -> tuple[Path, str, bool]:
    """Walk the operator through a single-node topology setup, then
    materialise the scaffold + write the resolved topology.yml.

    Returns ``(target_dir, auth_master_key, key_is_freshly_generated)``.
    The caller uses the third element to decide whether to print
    the "record this offline" reminder — only meaningful for a
    brand-new key the operator hasn't seen before.

    Re-running the wizard with an existing ``.eidan/topology.yml``
    in place reads the prior ``auth_master_key`` before scaffold
    wipes the dir, so the operator gets a "reuse existing?" prompt
    rather than an unrecoverable key swap.

    Raises:
        :class:`InteractiveCancelled` — operator hit Ctrl-C mid-flow.
        :class:`scaffold.ScaffoldTargetExists` — ``target_dir`` is
        non-empty and ``force=False``; caller surfaces this so the
        operator picks ``--force`` or a different path.
    """
    questionary.print(
        "Let's set up a new eidan deployment.\n"
        "(Ctrl-C at any prompt cancels without writing anything.)\n",
        style="bold",
    )

    # Read existing master key BEFORE scaffold wipes the dir, so we
    # can offer to reuse it in _ask_auth. A re-init that regenerates
    # the key would break decryption of anything already stored.
    existing_master_key = _read_existing_master_key(
        target_dir / "topology.yml"
    )

    node_name = _ask(
        questionary.text(
            "Name for this node (used in `eidan deploy --node <name>`):",
            default="prod",
            validate=lambda s: (
                bool(s.strip())
                and all(
                    c.isalnum() or c in "-_" for c in s.strip()
                )
            )
            or "node name must be alphanumeric / hyphen / underscore",
        )
    ).strip()

    target = _ask_target()
    target_fields = (
        _ask_pi_fields() if target == "pi" else _ask_fly_fields()
    )
    database_url = _ask_database_url()
    auth_master_key, auth_allowed_email, key_is_new = _ask_auth(
        existing_master_key
    )
    provider = _ask_provider()
    bundles = _ask_bundles()

    # Scaffold the .eidan/ directory (creates .gitignore,
    # .vault-pass.example, README.md, etc.). The wizard then
    # overwrites the placeholder topology.yml with the resolved one.
    scaffolded = scaffold.scaffold(
        here=True, parent=target_dir.parent, force=force
    )
    topology_path = scaffolded / "topology.yml"
    topology_path.write_text(
        _render_topology_yaml(
            node_name=node_name,
            target=target,
            target_fields=target_fields,
            database_url=database_url,
            auth_master_key=auth_master_key,
            auth_allowed_email=auth_allowed_email,
            provider=provider,
            bundles=bundles,
        ),
        encoding="utf-8",
    )
    return scaffolded, auth_master_key, key_is_new


__all__ = [
    "InteractiveCancelled",
    "run_init_wizard",
    "run_menu",
]
