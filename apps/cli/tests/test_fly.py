# SPDX-License-Identifier: AGPL-3.0-or-later
"""Unit tests for the Fly target reconciler.

Subprocess is fully mocked — these tests must pass on machines
without flyctl installed.

Covers:

- Rendering fly.toml from a resolved node
- Missing app / region raises a typed error
- Secrets pushed via `fly secrets set`
- `fly deploy` invoked with the rendered fly.toml + default image
- `fly ssh console` invoked per bundle
- Tag gating: --tags secrets / deploy / plugins each run only their
  step
- --dry-run propagates (no actual subprocess call)
"""

from __future__ import annotations

import subprocess
from pathlib import Path
from textwrap import dedent
from unittest.mock import patch

import pytest
from eidan_cli.targets import fly
from eidan_cli.targets.fly import FlyMissingFieldError
from eidan_cli.topology import load_topology

# ---------- helpers ----------


def _write_topology(tmp_path: Path, body: str) -> Path:
    path = tmp_path / "topology.yml"
    path.write_text(dedent(body).lstrip(), encoding="utf-8")
    return path


_FLY_NODE_YAML = """
schema: 1
defaults:
  plugin_source: gh:sielay
  github_token: PAT-XXXX
nodes:
  fly-prod:
    target: fly
    app: eidan-api
    region: lhr
    database_url: postgresql+asyncpg://eidan:eidan@10.0.0.1:5432/eidan
    auth_master_key: A-KEY-LONGER-THAN-THIRTY-TWO-CHARS-FOR-VALIDATION
    auth_allowed_email: you@example.com
    cors_origins: ["https://app.example.com"]
    provider:
      name: anthropic
      default_model: claude-sonnet-4-6
      api_key: sk-ant-XXXX
    bundles: [eidan-pro]
    disable: [sentry]
    node_id: fly-prod-lhr
    node_type: fly
"""


def _fly_node(tmp_path: Path):
    topology = load_topology(_write_topology(tmp_path, _FLY_NODE_YAML))
    return topology.resolve_node("fly-prod")


# ---------- rendering ----------


def test_render_fly_toml_carries_app_region_image(tmp_path: Path) -> None:
    node = _fly_node(tmp_path)
    rendered = fly._render_fly_toml(node)

    assert 'app            = "eidan-api"' in rendered
    assert 'primary_region = "lhr"' in rendered
    assert 'image = "ghcr.io/sielay/eidan:latest"' in rendered
    # AnyUrl normalises to a trailing slash; allow either form.
    assert 'EIDAN_HTTP_CORS_ORIGINS = "https://app.example.com' in rendered
    assert 'EIDAN_DISABLED_PLUGINS  = "sentry"' in rendered


def test_render_fly_toml_sentry_default_off(tmp_path: Path) -> None:
    """When the node doesn't override sentry, the Fly reconciler
    pins it OFF in [env] — matches the Fly default in
    docs/DEPLOY_FLY_BOOTSTRAP.md (auto-stop machines shouldn't
    burn cost on the 5-min tick)."""
    body = """
        schema: 1
        nodes:
          fly-prod:
            target: fly
            app: eidan-api
            region: lhr
            database_url: postgresql+asyncpg://...
            auth_master_key: A-KEY-LONGER-THAN-THIRTY-TWO-CHARS-FOR-VALIDATION
            auth_allowed_email: you@example.com
    """
    topology = load_topology(_write_topology(tmp_path, body))
    rendered = fly._render_fly_toml(topology.resolve_node("fly-prod"))

    assert 'EIDAN_SENTRY_ENABLED    = "0"' in rendered


# ---------- required-field errors ----------


def test_missing_app_raises_typed_error(tmp_path: Path) -> None:
    body = """
        schema: 1
        nodes:
          broken:
            target: fly
            region: lhr
            database_url: postgresql+asyncpg://...
            auth_master_key: A-KEY-LONGER-THAN-THIRTY-TWO-CHARS-FOR-VALIDATION
            auth_allowed_email: you@example.com
    """
    topology = load_topology(_write_topology(tmp_path, body))
    with pytest.raises(FlyMissingFieldError, match="'app'"):
        fly._render_fly_toml(topology.resolve_node("broken"))


def test_missing_region_raises_typed_error(tmp_path: Path) -> None:
    body = """
        schema: 1
        nodes:
          broken:
            target: fly
            app: eidan-api
            database_url: postgresql+asyncpg://...
            auth_master_key: A-KEY-LONGER-THAN-THIRTY-TWO-CHARS-FOR-VALIDATION
            auth_allowed_email: you@example.com
    """
    topology = load_topology(_write_topology(tmp_path, body))
    with pytest.raises(FlyMissingFieldError, match="'region'"):
        fly._render_fly_toml(topology.resolve_node("broken"))


# ---------- secrets ----------


def test_secret_values_maps_required_env_plus_provider(tmp_path: Path) -> None:
    node = _fly_node(tmp_path)
    secrets = fly._secret_values(node)

    assert (
        secrets["DATABASE_URL"]
        == "postgresql+asyncpg://eidan:eidan@10.0.0.1:5432/eidan"
    )
    assert (
        secrets["EIDAN_AUTH_MASTER_KEY"]
        == "A-KEY-LONGER-THAN-THIRTY-TWO-CHARS-FOR-VALIDATION"
    )
    assert secrets["ANTHROPIC_API_KEY"] == "sk-ant-XXXX"
    assert secrets["EIDAN_PROVIDER"] == "anthropic"
    assert secrets["EIDAN_DEFAULT_MODEL"] == "claude-sonnet-4-6"
    assert secrets["EIDAN_GITHUB_TOKEN"] == "PAT-XXXX"


def test_secret_values_omits_provider_key_when_unset(tmp_path: Path) -> None:
    """ollama nodes don't have an api_key, so no provider secret env
    var lands in the pushed set."""
    body = """
        schema: 1
        nodes:
          fly-cheap:
            target: fly
            app: eidan-api
            region: lhr
            database_url: postgresql+asyncpg://...
            auth_master_key: A-KEY-LONGER-THAN-THIRTY-TWO-CHARS-FOR-VALIDATION
            auth_allowed_email: you@example.com
            provider:
              name: ollama
              default_model: phi3
    """
    topology = load_topology(_write_topology(tmp_path, body))
    secrets = fly._secret_values(topology.resolve_node("fly-cheap"))

    assert "ANTHROPIC_API_KEY" not in secrets
    assert "OPENAI_API_KEY" not in secrets


# ---------- reconcile() flow ----------


def test_reconcile_renders_fly_toml_and_invokes_all_steps(tmp_path: Path) -> None:
    topology_path = _write_topology(tmp_path, _FLY_NODE_YAML)
    topology = load_topology(topology_path)
    node = topology.resolve_node("fly-prod")

    invoked: list[list[str]] = []

    def _fake_run(cmd, **kwargs):
        invoked.append(list(cmd))
        return subprocess.CompletedProcess(args=cmd, returncode=0)

    with patch.object(subprocess, "run", _fake_run):
        code = fly.reconcile(node, topology_path=topology_path)

    assert code == 0

    # fly.toml rendered.
    fly_toml = tmp_path / ".eidan-runtime" / "fly-prod" / "fly.toml"
    assert fly_toml.is_file()
    assert "eidan-api" in fly_toml.read_text(encoding="utf-8")

    # `fly secrets set --app eidan-api KEY=value ...`
    secret_cmds = [c for c in invoked if c[:3] == ["fly", "secrets", "set"]]
    assert len(secret_cmds) == 1
    assert "--app" in secret_cmds[0]
    assert "eidan-api" in secret_cmds[0]
    assert any(arg.startswith("DATABASE_URL=") for arg in secret_cmds[0])
    assert any(arg.startswith("ANTHROPIC_API_KEY=") for arg in secret_cmds[0])

    # `fly deploy -c .../fly.toml --image ghcr.io/sielay/eidan:latest`
    deploy_cmds = [c for c in invoked if c[:2] == ["fly", "deploy"]]
    assert len(deploy_cmds) == 1
    assert "--image" in deploy_cmds[0]
    assert "ghcr.io/sielay/eidan:latest" in deploy_cmds[0]
    assert any(arg.endswith("fly.toml") for arg in deploy_cmds[0])

    # `fly ssh console --app eidan-api -C "... eidan admin plugin install eidan-pro"`
    ssh_cmds = [c for c in invoked if c[:3] == ["fly", "ssh", "console"]]
    assert len(ssh_cmds) == 1
    assert any(
        "eidan admin plugin install eidan-pro" in arg for arg in ssh_cmds[0]
    )


def test_reconcile_tag_secrets_only_runs_secrets(tmp_path: Path) -> None:
    topology_path = _write_topology(tmp_path, _FLY_NODE_YAML)
    topology = load_topology(topology_path)
    node = topology.resolve_node("fly-prod")

    invoked: list[list[str]] = []

    def _fake_run(cmd, **kwargs):
        invoked.append(list(cmd))
        return subprocess.CompletedProcess(args=cmd, returncode=0)

    with patch.object(subprocess, "run", _fake_run):
        fly.reconcile(node, topology_path=topology_path, tags=["secrets"])

    cmds = [c[1] for c in invoked]  # second element is "deploy"/"secrets"/"ssh"
    assert cmds == ["secrets"]


def test_reconcile_dry_run_does_not_invoke_subprocess(
    tmp_path: Path, capsys
) -> None:
    topology_path = _write_topology(tmp_path, _FLY_NODE_YAML)
    topology = load_topology(topology_path)
    node = topology.resolve_node("fly-prod")

    called = False

    def _fake_run(cmd, **kwargs):
        nonlocal called
        called = True
        return subprocess.CompletedProcess(args=cmd, returncode=0)

    with patch.object(subprocess, "run", _fake_run):
        code = fly.reconcile(node, topology_path=topology_path, dry_run=True)

    assert code == 0
    assert called is False  # dry-run echoes instead of executing
    out = capsys.readouterr().out
    assert "[dry-run]" in out
    assert "fly deploy" in out


def test_reconcile_stops_on_first_non_zero(tmp_path: Path) -> None:
    """If `fly secrets set` returns non-zero, we don't proceed to
    deploy. The caller surfaces the partial-failure to the operator."""
    topology_path = _write_topology(tmp_path, _FLY_NODE_YAML)
    topology = load_topology(topology_path)
    node = topology.resolve_node("fly-prod")

    invoked: list[list[str]] = []

    def _fake_run(cmd, **kwargs):
        invoked.append(list(cmd))
        # Fail on secrets, succeed on anything else (we shouldn't get there).
        return subprocess.CompletedProcess(
            args=cmd, returncode=42 if cmd[1] == "secrets" else 0
        )

    with patch.object(subprocess, "run", _fake_run):
        code = fly.reconcile(node, topology_path=topology_path)

    assert code == 42
    assert [c[1] for c in invoked] == ["secrets"]  # never got to deploy


# ---------- ensure_flyctl_available ----------


def test_ensure_flyctl_available_raises_when_missing() -> None:
    with patch.object(fly.shutil, "which", return_value=None):
        with pytest.raises(fly.TargetReconcileError, match="flyctl"):
            fly.ensure_flyctl_available()


def test_ensure_flyctl_available_quiet_when_present() -> None:
    with patch.object(fly.shutil, "which", return_value="/usr/local/bin/fly"):
        fly.ensure_flyctl_available()  # should not raise
