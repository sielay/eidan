# SPDX-License-Identifier: AGPL-3.0-or-later
"""Unit tests for the deploy orchestrator + Pi reconciler.

Covers:

- Rendering inventory.ini from a resolved node
- Mapping ResolvedNode → ansible vars dict
- Missing required Pi field raises a typed error
- reconcile() materialises runtime files at the right path
- reconcile() builds the expected ansible-playbook command
- Orchestrator dispatches by target enum value
- Unknown target raises NoReconcilerForTarget with a useful message
- Orchestrator continues past per-node failures and reports a summary
"""

from __future__ import annotations

import subprocess
from pathlib import Path
from textwrap import dedent
from unittest.mock import patch

import pytest
from eidan_cli import deploy
from eidan_cli.targets import pi
from eidan_cli.targets.pi import PiMissingFieldError
from eidan_cli.topology import load_topology

# ---------- helpers ----------


def _write_topology(tmp_path: Path, body: str) -> Path:
    path = tmp_path / "topology.yml"
    path.write_text(dedent(body).lstrip(), encoding="utf-8")
    return path


_PI_NODE_YAML = """
schema: 1
defaults:
  plugin_source: gh:sielay
  github_token: PAT-XXXX
nodes:
  kasha:
    target: pi
    host: 192.168.1.100
    ssh_user: pi
    ssh_key: ~/.ssh/id_ed25519
    database_url: postgresql+asyncpg://eidan:eidan@127.0.0.1:5432/eidan
    auth_master_key: A-KEY-LONGER-THAN-THIRTY-TWO-CHARS-FOR-VALIDATION
    auth_allowed_email: you@example.com
    provider:
      name: ollama
      default_model: phi3
    bundles: [eidan-pro]
    disable: [imap]
    node_id: pi-kasha
    node_type: pi
"""


def _kasha_node(tmp_path: Path):
    topology = load_topology(_write_topology(tmp_path, _PI_NODE_YAML))
    return topology.resolve_node("kasha")


# ---------- inventory rendering ----------


def test_render_inventory_includes_host_ssh_user_and_key(tmp_path: Path) -> None:
    node = _kasha_node(tmp_path)
    rendered = pi._render_inventory(node)

    assert "[eidan_pi]" in rendered
    assert "kasha ansible_host=192.168.1.100 ansible_user=pi" in rendered
    assert "ansible_ssh_private_key_file=~/.ssh/id_ed25519" in rendered
    assert "[eidan_pi:vars]" in rendered
    assert "ansible_python_interpreter=/usr/bin/python3" in rendered


def test_render_inventory_omits_ssh_key_when_unset(tmp_path: Path) -> None:
    """ssh_key is optional — defaults to ssh-agent / default identity
    discovery on the operator's side."""
    body = """
        schema: 1
        nodes:
          minimal:
            target: pi
            host: 10.0.0.1
            ssh_user: pi
            database_url: postgresql+asyncpg://...
            auth_master_key: A-KEY-LONGER-THAN-THIRTY-TWO-CHARS-FOR-VALIDATION
            auth_allowed_email: you@example.com
    """
    topology = load_topology(_write_topology(tmp_path, body))
    rendered = pi._render_inventory(topology.resolve_node("minimal"))

    assert "ansible_ssh_private_key_file" not in rendered


def test_missing_host_raises_typed_error(tmp_path: Path) -> None:
    """JSON Schema doesn't enforce target-specific required fields
    (the schema is flat), so the reconciler raises explicitly."""
    body = """
        schema: 1
        nodes:
          broken:
            target: pi
            ssh_user: pi
            database_url: postgresql+asyncpg://...
            auth_master_key: A-KEY-LONGER-THAN-THIRTY-TWO-CHARS-FOR-VALIDATION
            auth_allowed_email: you@example.com
    """
    topology = load_topology(_write_topology(tmp_path, body))
    with pytest.raises(PiMissingFieldError, match="'host'"):
        pi._render_inventory(topology.resolve_node("broken"))


# ---------- ansible vars mapping ----------


def test_node_to_ansible_vars_carries_required_fields(tmp_path: Path) -> None:
    node = _kasha_node(tmp_path)
    vars_dict = pi._node_to_ansible_vars(node)

    assert (
        vars_dict["eidan_database_url"]
        == "postgresql+asyncpg://eidan:eidan@127.0.0.1:5432/eidan"
    )
    assert (
        vars_dict["eidan_auth_master_key"]
        == "A-KEY-LONGER-THAN-THIRTY-TWO-CHARS-FOR-VALIDATION"
    )
    assert vars_dict["eidan_auth_allowed_email"] == "you@example.com"
    assert vars_dict["eidan_deployment_mode"] == "production"


def test_node_to_ansible_vars_maps_provider_and_bundles(tmp_path: Path) -> None:
    node = _kasha_node(tmp_path)
    vars_dict = pi._node_to_ansible_vars(node)

    assert vars_dict["eidan_provider"] == "ollama"
    assert vars_dict["eidan_default_model"] == "phi3"
    assert vars_dict["eidan_bundles"] == ["eidan-pro"]
    # disable: list maps to EIDAN_DISABLED_PLUGINS comma-joined.
    assert vars_dict["eidan_disabled_plugins"] == "imap"


def test_node_to_ansible_vars_inherits_defaults(tmp_path: Path) -> None:
    """`defaults.plugin_source` lands on the kasha node via the
    deep-merge in Topology.resolve_node()."""
    node = _kasha_node(tmp_path)
    vars_dict = pi._node_to_ansible_vars(node)

    assert vars_dict["eidan_plugin_source"] == "gh:sielay"
    assert vars_dict["eidan_github_token"] == "PAT-XXXX"


def test_node_to_ansible_vars_emits_sentry_defaults_when_unset(
    tmp_path: Path,
) -> None:
    """The playbook expects sentry vars to exist; we default them to
    the schema defaults rather than relying on Jinja `is defined`
    guards on the ansible side."""
    node = _kasha_node(tmp_path)
    vars_dict = pi._node_to_ansible_vars(node)

    assert vars_dict["eidan_sentry_enabled"] == 1
    assert vars_dict["eidan_sentry_tick_interval"] == "PT5M"
    assert vars_dict["eidan_sentry_model"] == "phi3"


# ---------- reconcile() ----------


def test_reconcile_writes_runtime_files_and_invokes_ansible(tmp_path: Path) -> None:
    """reconcile() should materialise inventory.ini + vars.yml under
    .eidan-runtime/<node>/ and then run ansible-playbook against
    them."""
    topology_path = _write_topology(tmp_path, _PI_NODE_YAML)
    topology = load_topology(topology_path)
    node = topology.resolve_node("kasha")

    captured_cmd: list[str] = []

    def _fake_run(cmd, **kwargs):
        captured_cmd.extend(cmd)
        return subprocess.CompletedProcess(args=cmd, returncode=0)

    with patch.object(subprocess, "run", _fake_run):
        code = pi.reconcile(node, topology_path=topology_path)

    assert code == 0
    runtime_dir = tmp_path / ".eidan-runtime" / "kasha"
    assert (runtime_dir / "inventory.ini").is_file()
    assert (runtime_dir / "vars.yml").is_file()
    assert "ansible-playbook" in captured_cmd[0]
    assert "-i" in captured_cmd
    assert "-e" in captured_cmd
    assert any(arg.endswith("vars.yml") or arg.endswith("vars.yml") for arg in captured_cmd)


def test_reconcile_propagates_tags_and_dry_run(tmp_path: Path) -> None:
    topology_path = _write_topology(tmp_path, _PI_NODE_YAML)
    topology = load_topology(topology_path)
    node = topology.resolve_node("kasha")

    captured_cmd: list[str] = []

    def _fake_run(cmd, **kwargs):
        captured_cmd.extend(cmd)
        return subprocess.CompletedProcess(args=cmd, returncode=0)

    with patch.object(subprocess, "run", _fake_run):
        pi.reconcile(
            node,
            topology_path=topology_path,
            tags=["env", "plugins"],
            dry_run=True,
            ask_vault_pass=True,
        )

    assert "--tags" in captured_cmd
    assert "env,plugins" in captured_cmd
    assert "--check" in captured_cmd
    assert "--diff" in captured_cmd
    assert "--ask-vault-pass" in captured_cmd


def test_reconcile_returns_subprocess_exit_code(tmp_path: Path) -> None:
    """Non-zero return from ansible-playbook should propagate so the
    orchestrator can surface it."""
    topology_path = _write_topology(tmp_path, _PI_NODE_YAML)
    topology = load_topology(topology_path)
    node = topology.resolve_node("kasha")

    def _fake_run(cmd, **kwargs):
        return subprocess.CompletedProcess(args=cmd, returncode=2)

    with patch.object(subprocess, "run", _fake_run):
        code = pi.reconcile(node, topology_path=topology_path)

    assert code == 2


# ---------- ensure_ansible_available ----------


def test_ensure_ansible_available_raises_when_missing() -> None:
    with patch.object(pi.shutil, "which", return_value=None):
        with pytest.raises(pi.TargetReconcileError, match="ansible-playbook"):
            pi.ensure_ansible_available()


def test_ensure_ansible_available_quiet_when_present() -> None:
    with patch.object(pi.shutil, "which", return_value="/usr/bin/ansible-playbook"):
        pi.ensure_ansible_available()  # should not raise


# ---------- orchestrator ----------


def test_deploy_reconciles_a_pi_node(tmp_path: Path) -> None:
    topology_path = _write_topology(tmp_path, _PI_NODE_YAML)

    with patch.object(pi, "ensure_ansible_available"), patch.object(
        pi, "reconcile", return_value=0
    ) as mock_reconcile:
        code = deploy.deploy(topology_path, node="kasha")

    assert code == 0
    mock_reconcile.assert_called_once()
    called_node = mock_reconcile.call_args[0][0]
    assert called_node.name == "kasha"


def test_deploy_unknown_target_raises_friendly_error(tmp_path: Path) -> None:
    """A node with `target: docker` (no reconciler yet) surfaces a
    NoReconcilerForTarget rather than a stack trace. The orchestrator
    converts the exception into exit code 4 + a yellow log line."""
    body = """
        schema: 1
        nodes:
          laptop:
            target: docker
            compose_project: eidan-local
            database_url: postgresql+asyncpg://eidan:eidan@db:5432/eidan
            auth_master_key: A-KEY-LONGER-THAN-THIRTY-TWO-CHARS-FOR-VALIDATION
            auth_allowed_email: you@example.com
    """
    topology_path = _write_topology(tmp_path, body)

    with patch.object(pi, "ensure_ansible_available"):
        code = deploy.deploy(topology_path)

    assert code == 4


def test_deploy_unknown_node_returns_2(tmp_path: Path) -> None:
    topology_path = _write_topology(tmp_path, _PI_NODE_YAML)

    with patch.object(pi, "ensure_ansible_available"):
        code = deploy.deploy(topology_path, node="no-such-node")

    assert code == 2


def test_deploy_continues_past_per_node_failure(tmp_path: Path) -> None:
    """A failing node doesn't block reconciliation of healthy peers;
    overall exit code is the first non-zero seen."""
    body = """
        schema: 1
        nodes:
          good:
            target: pi
            host: 10.0.0.1
            ssh_user: pi
            database_url: postgresql+asyncpg://...
            auth_master_key: A-KEY-LONGER-THAN-THIRTY-TWO-CHARS-FOR-VALIDATION
            auth_allowed_email: you@example.com
          bad:
            target: pi
            host: 10.0.0.2
            ssh_user: pi
            database_url: postgresql+asyncpg://...
            auth_master_key: A-KEY-LONGER-THAN-THIRTY-TWO-CHARS-FOR-VALIDATION
            auth_allowed_email: you@example.com
    """
    topology_path = _write_topology(tmp_path, body)

    def _fake_reconcile(node, **kwargs):
        return 5 if node.name == "bad" else 0

    with patch.object(pi, "ensure_ansible_available"), patch.object(
        pi, "reconcile", side_effect=_fake_reconcile
    ) as mock_reconcile:
        code = deploy.deploy(topology_path)

    # Both nodes were attempted.
    assert mock_reconcile.call_count == 2
    # Overall exit code reflects the failure.
    assert code == 5


def test_deploy_missing_topology_returns_2(tmp_path: Path) -> None:
    with patch.object(pi, "ensure_ansible_available"):
        code = deploy.deploy(tmp_path / "no-such.yml")
    assert code == 2
