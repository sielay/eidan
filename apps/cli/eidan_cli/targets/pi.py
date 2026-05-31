# SPDX-License-Identifier: AGPL-3.0-or-later
"""Pi target reconciler.

Materialises an Ansible inventory + vars file from a resolved
topology node, then invokes ``ansible-playbook`` against the
bundled playbook at ``eidan_cli/playbooks/pi/``.

Runtime artefacts (inventory.ini, vars.yml) land under
``<topology_dir>/.eidan-runtime/<node_name>/`` next to the
operator's topology file, so a failed deploy leaves something to
inspect. On success the directory is left behind too (no
auto-cleanup) — the rendered files are tiny, and the operator can
re-run ansible-playbook manually against them to debug a partial
failure.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
from contextlib import contextmanager
from importlib import resources
from pathlib import Path
from typing import TYPE_CHECKING, Any

import yaml

from . import TargetReconcileError

if TYPE_CHECKING:
    from collections.abc import Iterator

    from eidan_cli.topology import ResolvedNode


_DEFAULT_PLUGINS_DIR = "/var/lib/eidan/plugins"


class PiMissingFieldError(TargetReconcileError):
    """Raised when a Pi node lacks a required Pi-specific field
    (``host`` or ``ssh_user``). The schema marks these optional at
    the JSON Schema level (target-specific fields aren't expressed
    in a discriminator); the reconciler enforces them at deploy
    time so the error surfaces against a concrete node name."""


def _required(node: ResolvedNode, attr: str) -> Any:
    value = getattr(node, attr, None)
    if value in (None, ""):
        raise PiMissingFieldError(
            f"node {node.name!r}: required field {attr!r} not set "
            "(needed for target: pi)"
        )
    return value


def _render_inventory(node: ResolvedNode) -> str:
    """One host in [eidan_pi], one var-block, no surprises.

    Mirrors the shape Ansible expects from a simple ini-style
    inventory; we don't try to be more clever than the original
    ``infra/pi/inventory.ini.example`` was."""
    host = _required(node, "host")
    ssh_user = _required(node, "ssh_user")
    ssh_key = getattr(node, "ssh_key", None)

    line = f"{node.name} ansible_host={host} ansible_user={ssh_user}"
    if ssh_key:
        # Path expansion happens host-side by ansible.
        line += f" ansible_ssh_private_key_file={ssh_key}"

    return (
        "[eidan_pi]\n"
        f"{line}\n"
        "\n"
        "[eidan_pi:vars]\n"
        "ansible_python_interpreter=/usr/bin/python3\n"
    )


def _node_to_ansible_vars(node: ResolvedNode) -> dict[str, Any]:
    """Map ResolvedNode → the ansible vars the playbook + env.j2
    template expect. Optional fields are omitted (not set to None)
    so the Jinja ``is defined`` guards in the templates do the
    right thing."""
    vars_dict: dict[str, Any] = {
        "eidan_database_url": _required(node, "database_url"),
        "eidan_auth_master_key": _required(node, "auth_master_key"),
        "eidan_auth_allowed_email": _required(node, "auth_allowed_email"),
        "eidan_deployment_mode": node.deployment_mode.value
        if hasattr(node.deployment_mode, "value")
        else node.deployment_mode,
        "eidan_http_host": node.http_host,
        "eidan_http_port": node.http_port,
        "eidan_plugins_dir": _DEFAULT_PLUGINS_DIR,
    }

    if node.provider is not None:
        vars_dict["eidan_provider"] = node.provider.name.value
        vars_dict["eidan_default_model"] = node.provider.default_model
    if getattr(node, "ollama_base_url", None) is not None:
        # AnyUrl carries trailing slash sometimes; the env file expects the
        # /v1 path the user wrote, so str() it as-stored.
        vars_dict["ollama_base_url"] = str(node.ollama_base_url)

    if getattr(node, "node_id", None):
        vars_dict["eidan_node_id"] = node.node_id
    if getattr(node, "node_type", None):
        vars_dict["eidan_node_type"] = node.node_type

    bundles = getattr(node, "bundles", None) or []
    if bundles:
        vars_dict["eidan_bundles"] = [
            b.root if hasattr(b, "root") else str(b) for b in bundles
        ]

    disable = getattr(node, "disable", None) or []
    if disable:
        # EIDAN_DISABLED_PLUGINS is a comma-separated env var.
        vars_dict["eidan_disabled_plugins"] = ",".join(
            d.root if hasattr(d, "root") else str(d) for d in disable
        )

    if getattr(node, "plugin_source", None):
        vars_dict["eidan_plugin_source"] = node.plugin_source
    if getattr(node, "github_token", None):
        vars_dict["eidan_github_token"] = node.github_token

    sentry = getattr(node, "sentry", None)
    if sentry is not None:
        vars_dict["eidan_sentry_enabled"] = 1 if sentry.enabled else 0
        vars_dict["eidan_sentry_tick_interval"] = sentry.tick_interval
        vars_dict["eidan_sentry_model"] = sentry.model
    else:
        # Playbook expects these to exist; sentry defaults match the
        # schema defaults so behaviour is the same as a node that
        # didn't override.
        vars_dict["eidan_sentry_enabled"] = 1
        vars_dict["eidan_sentry_tick_interval"] = "PT5M"
        vars_dict["eidan_sentry_model"] = "phi3"

    smtp = getattr(node, "smtp", None)
    if smtp is not None:
        vars_dict["eidan_smtp_host"] = smtp.host
        vars_dict["eidan_smtp_port"] = smtp.port
        vars_dict["eidan_smtp_user"] = smtp.user or ""
        vars_dict["eidan_smtp_password"] = smtp.password or ""
        vars_dict["eidan_smtp_from"] = str(smtp.from_)

    log_forward = getattr(node, "log_forward", None)
    if log_forward is not None:
        vars_dict["eidan_log_forward_url"] = str(log_forward.url)
        if log_forward.token:
            vars_dict["eidan_log_forward_token"] = log_forward.token
        if log_forward.headers:
            # systemd EnvironmentFile= splits unquoted values on whitespace,
            # and the operator-template puts these values into eidan.env
            # without further escaping. Serialise the dict as compact JSON
            # (no spaces) so it survives the env-file round-trip cleanly.
            vars_dict["eidan_log_forward_headers"] = json.dumps(
                dict(log_forward.headers), separators=(",", ":")
            )
        if log_forward.level:
            vars_dict["eidan_log_forward_level"] = (
                log_forward.level.value
                if hasattr(log_forward.level, "value")
                else str(log_forward.level)
            )
        if log_forward.timeout is not None:
            vars_dict["eidan_log_forward_timeout"] = log_forward.timeout
        if log_forward.queue_size is not None:
            vars_dict["eidan_log_forward_queue_size"] = log_forward.queue_size

    return vars_dict


def _runtime_dir(topology_path: Path, node_name: str) -> Path:
    """``<topology_dir>/.eidan-runtime/<node>/`` — gitignored per the
    template `.gitignore`. Operator can `rm -rf .eidan-runtime/` any
    time; the next deploy recreates it."""
    return topology_path.parent / ".eidan-runtime" / node_name


@contextmanager
def _bundled_playbook_root() -> Iterator[Path]:
    """Context-managed real-filesystem path to the bundled playbook
    directory. ``as_file`` extracts the tree to a temp location for
    zip-based wheel installs; for editable installs the package is
    already on disk and ``as_file`` returns the original path.

    The yielded path points at ``apps/cli/eidan_cli/playbooks/pi/``
    (or its temp-extracted equivalent), which is what we pass to
    ansible-playbook as the playbook root."""
    pkg = resources.files("eidan_cli.playbooks") / "pi"
    with resources.as_file(pkg) as path:
        yield Path(path)


def reconcile(
    node: ResolvedNode,
    *,
    topology_path: Path,
    tags: list[str] | None = None,
    dry_run: bool = False,
    ask_vault_pass: bool = False,
    extra_args: list[str] | None = None,
) -> int:
    """Render runtime files, invoke ansible-playbook, return its
    exit code. Does NOT clean up the runtime tree — the operator
    inspects it after a failed deploy, and the next deploy
    overwrites the files in place."""
    runtime_dir = _runtime_dir(topology_path, node.name)
    runtime_dir.mkdir(parents=True, exist_ok=True)

    inventory_path = runtime_dir / "inventory.ini"
    vars_path = runtime_dir / "vars.yml"

    inventory_path.write_text(_render_inventory(node), encoding="utf-8")
    vars_path.write_text(
        yaml.safe_dump(
            _node_to_ansible_vars(node), default_flow_style=False, sort_keys=True
        ),
        encoding="utf-8",
    )

    with _bundled_playbook_root() as playbook_root:
        playbook_path = playbook_root / "playbook.yml"
        cmd = [
            "ansible-playbook",
            "-i",
            str(inventory_path),
            "-e",
            f"@{vars_path}",
            str(playbook_path),
        ]
        if dry_run:
            cmd += ["--check", "--diff"]
        if tags:
            cmd += ["--tags", ",".join(tags)]
        if ask_vault_pass:
            cmd += ["--ask-vault-pass"]
        if extra_args:
            cmd += extra_args

        # ANSIBLE_CONFIG=/dev/null suppresses any operator-side
        # ansible.cfg from contaminating the deploy; we want
        # deterministic behaviour driven only by the bundled
        # playbook + our rendered inventory.
        env = {**os.environ, "ANSIBLE_CONFIG": "/dev/null"}
        completed = subprocess.run(cmd, env=env, check=False)  # noqa: S603
        return completed.returncode


def ensure_ansible_available() -> None:
    """Probe ``ansible-playbook`` on PATH; raise a friendly error if
    missing. Called by the CLI front-end before any reconciler so
    the operator sees "install ansible" instead of FileNotFoundError
    from subprocess."""
    if shutil.which("ansible-playbook") is None:
        raise TargetReconcileError(
            "ansible-playbook not found on PATH. Install with "
            "`pipx install ansible-core` (or `pip install ansible` "
            "for the full distribution)."
        )


__all__ = [
    "PiMissingFieldError",
    "ensure_ansible_available",
    "reconcile",
]
