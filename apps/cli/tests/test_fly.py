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


def _stub_eidan_checkout(root: Path) -> None:
    """Stand up a minimum-shaped fake eidan checkout for build-context
    tests. Carries just enough files for `_assemble_build_context` to
    copy everything it expects — pyproject.toml, uv.lock, the five
    dirs the Dockerfile COPYs, and a single core plugin so the
    plugins-merge logic has something to merge against."""
    root.mkdir(parents=True, exist_ok=True)
    (root / "pyproject.toml").write_text("[project]\nname='eidan'\n")
    (root / "uv.lock").write_text("# lock\n")
    for sub in ("apps", "packages", "migrations", "infra"):
        (root / sub).mkdir()
        # Drop a sentinel file so the dir survives the copy.
        (root / sub / ".keep").write_text("")
    # Dockerfile must exist at infra/fly/Dockerfile for the friendly
    # `_resolve_dockerfile` check to pass.
    (root / "infra" / "fly").mkdir()
    (root / "infra" / "fly" / "Dockerfile").write_text("FROM python:3.12-slim\n")
    # A single core plugin so we can assert the merge keeps both
    # core + bundle plugins side-by-side.
    core = root / "plugins" / "example-core"
    core.mkdir(parents=True)
    (core / "plugin.yaml").write_text("schema: 1\nname: example-core\n")


def _stub_bundle_repo(bundle_dir: Path, *, plugins: list[str]) -> None:
    """Lay out `<bundle_dir>/<plugin>/plugin.yaml` for each name in
    ``plugins``. Mirrors the operator-local bundle-repo shape the
    bake-at-build path resolves."""
    bundle_dir.mkdir(parents=True, exist_ok=True)
    for plugin_name in plugins:
        plug = bundle_dir / plugin_name
        plug.mkdir()
        (plug / "plugin.yaml").write_text(
            f"schema: 1\nname: {plugin_name}\n"
        )


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


def test_render_fly_toml_no_longer_pins_plugin_source(tmp_path: Path) -> None:
    """``EIDAN_PLUGIN_SOURCE`` used to live in fly.toml [env] for the
    runtime SSH install. Bake-at-build (#104 slice A) means plugins
    are part of the image — nothing on the machine reads the
    source. The env line is gone."""
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
            plugin_source: gh:myorg
    """
    topology = load_topology(_write_topology(tmp_path, body))
    rendered = fly._render_fly_toml(topology.resolve_node("fly-prod"))

    assert "EIDAN_PLUGIN_SOURCE" not in rendered


def test_render_fly_toml_no_mount_block_and_no_plugins_dir_override(
    tmp_path: Path,
) -> None:
    """Bake-at-build (#104 slice B) drops the plugins volume + the
    ``EIDAN_PLUGINS_DIR`` env override. The image-baked
    ``/app/plugins/`` is authoritative; nothing on the machine writes
    to a volume anymore. Operators no longer hit the ``fly volume
    create`` cliff on first deploy."""
    node = _fly_node(tmp_path)
    rendered = fly._render_fly_toml(node)

    assert "[[mounts]]" not in rendered
    assert "eidan_plugins" not in rendered
    assert "EIDAN_PLUGINS_DIR" not in rendered


# ---------- build context assembly ----------


def test_assemble_build_context_copies_eidan_tree_and_bundles(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Happy path: assembler copies the eidan files the Dockerfile
    COPYs + merges each bundle's plugin subdirs into the context's
    ``plugins/`` slot, side-by-side with core plugins."""
    fake_eidan = tmp_path / "eidan"
    _stub_eidan_checkout(fake_eidan)
    _stub_bundle_repo(
        tmp_path / "eidan-pro", plugins=["slack", "imap"]
    )
    runtime = tmp_path / "runtime"
    runtime.mkdir()

    node = _fly_node(tmp_path)  # carries `bundles: [eidan-pro]`
    ctx = fly._assemble_build_context(
        node, eidan_dir=fake_eidan, runtime_dir=runtime
    )

    # Files + dirs the Dockerfile COPYs.
    assert (ctx / "pyproject.toml").is_file()
    assert (ctx / "uv.lock").is_file()
    for sub in ("apps", "packages", "migrations", "infra"):
        assert (ctx / sub).is_dir()

    # Plugins merged: both the core plugin (from eidan checkout)
    # and the bundle plugins (from the operator-local bundle repo)
    # land in <ctx>/plugins/.
    assert (ctx / "plugins" / "example-core" / "plugin.yaml").is_file()
    assert (ctx / "plugins" / "slack" / "plugin.yaml").is_file()
    assert (ctx / "plugins" / "imap" / "plugin.yaml").is_file()


def test_assemble_build_context_honours_eidan_bundle_root_env(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """`EIDAN_BUNDLE_ROOT` wins over the eidan-parent convention.
    Operators who keep bundles in a non-sibling layout (CI, separate
    drive) override via env."""
    fake_eidan = tmp_path / "anywhere" / "eidan"
    _stub_eidan_checkout(fake_eidan)
    custom_root = tmp_path / "elsewhere"
    _stub_bundle_repo(custom_root / "eidan-pro", plugins=["slack"])
    monkeypatch.setenv("EIDAN_BUNDLE_ROOT", str(custom_root))

    runtime = tmp_path / "runtime"
    runtime.mkdir()

    node = _fly_node(tmp_path)
    ctx = fly._assemble_build_context(
        node, eidan_dir=fake_eidan, runtime_dir=runtime
    )

    assert (ctx / "plugins" / "slack" / "plugin.yaml").is_file()


def test_assemble_build_context_missing_bundle_dir_raises(
    tmp_path: Path,
) -> None:
    """The bundle name in topology with no local checkout under
    ``<eidan-parent>/<bundle>/`` is a fatal config error. The
    message points the operator at where to clone the bundle repo."""
    fake_eidan = tmp_path / "eidan"
    _stub_eidan_checkout(fake_eidan)
    # NB: no `eidan-pro` dir created — that's the bug.
    runtime = tmp_path / "runtime"
    runtime.mkdir()

    node = _fly_node(tmp_path)
    with pytest.raises(fly.TargetReconcileError, match="eidan-pro"):
        fly._assemble_build_context(
            node, eidan_dir=fake_eidan, runtime_dir=runtime
        )


def test_assemble_build_context_bundle_dir_with_no_plugins_raises(
    tmp_path: Path,
) -> None:
    """A bundle dir that exists but contains no ``plugin.yaml``
    subdirs is also a fatal error — usually a sign the operator
    cloned the wrong branch or hasn't pulled."""
    fake_eidan = tmp_path / "eidan"
    _stub_eidan_checkout(fake_eidan)
    (tmp_path / "eidan-pro").mkdir()  # empty bundle dir
    runtime = tmp_path / "runtime"
    runtime.mkdir()

    node = _fly_node(tmp_path)
    with pytest.raises(fly.TargetReconcileError, match="no plugin.yaml"):
        fly._assemble_build_context(
            node, eidan_dir=fake_eidan, runtime_dir=runtime
        )


def test_assemble_build_context_plugin_name_collision_raises(
    tmp_path: Path,
) -> None:
    """If a bundle ships a plugin whose name collides with a core
    plugin, the assembler aborts rather than silently overwriting
    one with the other. Operator must rename one or the other."""
    fake_eidan = tmp_path / "eidan"
    _stub_eidan_checkout(fake_eidan)
    # Bundle ships a plugin named `example-core` — the same as the
    # stub eidan checkout's only core plugin.
    _stub_bundle_repo(tmp_path / "eidan-pro", plugins=["example-core"])
    runtime = tmp_path / "runtime"
    runtime.mkdir()

    node = _fly_node(tmp_path)
    with pytest.raises(fly.TargetReconcileError, match="collision"):
        fly._assemble_build_context(
            node, eidan_dir=fake_eidan, runtime_dir=runtime
        )


def test_assemble_build_context_idempotent_on_rerun(
    tmp_path: Path,
) -> None:
    """A second call wipes + re-creates the context. Tests run
    deploy more than once; we don't want stale plugins from a
    previous bundle list lingering."""
    fake_eidan = tmp_path / "eidan"
    _stub_eidan_checkout(fake_eidan)
    bundle_dir = tmp_path / "eidan-pro"
    _stub_bundle_repo(bundle_dir, plugins=["slack"])
    runtime = tmp_path / "runtime"
    runtime.mkdir()

    node = _fly_node(tmp_path)

    ctx_1 = fly._assemble_build_context(
        node, eidan_dir=fake_eidan, runtime_dir=runtime
    )
    assert (ctx_1 / "plugins" / "slack").is_dir()

    # Drop the slack plugin from the bundle, leave only imap; the
    # next assembly must reflect that — slack must NOT survive.
    import shutil as _shutil
    _shutil.rmtree(bundle_dir / "slack")
    _stub_bundle_repo(bundle_dir, plugins=["imap"])

    ctx_2 = fly._assemble_build_context(
        node, eidan_dir=fake_eidan, runtime_dir=runtime
    )
    assert (ctx_2 / "plugins" / "imap").is_dir()
    assert not (ctx_2 / "plugins" / "slack").exists()


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
    # the local Dockerfile. Stand up a fake eidan checkout in tmp
    # (just the directories the build-context assembler needs) and
    # a sibling bundle dir so `bundles: [eidan-pro]` resolves.
    fake_eidan = tmp_path / "fake-eidan"
    _stub_eidan_checkout(fake_eidan)
    _stub_bundle_repo(tmp_path / "eidan-pro", plugins=["slack"])
    monkeypatch.setenv("EIDAN_SOURCE_DIR", str(fake_eidan))

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

    # Build context assembled at .eidan-runtime/<node>/build-context/.
    # `fly deploy` points at THAT (not the original eidan checkout):
    # bundles have been baked into <ctx>/plugins/, ready for the
    # Dockerfile's COPY plugins ./plugins to pick up.
    ctx = tmp_path / ".eidan-runtime" / "fly-prod" / "build-context"
    assert ctx.is_dir()
    assert (ctx / "plugins" / "slack" / "plugin.yaml").is_file()
    assert (ctx / "plugins" / "example-core" / "plugin.yaml").is_file()  # core
    assert (ctx / "pyproject.toml").is_file()
    assert (ctx / "infra" / "fly" / "Dockerfile").is_file()

    deploy_cmds = [c for c in invoked if c[:2] == ["fly", "deploy"]]
    assert len(deploy_cmds) == 1
    assert "--dockerfile" in deploy_cmds[0]
    # Path arguments now point at the assembled context, not the eidan checkout.
    assert str(ctx) in deploy_cmds[0]
    assert str(ctx / "infra" / "fly" / "Dockerfile") in deploy_cmds[0]
    assert any(arg.endswith("fly.toml") for arg in deploy_cmds[0])

    # No more `fly ssh console -C "eidan admin plugin install ..."`
    # — plugins ride the image. Bake-at-build (#104 slice A).
    ssh_cmds = [c for c in invoked if c[:3] == ["fly", "ssh", "console"]]
    assert ssh_cmds == []


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
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys
) -> None:
    """Dry-run echoes the subprocess commands instead of running them.
    Build context still gets assembled (operator wants to inspect the
    materialised tree), but no flyctl call lands on the network."""
    fake_eidan = tmp_path / "fake-eidan"
    _stub_eidan_checkout(fake_eidan)
    _stub_bundle_repo(tmp_path / "eidan-pro", plugins=["slack"])
    monkeypatch.setenv("EIDAN_SOURCE_DIR", str(fake_eidan))

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

    # Build context was still materialised even on dry-run so the
    # operator can inspect what would be deployed.
    ctx = tmp_path / ".eidan-runtime" / "fly-prod" / "build-context"
    assert ctx.is_dir()
    assert (ctx / "plugins" / "slack" / "plugin.yaml").is_file()


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
