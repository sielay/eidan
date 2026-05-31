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


def test_render_fly_toml_carries_app_region(tmp_path: Path) -> None:
    """With no `image:` set, the rendered fly.toml carries no
    `[build]` stanza — the reconciler supplies the build config on
    the `fly deploy` command line instead (--dockerfile)."""
    node = _fly_node(tmp_path)
    rendered = fly._render_fly_toml(node)

    assert 'app            = "eidan-api"' in rendered
    assert 'primary_region = "lhr"' in rendered
    assert "[build]" not in rendered  # local-Dockerfile path
    # AnyUrl normalises to a trailing slash; allow either form.
    assert 'EIDAN_HTTP_CORS_ORIGINS = "https://app.example.com' in rendered
    assert 'EIDAN_DISABLED_PLUGINS  = "sentry"' in rendered


def test_render_fly_toml_image_pin_adds_build_block(tmp_path: Path) -> None:
    """When `image:` is set in the topology (operator pinning their
    own published image), fly.toml carries `[build] image = ...`
    and the deploy command uses --image instead of --dockerfile."""
    body = """
        schema: 1
        nodes:
          fly-pinned:
            target: fly
            app: eidan-api
            region: lhr
            image: ghcr.io/myorg/eidan:v0.1.0
            database_url: postgresql+asyncpg://...
            auth_master_key: A-KEY-LONGER-THAN-THIRTY-TWO-CHARS-FOR-VALIDATION
            auth_allowed_email: you@example.com
    """
    topology = load_topology(_write_topology(tmp_path, body))
    rendered = fly._render_fly_toml(topology.resolve_node("fly-pinned"))

    assert "[build]" in rendered
    assert 'image = "ghcr.io/myorg/eidan:v0.1.0"' in rendered


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


def test_secret_values_pushes_log_forward_bundle(tmp_path: Path) -> None:
    """log_forward fields go through `fly secrets set` — URL and
    level alongside the auth (token or headers). Keeps the deploy
    path consistent + makes vault encryption of the auth bits
    natural."""
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
            log_forward:
              url: https://in.logs.betterstack.com
              token: bs-token-XXXX
              level: INFO
              timeout: 5.0
              queue_size: 5000
    """
    topology = load_topology(_write_topology(tmp_path, body))
    secrets = fly._secret_values(topology.resolve_node("fly-prod"))

    # AnyUrl can normalise to a trailing slash; allow either form.
    assert secrets["EIDAN_LOG_FORWARD_URL"].rstrip("/") == "https://in.logs.betterstack.com"
    assert secrets["EIDAN_LOG_FORWARD_TOKEN"] == "bs-token-XXXX"
    assert secrets["EIDAN_LOG_FORWARD_LEVEL"] == "INFO"
    assert secrets["EIDAN_LOG_FORWARD_TIMEOUT"] == "5.0"
    assert secrets["EIDAN_LOG_FORWARD_QUEUE_SIZE"] == "5000"


def test_secret_values_log_forward_headers_compact_json(
    tmp_path: Path,
) -> None:
    """Datadog shape. Headers serialise as compact JSON (no spaces)
    so the value survives any shell / env-file round-trip cleanly."""
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
            log_forward:
              url: https://http-intake.logs.datadoghq.com/api/v2/logs
              headers:
                DD-API-KEY: dd-key-XXXX
    """
    topology = load_topology(_write_topology(tmp_path, body))
    secrets = fly._secret_values(topology.resolve_node("fly-prod"))

    assert secrets["EIDAN_LOG_FORWARD_HEADERS"] == '{"DD-API-KEY":"dd-key-XXXX"}'
    assert "EIDAN_LOG_FORWARD_TOKEN" not in secrets


# ---------- reconcile() flow ----------


def test_reconcile_renders_fly_toml_and_invokes_all_steps(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    topology_path = _write_topology(tmp_path, _FLY_NODE_YAML)
    topology = load_topology(topology_path)
    node = topology.resolve_node("fly-prod")

    # Image is unset on the fixture, so the reconciler builds from
    # the local Dockerfile. Point EIDAN_SOURCE_DIR at the repo root
    # so the path-resolve helper finds infra/fly/Dockerfile
    # regardless of where pytest was invoked.
    repo_root = Path(__file__).resolve().parents[3]
    monkeypatch.setenv("EIDAN_SOURCE_DIR", str(repo_root))

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

    # `fly deploy -c .../fly.toml --dockerfile <eidan>/infra/fly/Dockerfile <eidan>`
    # (no image pinned in the fixture → local Dockerfile build)
    deploy_cmds = [c for c in invoked if c[:2] == ["fly", "deploy"]]
    assert len(deploy_cmds) == 1
    assert "--dockerfile" in deploy_cmds[0]
    assert any(arg.endswith("Dockerfile") for arg in deploy_cmds[0])
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


def test_resolve_eidan_source_dir_env_wins(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("EIDAN_SOURCE_DIR", str(tmp_path))
    assert fly._resolve_eidan_source_dir() == tmp_path


def test_resolve_eidan_source_dir_falls_back_to_cwd(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.delenv("EIDAN_SOURCE_DIR", raising=False)
    monkeypatch.chdir(tmp_path)
    assert fly._resolve_eidan_source_dir() == tmp_path


def test_resolve_dockerfile_missing_raises_helpful_error(
    tmp_path: Path,
) -> None:
    with pytest.raises(fly.TargetReconcileError) as exc:
        fly._resolve_dockerfile(tmp_path)
    msg = str(exc.value)
    assert "infra/fly/Dockerfile" in msg
    assert "EIDAN_SOURCE_DIR" in msg
    assert "image:" in msg  # the third-option hint


def test_reconcile_uses_image_flag_when_image_pinned(
    tmp_path: Path,
) -> None:
    """When `image:` is set, the reconciler bypasses the local
    Dockerfile path entirely and tells flyctl to pull the pinned
    image. Operator who's deploying without an eidan checkout
    locally (e.g. CI with a published image) takes this path."""
    body = """
        schema: 1
        nodes:
          fly-pinned:
            target: fly
            app: eidan-api
            region: lhr
            image: ghcr.io/myorg/eidan:v0.1.0
            database_url: postgresql+asyncpg://...
            auth_master_key: A-KEY-LONGER-THAN-THIRTY-TWO-CHARS-FOR-VALIDATION
            auth_allowed_email: you@example.com
    """
    topology_path = _write_topology(tmp_path, body)
    topology = load_topology(topology_path)
    node = topology.resolve_node("fly-pinned")

    invoked: list[list[str]] = []

    def _fake_run(cmd, **kwargs):
        invoked.append(list(cmd))
        return subprocess.CompletedProcess(args=cmd, returncode=0)

    with patch.object(subprocess, "run", _fake_run):
        fly.reconcile(node, topology_path=topology_path, tags=["deploy"])

    deploy_cmds = [c for c in invoked if c[:2] == ["fly", "deploy"]]
    assert len(deploy_cmds) == 1
    assert "--image" in deploy_cmds[0]
    assert "ghcr.io/myorg/eidan:v0.1.0" in deploy_cmds[0]
    assert "--dockerfile" not in deploy_cmds[0]


def test_ensure_flyctl_available_raises_when_missing() -> None:
    with patch.object(fly.shutil, "which", return_value=None):
        with pytest.raises(fly.TargetReconcileError, match="flyctl"):
            fly.ensure_flyctl_available()


def test_ensure_flyctl_available_quiet_when_present() -> None:
    with patch.object(fly.shutil, "which", return_value="/usr/local/bin/fly"):
        fly.ensure_flyctl_available()  # should not raise
