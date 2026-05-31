# SPDX-License-Identifier: AGPL-3.0-or-later
"""Fly.io target reconciler.

Wires `target: fly` nodes from `topology.yml` into a four-step
flyctl pipeline:

1. Render `fly.toml` from the resolved node into
   `<topology_dir>/.eidan-runtime/<node>/fly.toml`.
2. `fly secrets set --app <app>` for each secret env var the
   topology declared. Only pushes values we have — never clears a
   secret the operator set out-of-band.
3. `fly deploy` against the rendered fly.toml. Two shapes:
   - `image:` set in topology → `fly deploy --image <image>`
     (operator's pinned tag, e.g. their own GHCR build).
   - `image:` unset → `fly deploy --dockerfile <eidan>/infra/fly/
     Dockerfile <eidan>` to build locally. The eidan checkout
     root is `EIDAN_SOURCE_DIR` or cwd.
4. `fly ssh console -C "eidan admin plugin install <bundle>"` for
   each bundle in the node's `bundles:` list.

Each step is gated by a tag: pass `--tags secrets,deploy,plugins`
(or just one) to invoke a subset; default runs all four. Step
ordering is fixed — we don't try to parallelise across steps.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
from importlib import resources
from pathlib import Path
from typing import TYPE_CHECKING, Any

from . import TargetReconcileError

if TYPE_CHECKING:
    from eidan_cli.topology import ResolvedNode


def _resolve_image(node: ResolvedNode) -> str | None:
    """Per-node `image:` if set, else ``None`` to signal "build locally".

    Returns the topology value when the operator pinned a published
    image (their own GHCR tag, for example). Returns ``None`` when
    nothing's set on either the node or `defaults.image:`, which the
    reconciler treats as "build from the eidan checkout's
    `infra/fly/Dockerfile`" (see :func:`_resolve_dockerfile`).
    """
    return getattr(node, "image", None)


def _resolve_eidan_source_dir() -> Path:
    """Locate the eidan checkout root so the Dockerfile build path
    resolves. ``EIDAN_SOURCE_DIR`` wins if set; otherwise cwd. We
    don't auto-discover via heuristics — explicit is kinder than
    guessing wrong on a sibling-directory layout."""
    env_value = os.environ.get("EIDAN_SOURCE_DIR", "").strip()
    if env_value:
        return Path(env_value).expanduser()
    return Path.cwd()


def _resolve_dockerfile(source_dir: Path) -> Path:
    """Path to the bundled ``infra/fly/Dockerfile`` relative to the
    eidan checkout root. Raises if it doesn't exist so the operator
    gets a clear "you're in the wrong dir" message instead of a
    confusing flyctl error."""
    dockerfile = source_dir / "infra" / "fly" / "Dockerfile"
    if not dockerfile.is_file():
        raise TargetReconcileError(
            "Fly deploy needs `infra/fly/Dockerfile` from the eidan "
            f"checkout, but didn't find it at {dockerfile}. Either:\n"
            "  - run `eidan deploy` from your eidan checkout root, or\n"
            "  - set EIDAN_SOURCE_DIR to the eidan checkout path, or\n"
            "  - pin `image:` in topology.yml to a published image "
            "you have access to (skips the build entirely)."
        )
    return dockerfile


class FlyMissingFieldError(TargetReconcileError):
    """Raised when a Fly node lacks a required Fly-specific field
    (``app`` or ``region``)."""


def _required(node: ResolvedNode, attr: str) -> Any:
    value = getattr(node, attr, None)
    if value in (None, ""):
        raise FlyMissingFieldError(
            f"node {node.name!r}: required field {attr!r} not set "
            "(needed for target: fly)"
        )
    return value


def _runtime_dir(topology_path: Path, node_name: str) -> Path:
    return topology_path.parent / ".eidan-runtime" / node_name


def _provider_secret_env(node: ResolvedNode) -> tuple[str, str] | None:
    """For non-ollama providers, returns (env var name, api key) so
    the reconciler can `fly secrets set ANTHROPIC_API_KEY=...`."""
    provider = getattr(node, "provider", None)
    if provider is None:
        return None
    api_key = getattr(provider, "api_key", None)
    if not api_key:
        return None
    name = provider.name.value if hasattr(provider.name, "value") else str(provider.name)
    env_map = {
        "anthropic": "ANTHROPIC_API_KEY",
        "openai": "OPENAI_API_KEY",
        "gemini": "GEMINI_API_KEY",
        "mistral": "MISTRAL_API_KEY",
    }
    env_var = env_map.get(name)
    if env_var is None:
        return None  # ollama has no API key, anything else is unknown
    return env_var, str(api_key)


def _render_fly_toml(node: ResolvedNode) -> str:
    """Render fly.toml from the bundled template using simple token
    replacement. We avoid Jinja here because the template is tiny
    and the substitution is one-shot — adding a Jinja dep just for
    this would be overkill."""
    app = _required(node, "app")
    region = _required(node, "region")
    http_port = getattr(node, "http_port", 8000)
    http_host = getattr(node, "http_host", "0.0.0.0")
    deployment_mode = (
        node.deployment_mode.value
        if hasattr(node.deployment_mode, "value")
        else str(node.deployment_mode)
    )
    cors_origins = ",".join(
        str(origin) for origin in (getattr(node, "cors_origins", None) or [])
    )
    # When `image:` is set the rendered fly.toml carries a [build]
    # image stanza; flyctl pulls + deploys the image. When unset,
    # the toml leaves [build] out entirely — the reconciler invokes
    # `fly deploy --dockerfile <path> <ctx>` which supplies the build
    # config on the command line instead. See `_fly_deploy`.
    image = _resolve_image(node)
    build_block = (
        f'[build]\n  image = "{image}"\n\n'
        if image is not None
        else ""
    )

    extra_env_lines: list[str] = []
    sentry = getattr(node, "sentry", None)
    if sentry is not None:
        extra_env_lines.append(
            f'  EIDAN_SENTRY_ENABLED    = "{1 if sentry.enabled else 0}"'
        )
    else:
        # Fly default: sentry off (cf. docs/DEPLOY_FLY_BOOTSTRAP.md).
        extra_env_lines.append('  EIDAN_SENTRY_ENABLED    = "0"')

    disable = getattr(node, "disable", None) or []
    if disable:
        items = ",".join(
            d.root if hasattr(d, "root") else str(d) for d in disable
        )
        extra_env_lines.append(f'  EIDAN_DISABLED_PLUGINS  = "{items}"')

    if getattr(node, "node_id", None):
        extra_env_lines.append(f'  EIDAN_NODE_ID           = "{node.node_id}"')
    if getattr(node, "node_type", None):
        extra_env_lines.append(f'  EIDAN_NODE_TYPE         = "{node.node_type}"')

    template_path = resources.files("eidan_cli.playbooks.fly") / "fly.toml.template"
    template = template_path.read_text(encoding="utf-8")

    replacements = {
        "__APP__": app,
        "__REGION__": region,
        "__BUILD_BLOCK__": build_block,
        "__HTTP_PORT__": str(http_port),
        "__HTTP_HOST__": http_host,
        "__DEPLOYMENT_MODE__": deployment_mode,
        "__CORS_ORIGINS__": cors_origins,
        "__SENTRY_ENABLED_LINE__": (extra_env_lines[0] + "\n") if extra_env_lines else "",
    }
    # Build the remaining extras as a single concatenated block since the
    # template currently has a single placeholder slot for them. Keep
    # the rest of the placeholders inert.
    remaining = "\n".join(extra_env_lines[1:])
    replacements["__DISABLED_PLUGINS_LINE__"] = remaining + ("\n" if remaining else "")
    replacements["__NODE_ID_LINE__"] = ""
    replacements["__NODE_TYPE_LINE__"] = ""

    rendered = template
    for key, value in replacements.items():
        rendered = rendered.replace(key, value)
    return rendered


def _secret_values(node: ResolvedNode) -> dict[str, str]:
    """Map env var name → value for everything the reconciler should
    push via `fly secrets set`. Excludes the cors/host/sentry stuff
    that lives in the `[env]` block of fly.toml — those aren't
    secrets."""
    out: dict[str, str] = {
        "DATABASE_URL": _required(node, "database_url"),
        "EIDAN_AUTH_MASTER_KEY": _required(node, "auth_master_key"),
        "EIDAN_AUTH_ALLOWED_EMAIL": _required(node, "auth_allowed_email"),
    }
    provider_secret = _provider_secret_env(node)
    if provider_secret is not None:
        env_var, value = provider_secret
        out[env_var] = value
        # The backend needs to know which provider to use.
        provider = getattr(node, "provider", None)
        if provider is not None:
            name = (
                provider.name.value
                if hasattr(provider.name, "value")
                else str(provider.name)
            )
            out["EIDAN_PROVIDER"] = name
            out["EIDAN_DEFAULT_MODEL"] = provider.default_model
    if getattr(node, "github_token", None):
        out["EIDAN_GITHUB_TOKEN"] = node.github_token
    smtp = getattr(node, "smtp", None)
    if smtp is not None:
        out["EIDAN_SMTP_HOST"] = smtp.host
        out["EIDAN_SMTP_PORT"] = str(smtp.port)
        if smtp.user:
            out["EIDAN_SMTP_USER"] = smtp.user
        if smtp.password:
            out["EIDAN_SMTP_PASSWORD"] = smtp.password
        out["EIDAN_SMTP_FROM"] = str(smtp.from_)

    log_forward = getattr(node, "log_forward", None)
    if log_forward is not None:
        # All log_forward values go through `fly secrets set` — they
        # often carry tokens (BetterStack source token, Datadog API
        # key) and grouping them keeps the deploy path consistent.
        # The non-secret bits (URL, level, timeout) cost nothing to
        # carry as secrets.
        out["EIDAN_LOG_FORWARD_URL"] = str(log_forward.url)
        if log_forward.token:
            out["EIDAN_LOG_FORWARD_TOKEN"] = log_forward.token
        if log_forward.headers:
            out["EIDAN_LOG_FORWARD_HEADERS"] = json.dumps(
                dict(log_forward.headers), separators=(",", ":")
            )
        if log_forward.level:
            out["EIDAN_LOG_FORWARD_LEVEL"] = (
                log_forward.level.value
                if hasattr(log_forward.level, "value")
                else str(log_forward.level)
            )
        if log_forward.timeout is not None:
            out["EIDAN_LOG_FORWARD_TIMEOUT"] = str(log_forward.timeout)
        if log_forward.queue_size is not None:
            out["EIDAN_LOG_FORWARD_QUEUE_SIZE"] = str(log_forward.queue_size)
    return out


def _run(cmd: list[str], *, dry_run: bool) -> int:
    """Wrap subprocess.run with the dry-run echo behaviour. dry-run
    prints the command and returns 0 instead of executing it; useful
    for `--dry-run` testing without a Fly account."""
    if dry_run:
        print("[dry-run]", " ".join(cmd))  # noqa: T201
        return 0
    completed = subprocess.run(cmd, check=False)  # noqa: S603
    return completed.returncode


def _push_secrets(
    node: ResolvedNode, *, dry_run: bool, app: str
) -> int:
    secrets = _secret_values(node)
    if not secrets:
        return 0
    cmd = ["fly", "secrets", "set", "--app", app]
    for env_var, value in sorted(secrets.items()):
        cmd.append(f"{env_var}={value}")
    return _run(cmd, dry_run=dry_run)


def _fly_deploy(
    *,
    fly_toml_path: Path,
    image: str | None,
    dry_run: bool,
) -> int:
    """Build the `fly deploy` invocation.

    Two shapes:

    - ``image`` set: ``fly deploy -c <fly.toml> --image <image>``.
      flyctl pulls the image and rolls the machines. fly.toml carries
      the same image in its ``[build]`` stanza for consistency.
    - ``image`` unset: ``fly deploy -c <fly.toml> --dockerfile
      <eidan>/infra/fly/Dockerfile <eidan>``. flyctl builds from the
      bundled Dockerfile using the eidan checkout as the build
      context. fly.toml has no ``[build]`` stanza — the command-line
      flags supply the build config.
    """
    cmd = ["fly", "deploy", "-c", str(fly_toml_path)]
    if image is not None:
        cmd += ["--image", image]
    else:
        source_dir = _resolve_eidan_source_dir().resolve()
        dockerfile = _resolve_dockerfile(source_dir)
        cmd += ["--dockerfile", str(dockerfile), str(source_dir)]
    if dry_run:
        cmd.append("--build-only")
    return _run(cmd, dry_run=dry_run)


def _install_bundles(
    node: ResolvedNode, *, dry_run: bool, app: str
) -> int:
    bundles = getattr(node, "bundles", None) or []
    if not bundles:
        return 0
    bundle_names = [b.root if hasattr(b, "root") else str(b) for b in bundles]
    plugin_source = getattr(node, "plugin_source", None) or "gh:sielay"
    gh_token = getattr(node, "github_token", None) or ""
    # One ssh invocation per bundle. The remote command exports the
    # PAT only for the duration of the install, never persists it.
    for bundle in bundle_names:
        env_prefix = f"EIDAN_PLUGIN_SOURCE={plugin_source}"
        if gh_token:
            env_prefix += f" EIDAN_GITHUB_TOKEN={gh_token}"
        remote_cmd = f"{env_prefix} eidan admin plugin install {bundle}"
        cmd = [
            "fly",
            "ssh",
            "console",
            "--app",
            app,
            "-C",
            remote_cmd,
        ]
        code = _run(cmd, dry_run=dry_run)
        if code != 0:
            return code
    return 0


def reconcile(
    node: ResolvedNode,
    *,
    topology_path: Path,
    tags: list[str] | None = None,
    dry_run: bool = False,
    ask_vault_pass: bool = False,  # noqa: ARG001 — accepted for orchestrator parity
    extra_args: list[str] | None = None,  # noqa: ARG001 — same
) -> int:
    """Render fly.toml, push secrets, deploy, install bundles.
    Returns the first non-zero exit code from a step, or 0 if all
    pass. Step subset gated by ``tags``."""
    app = _required(node, "app")
    _required(node, "region")

    runtime_dir = _runtime_dir(topology_path, node.name)
    runtime_dir.mkdir(parents=True, exist_ok=True)
    fly_toml_path = runtime_dir / "fly.toml"
    fly_toml_path.write_text(_render_fly_toml(node), encoding="utf-8")

    tags_set = set(tags or [])
    do_all = not tags_set

    if do_all or "secrets" in tags_set:
        code = _push_secrets(node, dry_run=dry_run, app=app)
        if code != 0:
            return code

    if do_all or "deploy" in tags_set:
        code = _fly_deploy(
            fly_toml_path=fly_toml_path,
            image=_resolve_image(node),
            dry_run=dry_run,
        )
        if code != 0:
            return code

    if do_all or "plugins" in tags_set:
        code = _install_bundles(node, dry_run=dry_run, app=app)
        if code != 0:
            return code

    return 0


def ensure_flyctl_available() -> None:
    if shutil.which("fly") is None:
        raise TargetReconcileError(
            "flyctl not found on PATH. Install via "
            "`brew install flyctl` (mac) or follow "
            "https://fly.io/docs/flyctl/install/"
        )


__all__ = [
    "FlyMissingFieldError",
    "ensure_flyctl_available",
    "reconcile",
]
