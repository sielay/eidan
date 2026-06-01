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


def _stub_eidan_checkout(root: Path) -> None:
    """Stand up a minimum-shaped fake eidan checkout for tests that
    exercise the full reconcile() flow (which now assembles a build
    context via :func:`eidan_cli.build_context.assemble_build_context`).

    Mirrors the stub in test_fly.py — we keep them parallel rather
    than DRYing into a shared conftest helper for now; both files
    will collapse into a shared fixture once we have ~5+ users."""
    root.mkdir(parents=True, exist_ok=True)
    (root / "pyproject.toml").write_text("[project]\nname='eidan'\n")
    (root / "uv.lock").write_text("# lock\n")
    for sub in ("apps", "packages", "migrations", "infra"):
        (root / sub).mkdir()
        (root / sub / ".keep").write_text("")
    (root / "infra" / "fly").mkdir()
    (root / "infra" / "fly" / "Dockerfile").write_text("FROM python:3.12-slim\n")
    core = root / "plugins" / "example-core"
    core.mkdir(parents=True)
    (core / "plugin.yaml").write_text("schema: 1\nname: example-core\n")


def _stub_bundle_repo(bundle_dir: Path, *, plugins: list[str]) -> None:
    """Lay out `<bundle_dir>/<plugin>/plugin.yaml` for each name in
    ``plugins`` — operator-local bundle-repo shape the bake-at-build
    path resolves."""
    bundle_dir.mkdir(parents=True, exist_ok=True)
    for plugin_name in plugins:
        plug = bundle_dir / plugin_name
        plug.mkdir()
        (plug / "plugin.yaml").write_text(
            f"schema: 1\nname: {plugin_name}\n"
        )


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


def test_node_to_ansible_vars_does_not_leak_pat_or_plugin_source(
    tmp_path: Path,
) -> None:
    """`plugin_source` / `github_token` live in the topology for the
    laptop-side build-context assembly (the operator may need them
    for non-bake-at-build flows like local plugin dev), but they
    MUST NOT be plumbed into the ansible vars file rendered to
    .eidan-runtime/<node>/vars.yml — the Pi never clones a private
    repo and so never needs a PAT (slice C of #104)."""
    node = _kasha_node(tmp_path)
    vars_dict = pi._node_to_ansible_vars(node)

    assert "eidan_plugin_source" not in vars_dict
    assert "eidan_github_token" not in vars_dict


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


def test_node_to_ansible_vars_maps_log_forward_token_shape(
    tmp_path: Path,
) -> None:
    """BetterStack / Axiom / Honeycomb shape — URL + bearer token."""
    body = """
        schema: 1
        nodes:
          kasha:
            target: pi
            host: 192.168.1.100
            ssh_user: pi
            database_url: postgresql+asyncpg://...
            auth_master_key: A-KEY-LONGER-THAN-THIRTY-TWO-CHARS-FOR-VALIDATION
            auth_allowed_email: you@example.com
            log_forward:
              url: https://in.logs.betterstack.com
              token: bs-source-token-XXXX
              level: INFO
    """
    topology = load_topology(_write_topology(tmp_path, body))
    vars_dict = pi._node_to_ansible_vars(topology.resolve_node("kasha"))

    # AnyUrl can normalise to a trailing slash; allow either form.
    assert (
        vars_dict["eidan_log_forward_url"].rstrip("/")
        == "https://in.logs.betterstack.com"
    )
    assert vars_dict["eidan_log_forward_token"] == "bs-source-token-XXXX"
    assert vars_dict["eidan_log_forward_level"] == "INFO"
    # Headers is mutex with token — should be absent.
    assert "eidan_log_forward_headers" not in vars_dict


def test_node_to_ansible_vars_maps_log_forward_headers_shape(
    tmp_path: Path,
) -> None:
    """Datadog / non-Bearer shape — URL + headers dict. Headers
    serialise as compact JSON (no spaces) so the systemd
    EnvironmentFile= round-trip doesn't split on whitespace."""
    body = """
        schema: 1
        nodes:
          kasha:
            target: pi
            host: 192.168.1.100
            ssh_user: pi
            database_url: postgresql+asyncpg://...
            auth_master_key: A-KEY-LONGER-THAN-THIRTY-TWO-CHARS-FOR-VALIDATION
            auth_allowed_email: you@example.com
            log_forward:
              url: https://http-intake.logs.datadoghq.com/api/v2/logs
              headers:
                DD-API-KEY: dd-key-XXXX
    """
    topology = load_topology(_write_topology(tmp_path, body))
    vars_dict = pi._node_to_ansible_vars(topology.resolve_node("kasha"))

    assert (
        vars_dict["eidan_log_forward_url"]
        == "https://http-intake.logs.datadoghq.com/api/v2/logs"
    )
    # Compact JSON — no spaces, so systemd doesn't split on them.
    assert vars_dict["eidan_log_forward_headers"] == '{"DD-API-KEY":"dd-key-XXXX"}'
    assert "eidan_log_forward_token" not in vars_dict


def test_node_to_ansible_vars_omits_log_forward_when_unset(
    tmp_path: Path,
) -> None:
    """No `log_forward:` on the node → no env vars emitted. Backend's
    forwarder stays off."""
    node = _kasha_node(tmp_path)
    vars_dict = pi._node_to_ansible_vars(node)

    assert "eidan_log_forward_url" not in vars_dict
    assert "eidan_log_forward_token" not in vars_dict
    assert "eidan_log_forward_headers" not in vars_dict


# ---------- reconcile() ----------


def test_reconcile_writes_runtime_files_and_invokes_ansible(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """reconcile() should materialise inventory.ini + vars.yml under
    .eidan-runtime/<node>/ and then run ansible-playbook against
    them. Post-#104-slice-C the reconcile path also assembles a
    local build context, so we stub eidan + bundle dirs."""
    fake_eidan = tmp_path / "fake-eidan"
    _stub_eidan_checkout(fake_eidan)
    _stub_bundle_repo(tmp_path / "eidan-pro", plugins=["slack"])
    monkeypatch.setenv("EIDAN_SOURCE_DIR", str(fake_eidan))

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
    assert any(arg.endswith("vars.yml") for arg in captured_cmd)
    # Build context assembled with slack bundle baked in.
    ctx = runtime_dir / "build-context"
    assert (ctx / "plugins" / "slack" / "plugin.yaml").is_file()
    # vars.yml carries the path the playbook rsyncs from.
    vars_yml = (runtime_dir / "vars.yml").read_text(encoding="utf-8")
    assert "eidan_local_tree" in vars_yml
    assert str(ctx) in vars_yml


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


def test_reconcile_returns_subprocess_exit_code(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Non-zero return from ansible-playbook should propagate so the
    orchestrator can surface it."""
    fake_eidan = tmp_path / "fake-eidan"
    _stub_eidan_checkout(fake_eidan)
    _stub_bundle_repo(tmp_path / "eidan-pro", plugins=["slack"])
    monkeypatch.setenv("EIDAN_SOURCE_DIR", str(fake_eidan))

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
