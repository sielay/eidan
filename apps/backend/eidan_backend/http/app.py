"""FastAPI app factory.

:func:`create_app` wires the shared dependencies (DB pool, provider,
default model) onto ``app.state`` so the route handlers can pull them
off the request without a service locator. The factory accepts
everything via keyword arguments so tests can substitute fakes (a
scripted provider, an in-memory keypair) without touching the
production codepath.

The native auth subsystem (`docs/011 §11`) loads its RS256 keypair from
Postgres in the lifespan handler and stashes the PEMs on
``app.state.auth_private_pem`` / ``auth_public_pem`` — the middleware
reads the public key from there to verify each inbound token.
"""

from __future__ import annotations

import logging
import os
import shutil
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

import asyncpg
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from ..bootstrap import BootstrapResult, bootstrap, shutdown
from ..config import (
    BackendSettings,
    load_backend_settings,
    load_http_settings,
)
from ..db import create_pool
from ..plugins import LoadedPlugin
from ..providers import AnthropicProvider, OpenAIProvider
from ..providers.base import Provider
from ..tools import ToolRegistry
from .auth import AuthMiddleware
from .routes import router
from .security_headers import SecurityHeadersMiddleware

logger = logging.getLogger(__name__)

# Default location for plugin discovery. Resolved relative to the repo
# root: apps/backend/eidan_backend/http/app.py → parents[4] is the repo
# root, which holds the top-level ``plugins/`` directory. Operators
# running from a baked image (e.g. Fly, k8s) can override with
# ``EIDAN_PLUGINS_DIR`` so the runtime reads from a writable mount
# without needing the source tree on disk.
_DEFAULT_PLUGINS_DIR = Path(__file__).resolve().parents[4] / "plugins"


def _read_plugin_tier(plugin_dir: Path) -> str | None:
    """Return the ``tier:`` stanza from ``plugin_dir/plugin.yaml``.

    Used by the volume seeder to filter the image-baked source set
    down to ``tier: core`` plugins (`docs/DEPLOYMENT.md §4.6`):
    paid-tier plugins must never be seeded onto an operator volume
    automatically because the operator licences and installs them
    explicitly. A manifest that is unreadable / malformed / missing
    ``tier`` yields ``None`` and the caller skips the plugin — the
    host loader will refuse it later anyway, and seeding broken
    inventory just makes the next boot louder.

    Kept tolerant of YAML / IO failure: a corrupt manifest in the
    image must not crash the lifespan; the host loader surfaces the
    same problem with a proper diagnostic.
    """
    manifest = plugin_dir / "plugin.yaml"
    if not manifest.is_file():
        return None
    try:
        import yaml
    except ImportError:  # pragma: no cover — yaml is a hard dep
        return None
    try:
        raw = yaml.safe_load(manifest.read_text(encoding="utf-8"))
    except (OSError, yaml.YAMLError):
        return None
    if not isinstance(raw, dict):
        return None
    tier = raw.get("tier")
    return tier if isinstance(tier, str) else None


def _seed_plugins_volume_if_empty(resolved: Path) -> None:
    """Per-plugin idempotent bootstrap for a writable plugins volume.

    Operators running the published image plus a mounted volume (see
    ``docs/DEPLOYMENT.md §4.6`` — runtime plugin install) point
    ``EIDAN_PLUGINS_DIR`` at e.g. ``/var/lib/eidan/plugins``. The
    volume is empty on first boot; without seeding, the host would
    activate zero plugins and the operator would have to run
    ``eidan admin plugin install`` for every core plugin before the
    machine becomes useful. Instead we copy each image-baked
    **tier:core** plugin under :data:`_DEFAULT_PLUGINS_DIR` into the
    volume — but only when the matching ``plugins/<name>/`` directory
    is not already there.

    **Source filter.** Only manifests declaring ``tier: core`` are
    eligible. Paid-tier plugins (`pro` / `commercial`) bundled into
    the image at build time would otherwise leak onto an operator
    volume without the explicit ``eidan admin plugin install``
    handshake; the lock file would not record them and they would
    survive runtime upgrades as silent state. Filtering at the seed
    keeps the operator-installed set isomorphic to ``plugins/.lock``.

    **Atomicity.** Each plugin is copied into a private temporary
    directory next to the target and renamed into place once the
    copy finishes. A crash partway through ``copytree`` leaves the
    tempdir (cleaned up on the next boot's mkstemp scan) rather than
    a half-populated ``plugins/<name>/`` that the next boot would
    treat as "already seeded".

    Seeding is therefore **per-plugin, atomic, and idempotent**. The
    three states this handles uniformly:

    - Fresh volume on first boot: every image-baked tier:core plugin
      lands.
    - Partial-seed recovery: an earlier boot copied some plugins and
      then failed mid-loop (transient IO, disk-full, OOM). The next
      boot copies the missing ones; the survivors are left alone.
      An "any directory exists ⇒ skip" gate would have left the
      volume permanently missing the late-half plugins.
    - Operator-populated volume (paid bundles already installed): the
      paid plugins survive untouched, and any image-baked tier:core
      plugin not present on the volume (e.g. a new tier:core shipping
      in ``v0.N+1``) lands next to them on the next deploy without
      ``eidan admin plugin install`` ceremony.

    A pre-staged ``plugins/.lock`` (or any other dotfile / file at the
    volume root) is irrelevant to seeding — the only "is this plugin
    already on disk?" question we ask is per target plugin directory.

    Skipped entirely when:

    - ``resolved`` is the image-baked default (no volume in play); or
    - the image-baked dir does not exist or has no children (running
      outside an image — e.g. a test that only wired the env override
      to redirect reads).
    """
    if resolved == _DEFAULT_PLUGINS_DIR:
        return
    try:
        resolved.mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        logger.warning(
            "[plugins] could not create %s for seeding: %s", resolved, exc
        )
        return
    if not _DEFAULT_PLUGINS_DIR.is_dir():
        return
    try:
        children = [c for c in _DEFAULT_PLUGINS_DIR.iterdir() if c.is_dir()]
    except OSError as exc:
        # An unreadable image-baked plugins dir (permission denied,
        # corrupt filesystem) must not crash the lifespan — the host
        # boots without seeding and the operator can re-deploy with a
        # fixed image. Same posture as the mkdir / copy error handlers
        # below: log, return, never raise.
        logger.warning(
            "[plugins] could not list %s for seeding: %s",
            _DEFAULT_PLUGINS_DIR,
            exc,
        )
        return
    if not children:
        return
    # Prior boot may have left a half-finished `.seed-<name>.tmp/`
    # tempdir behind (crash between copytree and the rename). Sweep
    # those first so we don't conflict with a fresh attempt for the
    # same plugin below.
    _sweep_orphan_seed_tempdirs(resolved)
    seeded: list[str] = []
    for child in children:
        target = resolved / child.name
        if target.exists():
            # Operator-populated, previously-seeded, or hand-edited —
            # never overwrite. The host's plugin loader will read
            # whatever's there.
            continue
        tier = _read_plugin_tier(child)
        if tier != "core":
            # Only tier:core plugins are eligible for unattended
            # seeding (see docstring). Paid tiers in the image were
            # baked in via `--build-arg EIDAN_BUNDLES=...`; the
            # operator who chose that flag also runs the install path
            # for them on the live machine.
            continue
        tmp = resolved / f".seed-{child.name}.tmp"
        if tmp.exists():
            # Defensive: sweep above should have caught this, but a
            # rename race or readonly leftover would block copytree.
            try:
                shutil.rmtree(tmp)
            except OSError as exc:
                logger.warning(
                    "[plugins] could not clear stale tempdir %s: %s",
                    tmp,
                    exc,
                )
                continue
        try:
            shutil.copytree(child, tmp)
            tmp.replace(target)
        except OSError as exc:
            logger.warning(
                "[plugins] failed to seed %s into volume: %s", child.name, exc
            )
            # Best-effort cleanup of the tempdir so the next boot
            # retries from a clean slate rather than tripping the
            # "tmp.exists()" guard above.
            if tmp.exists():
                try:
                    shutil.rmtree(tmp)
                except OSError:
                    pass
            continue
        seeded.append(child.name)
    if seeded:
        logger.info(
            "[plugins] seeded %d image-baked plugin(s) into %s: %s",
            len(seeded),
            resolved,
            ", ".join(sorted(seeded)),
        )


def _sweep_orphan_seed_tempdirs(resolved: Path) -> None:
    """Remove ``.seed-*.tmp`` directories left behind by a prior crash.

    Best-effort: an unreadable volume root logs a warning and returns
    rather than raising. The seeder caller has already produced enough
    boot-line context (mkdir / iterdir-on-image-dir warnings); a
    second failure here would just bury the actual cause.
    """
    try:
        entries = list(resolved.iterdir())
    except OSError as exc:
        logger.warning(
            "[plugins] could not list %s to sweep orphan tempdirs: %s",
            resolved,
            exc,
        )
        return
    for child in entries:
        if not child.is_dir():
            continue
        if not (child.name.startswith(".seed-") and child.name.endswith(".tmp")):
            continue
        try:
            shutil.rmtree(child)
        except OSError as exc:
            logger.warning(
                "[plugins] could not sweep orphan seed tempdir %s: %s",
                child,
                exc,
            )


def _resolve_plugins_dir(app_state_value: object | None) -> Path:
    """Pick the plugin discovery root.

    Precedence:

    1. ``app.state.plugins_dir`` — set explicitly by a caller (tests
       primarily). Highest priority so a test never reads from a
       stray operator env.
    2. ``EIDAN_PLUGINS_DIR`` env — production override. Lets a baked
       image read plugins from a mounted volume so bundles can be
       swapped without rebuilding the image.
    3. ``_DEFAULT_PLUGINS_DIR`` — the in-repo / in-image default.
    """
    if app_state_value is not None:
        # The pre-helper code used a truthiness check
        # (``if getattr(app.state, "plugins_dir", None)``), so an
        # explicit ``""`` / whitespace fell through to the default.
        # Preserve that behaviour: only honour a non-blank value, and
        # match the env path's ``.expanduser()`` so a caller setting
        # ``~/...`` does not get a literal tilde.
        text = str(app_state_value).strip()
        if text:
            return Path(text).expanduser()
    env_value = os.environ.get("EIDAN_PLUGINS_DIR", "").strip()
    if env_value:
        # Mirror the CLI's expansion (apps/cli/eidan_cli/admin.py) so
        # ``EIDAN_PLUGINS_DIR=~/eidan-plugins`` resolves the same in
        # both processes — otherwise install + runtime drift.
        return Path(env_value).expanduser()
    return _DEFAULT_PLUGINS_DIR


def create_app(
    *,
    pool: asyncpg.Pool,
    provider: Provider,
    default_model: str,
    tool_registry: ToolRegistry | None = None,
    plugins: list[LoadedPlugin] | None = None,
    auth_public_pem: bytes | None = None,
    auth_private_pem: bytes | None = None,
) -> FastAPI:
    """Build a FastAPI app with shared deps pinned on ``app.state``.

    The pool's lifecycle is the caller's responsibility — tests pass a
    pool they own and close themselves; the production entry point uses
    :func:`create_app_from_env` which wraps the pool in a lifespan
    handler.

    ``tool_registry`` is the agent loop's tool surface. Production
    builds it inside the lifespan by booting plugins; tests can pass
    an empty registry (or one preloaded with stubs) to skip the plugin
    load.

    ``plugins`` is the list of loaded plugin units the host activated at
    startup. Production builds it inside the lifespan from
    :class:`BootstrapResult`; tests default to an empty list so the
    ``/api/plugins`` route returns ``[]`` without needing a real loader.

    ``auth_public_pem`` / ``auth_private_pem`` are the native RS256
    keypair the middleware verifies access tokens against and the
    routes use to mint new ones. Production loads them from
    ``eidan.auth_keypair`` in the lifespan; tests pass an in-memory
    pair directly.
    """
    app = FastAPI(title="eidan-backend", version="0.1.0")
    app.state.pool = pool
    app.state.provider = provider
    app.state.default_model = default_model
    app.state.tool_registry = tool_registry or ToolRegistry()
    app.state.plugins = plugins or []
    app.state.behaviour_registry = None
    app.state.behaviour_dispatcher = None
    app.state.command_registry = None
    app.state.telemetry = None
    app.state.node_identity = None
    app.state.auth_public_pem = auth_public_pem
    app.state.auth_private_pem = auth_private_pem

    app.add_middleware(AuthMiddleware)
    # Security headers run as the OUTERMOST middleware so every
    # response (including 401/403 envelopes the auth middleware
    # emits) carries them. Starlette's middleware order is "last
    # added runs first inbound, last outbound" — so adding this
    # after AuthMiddleware places it on the outside of the chain.
    app.add_middleware(SecurityHeadersMiddleware)
    app.include_router(router)

    return app


@asynccontextmanager
async def _lifespan(app: FastAPI) -> AsyncIterator[None]:
    """Open the DB pool + activate every discovered plugin on startup.

    Order matters: the pool must exist before bootstrap runs (plugins
    receive a ``ctx.db`` accessor that wraps the pool, and the
    ``eidan.plugin_state`` table store needs the pool too). On
    shutdown the order reverses — plugins deactivate first, then the
    pool closes.
    """
    backend: BackendSettings = app.state.backend_settings
    plugins_dir = _resolve_plugins_dir(getattr(app.state, "plugins_dir", None))
    _seed_plugins_volume_if_empty(plugins_dir)

    # Optional external log forwarder (BetterStack / Datadog / etc.).
    # Reads EIDAN_LOG_FORWARD_URL + EIDAN_LOG_FORWARD_TOKEN /
    # EIDAN_LOG_FORWARD_HEADERS from env; no-op when unset. Runs
    # *before* pool creation so the boot lines (DB connect, plugin
    # activate, telemetry node.boot) land in the forwarder too.
    from ..log_forwarding import (
        _shutdown_forwarder,
        attach_log_forwarder_if_configured,
    )

    attach_log_forwarder_if_configured()

    pool = await create_pool(backend.database_url)
    app.state.pool = pool

    # Native auth needs an RS256 keypair stashed on app.state before
    # any request hits the middleware. ``ensure_keypair`` mints +
    # encrypts the pair on first start; subsequent boots reuse it.
    # The master key must be set; surface a clear error otherwise so
    # the operator doesn't get a generic 500 on every endpoint.
    from ..auth_native import (
        MasterKeyMissing,
        ensure_keypair,
        master_key_configured,
    )

    if not master_key_configured():
        raise RuntimeError(
            "EIDAN_AUTH_MASTER_KEY is not set. The native auth subsystem "
            "needs a master key to encrypt the RS256 signing keypair at "
            "rest. Generate one with `python -c 'import secrets; "
            "print(secrets.token_urlsafe(48))'` and add it to .env."
        )
    try:
        async with pool.acquire() as conn:
            private_pem, public_pem = await ensure_keypair(conn)
    except MasterKeyMissing as exc:  # belt and braces; checked above
        raise RuntimeError(str(exc)) from exc
    app.state.auth_private_pem = private_pem
    app.state.auth_public_pem = public_pem
    logger.info("[lifespan] native auth keypair loaded")

    boot: BootstrapResult | None = None
    try:
        boot = await bootstrap(
            pool=pool,
            plugins_dir=plugins_dir,
            provider=app.state.provider,
            default_model=app.state.default_model,
        )
        app.state.tool_registry = boot.tool_registry
        app.state.plugins = boot.plugins
        app.state.behaviour_registry = boot.behaviour_registry
        app.state.behaviour_dispatcher = boot.behaviour_dispatcher
        app.state.telemetry = boot.telemetry
        app.state.node_identity = boot.node_identity
        logger.info(
            "[lifespan] tool registry populated with %d tool(s)",
            len(boot.tool_registry.surface() or []),
        )
        yield
    finally:
        if boot is not None:
            try:
                await shutdown(pool=pool, bootstrap_result=boot)
            except Exception:  # noqa: BLE001 — never block pool close
                logger.exception("[lifespan] plugin shutdown raised")
        await pool.close()
        # Tear down the log forwarder symmetrically with attach
        # above. Bounded internally (see log_forwarding doc) so a
        # hung intake can't block lifespan teardown. Without this,
        # re-lifecycling the app in the same interpreter (tests
        # using TestClient, embedded ASGI servers) leaks the
        # QueueListener thread + root handler between runs.
        _shutdown_forwarder()


def _build_provider_from_settings(backend: BackendSettings) -> Provider:
    """Instantiate the configured provider, validating its API key.

    Kept separate from :func:`create_app_from_env` so tests and the CLI
    can build the same provider without going through the FastAPI
    factory.
    """
    if backend.provider == "anthropic":
        if not backend.anthropic_api_key:
            raise RuntimeError(
                "ANTHROPIC_API_KEY is not set. "
                "Set it or switch EIDAN_PROVIDER to a provider whose "
                "credentials are configured."
            )
        return AnthropicProvider(api_key=backend.anthropic_api_key)
    if backend.provider == "openai":
        if not backend.openai_api_key:
            raise RuntimeError(
                "OPENAI_API_KEY is not set but EIDAN_PROVIDER=openai. "
                "Set the key or switch EIDAN_PROVIDER."
            )
        return OpenAIProvider(
            api_key=backend.openai_api_key,
            base_url=backend.openai_base_url,
        )
    if backend.provider == "ollama":
        # Ollama exposes an OpenAI-compatible API on
        # ``localhost:11434/v1`` by default. The adapter is the same
        # OpenAIProvider; the only differences are the base_url + a
        # placeholder api_key (Ollama doesn't validate it, but the
        # OpenAI SDK refuses to construct without a value). Operators
        # who put auth in front of Ollama (a reverse-proxy bearer)
        # set OPENAI_API_KEY; the shorthand reads either OPENAI_API_KEY
        # or falls back to a sentinel.
        return OpenAIProvider(
            api_key=backend.openai_api_key or "ollama",
            base_url=backend.ollama_base_url,
        )
    # The Literal type on backend.provider keeps this branch unreachable
    # at type-check time; the runtime check covers a stray env override.
    raise RuntimeError(f"unknown EIDAN_PROVIDER={backend.provider!r}")


def create_app_from_env() -> FastAPI:
    """Build the production app from environment-driven settings.

    Reads :class:`BackendSettings`, picks the provider per
    ``EIDAN_PROVIDER`` (``anthropic`` by default; ``openai`` /
    ``ollama`` are the alternates — `docs/007`), and wires a lifespan
    that owns the DB pool and loads the native RS256 keypair. The DB
    pool isn't opened here — opening it inside ``lifespan`` means
    uvicorn's ``startup`` event reports failures the user can see,
    rather than at import time when uvicorn has already taken stdout.
    """
    backend = load_backend_settings()
    provider = _build_provider_from_settings(backend)

    app = FastAPI(
        title="eidan-backend",
        version="0.1.0",
        lifespan=_lifespan,
    )
    app.state.backend_settings = backend
    app.state.provider = provider
    app.state.default_model = backend.default_model
    # `pool`, `tool_registry`, `plugins`, and the auth keypair PEMs
    # are populated by the lifespan handler once the DB pool opens.
    app.state.pool = None  # type: ignore[assignment]
    app.state.tool_registry = ToolRegistry()
    app.state.plugins = []
    app.state.behaviour_registry = None
    app.state.behaviour_dispatcher = None
    app.state.command_registry = None
    app.state.telemetry = None
    app.state.node_identity = None
    app.state.auth_public_pem = None
    app.state.auth_private_pem = None

    app.add_middleware(AuthMiddleware)
    app.add_middleware(SecurityHeadersMiddleware)
    http = load_http_settings()
    cors_origins = _resolve_cors_origins(http.cors_origins)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=cors_origins,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    app.include_router(router)
    return app


def _resolve_cors_origins(raw: str) -> list[str]:
    """Parse the comma-separated `EIDAN_HTTP_CORS_ORIGINS` value into
    an allow-list, and refuse the dangerous ``*`` + credentials combo
    in production.

    Browsers reject ``Access-Control-Allow-Origin: *`` paired with
    ``Access-Control-Allow-Credentials: true`` per the CORS spec, but
    starlette's CORSMiddleware does not. An operator who sets
    ``EIDAN_HTTP_CORS_ORIGINS=*`` in production turns the backend into
    a CSRF surface against any browser tab the operator's session
    cookie reaches. Refuse at startup with an actionable message.

    Dev / single-operator local installs (no `EIDAN_DEPLOYMENT_MODE=production`)
    keep the wildcard for convenience.
    """
    origins = [o.strip() for o in raw.split(",") if o.strip()]
    if "*" in origins:
        is_production = (
            os.environ.get("EIDAN_DEPLOYMENT_MODE") == "production"
        )
        if is_production:
            raise RuntimeError(
                "EIDAN_HTTP_CORS_ORIGINS contains '*' and "
                "EIDAN_DEPLOYMENT_MODE=production. The CORS spec "
                "rejects '*' paired with allow_credentials=true; the "
                "backend would either fail every browser request or "
                "(with starlette's looser stance) open a CSRF window. "
                "Set EIDAN_HTTP_CORS_ORIGINS to the explicit origin(s) "
                "the UI runs on (e.g. https://app.eidan.dev) before "
                "starting in production."
            )
    return origins


# Module-level ``app`` for ``uvicorn eidan_backend.http:app`` / ASGI servers.
def _lazy_app() -> Any:
    """Build the app on first attribute access; lets imports succeed
    without env vars (tests import the package without DATABASE_URL set).
    """
    global _APP
    if _APP is None:
        _APP = create_app_from_env()
    return _APP


_APP: FastAPI | None = None


def __getattr__(name: str) -> Any:  # PEP 562 — module-level getattr
    if name == "app":
        return _lazy_app()
    raise AttributeError(name)
