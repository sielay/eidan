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


def _seed_plugins_volume_if_empty(resolved: Path) -> None:
    """First-boot bootstrap for a writable plugins volume.

    Operators running the published image plus a mounted volume (see
    ``docs/DEPLOYMENT.md §4`` — runtime plugin install) point
    ``EIDAN_PLUGINS_DIR`` at e.g. ``/var/lib/eidan/plugins``. The
    volume is empty on first boot; without seeding, the host would
    activate zero plugins and the operator would have to run
    ``eidan admin plugin install`` for every core plugin before the
    machine becomes useful. Instead we copy the image-baked
    :data:`_DEFAULT_PLUGINS_DIR` into the volume on first boot so the
    repo-shipped tier-core plugins are present immediately. Subsequent
    boots find a populated volume and skip the seed.

    Skipped when:

    - ``resolved`` is the image-baked default (no volume in play);
    - the volume already has any child directory (already seeded or
      operator-populated via ``plugin install``);
    - the image-baked dir does not exist or has no children (running
      outside an image — e.g. a test that only wired the env override
      to redirect reads).

    The "non-empty" check looks for at least one child directory, not
    just any child entry. A pre-created ``plugins/.lock`` (or any other
    dotfile / file) does not count as a populated volume — without this
    distinction an operator who hand-seeded a lock file before first
    boot would end up with a backend running with zero core plugins.
    """
    if resolved == _DEFAULT_PLUGINS_DIR:
        return
    try:
        resolved.mkdir(parents=True, exist_ok=True)
        if any(child.is_dir() for child in resolved.iterdir()):
            return
    except OSError as exc:
        logger.warning(
            "[plugins] could not inspect %s for seeding: %s", resolved, exc
        )
        return
    if not _DEFAULT_PLUGINS_DIR.is_dir():
        return
    children = [c for c in _DEFAULT_PLUGINS_DIR.iterdir() if c.is_dir()]
    if not children:
        return
    seeded: list[str] = []
    for child in children:
        target = resolved / child.name
        try:
            shutil.copytree(child, target)
        except OSError as exc:
            logger.warning(
                "[plugins] failed to seed %s into volume: %s", child.name, exc
            )
            continue
        seeded.append(child.name)
    if seeded:
        logger.info(
            "[plugins] seeded %d image-baked plugin(s) into %s: %s",
            len(seeded),
            resolved,
            ", ".join(sorted(seeded)),
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
