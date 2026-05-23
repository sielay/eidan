"""Host-side bootstrap — load and activate every plugin under ``plugins/``.

Called from the FastAPI app's lifespan and from the REPL's in-process
startup. Owns the wiring the plugin contract leaves to the host:

- Walking the on-disk ``plugins/`` tree via :func:`load_plugins`.
- Constructing each plugin's :class:`PluginContext` with the host's
  registrars (``register_tools`` writes into a shared
  :class:`ToolRegistry`, ``register_behaviours`` into a shared
  :class:`BehaviourRegistry`; ``register_router`` log-warns until the
  FastAPI app exposes mounting).
- Driving ``on_install`` (first run) + ``on_activate`` (every start)
  via :func:`install_and_activate`.
- Starting the :class:`BehaviourDispatcher` after all plugins have
  registered their behaviours, so cron triggers fire on schedule.

Returns the wired registries + dispatcher so the caller can hand the
``ToolRegistry`` to ``run_turn`` for every request and stop the
dispatcher cleanly at shutdown.
"""

from __future__ import annotations

import logging
from collections.abc import AsyncIterator, Iterable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import asyncpg

from .behaviours import Behaviour, BehaviourDispatcher, BehaviourRegistry
from .memory_tools import register_memory_tools
from .node_identity import NodeIdentity
from .node_identity import detect as detect_node_identity
from .notifications import build_default_router
from .persistence import flag_orphaned_assistant_messages
from .plugins import (
    AsyncpgPluginStateStore,
    LoadedPlugin,
    PluginContext,
    PluginStateStore,
    deactivate,
    install_and_activate,
    load_plugins,
    schema_for_plugin,
)
from .secrets import make_secret_accessor, validate_required_secrets
from .telemetry import TelemetryEmitter
from .tools import Tool, ToolRegistry

logger = logging.getLogger(__name__)


@dataclass(frozen=True, slots=True)
class BootstrapResult:
    """What the host needs after plugins have loaded.

    - ``plugins``             — the loaded units in topological order.
    - ``tool_registry``       — the host-shared registry every plugin
      contributed tools to. Pass to ``run_turn(tool_registry=...)``.
    - ``behaviour_registry``  — the host-shared behaviour catalogue
      every plugin contributed cron / event handlers to. The
      dispatcher reads from it.
    - ``behaviour_dispatcher`` — owns the APScheduler that fires
      cron-triggered behaviours. ``None`` when no plugins registered
      any behaviours; otherwise started in :func:`bootstrap` and
      stopped in :func:`shutdown`.
    """

    plugins: list[LoadedPlugin]
    tool_registry: ToolRegistry
    behaviour_registry: BehaviourRegistry = field(default_factory=BehaviourRegistry)
    behaviour_dispatcher: BehaviourDispatcher | None = None
    # Per-node telemetry emitter. Started in :func:`bootstrap`, stopped
    # in :func:`shutdown`. ``None`` only when the caller opted out via
    # ``start_telemetry=False`` (tests).
    telemetry: TelemetryEmitter | None = None
    node_identity: NodeIdentity | None = None


class _PluginDb:
    """Asyncpg accessor scoped to a plugin's private schema.

    On ``acquire()`` returns an async context manager that yields a
    connection with ``search_path`` set to the plugin's schema (then
    ``public``). The plugin can still query ``eidan.*`` with
    fully-qualified names — the search path biases unqualified lookups
    toward the plugin's own tables.
    """

    def __init__(self, pool: asyncpg.Pool, schema: str) -> None:
        self._pool = pool
        self._schema = schema

    def acquire(self) -> AsyncIterator[asyncpg.Connection]:
        return _PluginConnectionContext(self._pool, self._schema)


class _PluginConnectionContext:
    """Async context manager that yields a search_path-scoped connection."""

    def __init__(self, pool: asyncpg.Pool, schema: str) -> None:
        self._pool = pool
        self._schema = schema
        self._conn_cm: Any | None = None
        self._conn: asyncpg.Connection | None = None

    async def __aenter__(self) -> asyncpg.Connection:
        self._conn_cm = self._pool.acquire()
        self._conn = await self._conn_cm.__aenter__()
        await self._conn.execute(
            f'SET LOCAL search_path TO "{self._schema}", public'
        )
        return self._conn

    async def __aexit__(self, *args: Any) -> None:
        if self._conn_cm is not None:
            await self._conn_cm.__aexit__(*args)


def _make_context_factory(
    pool: asyncpg.Pool,
    tool_registry: ToolRegistry,
    behaviour_registry: BehaviourRegistry,
    notification_router: Any | None = None,
    provider: Any | None = None,
    default_model: str | None = None,
) -> Any:
    """Build a :class:`ContextFactory` closed over the host's wiring.

    ``provider`` + ``default_model`` are optional: when provided, the
    factory exposes a ``ctx.spawn_turn`` accessor that lets plugins
    initiate agent turns without an inbound user JWT. When not
    provided (unit-test boot, "no LLM creds" mode), ``ctx.spawn_turn``
    is ``None`` so plugins can detect the absence and fall back to
    writing an escalation.
    """
    secret_accessor = make_secret_accessor(pool)
    notify_callable = _make_notify_callable(notification_router)
    spawn_turn_callable = _make_spawn_turn_callable(
        pool, provider, default_model, tool_registry
    )

    def _factory(loaded: LoadedPlugin) -> PluginContext:
        schema = schema_for_plugin(loaded.manifest.name)

        def _register_tools(tools: Iterable[Tool]) -> None:
            for tool in tools:
                # Re-registration of the same tool name is a fatal
                # configuration error — surface it loudly rather than
                # silently overwriting one plugin's tool with another's.
                tool_registry.register(tool)

        def _register_router(_router: Any) -> None:
            # FastAPI router mounting against the manifest's
            # ``routes_prefix`` lands in a follow-up — the FastAPI app
            # owns the include_router call shape.
            logger.warning(
                "[bootstrap] plugin %s tried to register a router; "
                "router mounting not yet wired",
                loaded.manifest.name,
            )

        def _register_behaviours(behaviours: Iterable[Behaviour]) -> None:
            # Behaviour-registry wiring per docs/006. After
            # ``install_and_activate`` returns, the bootstrap starts the
            # dispatcher, which snapshots cron-triggered behaviours into
            # APScheduler. Re-registration of the same behaviour id is a
            # fatal configuration error (registry raises
            # BehaviourIdConflict) — same posture as the tool registry.
            behaviour_registry.register_all(behaviours)

        return PluginContext(
            name=loaded.manifest.name,
            db=_PluginDb(pool, schema),
            secret=secret_accessor,
            register_router=_register_router,
            register_behaviours=_register_behaviours,
            register_tools=_register_tools,
            notify=notify_callable,
            spawn_turn=spawn_turn_callable,
            identity=None,
        )

    return _factory


def _make_spawn_turn_callable(
    pool: asyncpg.Pool,
    provider: Any | None,
    default_model: str | None,
    tool_registry: ToolRegistry,
) -> Any:
    """Bind :func:`run_agent_initiated_turn` to the host's pool +
    provider + model so plugins receive a ``ctx.spawn_turn(...)``
    accessor that takes only the per-call shape (user_id, agent_name,
    prompt_text).

    Returns ``None`` when either the provider or the default model is
    missing (test boots, degraded starts) so plugins can detect the
    absence via ``ctx.spawn_turn is None`` and fall back to writing an
    escalation instead.
    """
    if provider is None or default_model is None:
        return None

    # Import inside the closure so the bootstrap module stays
    # importable without dragging in the loop's heavy provider deps
    # for tests that only exercise the lifecycle.
    from .loop import run_agent_initiated_turn

    def _spawn_turn(
        *,
        user_id: Any,
        agent_name: str,
        prompt_text: str,
        conversation_id: Any | None = None,
        conversation_title: str | None = None,
    ) -> Any:
        return run_agent_initiated_turn(
            pool=pool,
            provider=provider,
            model=default_model,
            user_id=user_id,
            agent_name=agent_name,
            prompt_text=prompt_text,
            conversation_id=conversation_id,
            conversation_title=conversation_title,
            tool_registry=tool_registry,
        )

    return _spawn_turn


def _make_notify_callable(
    router: Any | None,
) -> Any:
    """Wrap a :class:`NotificationRouter` into the ``ctx.notify(channel,
    text, **kwargs)`` shape :class:`NotificationSender` expects.

    Returns ``None`` when no router is configured, so plugins can
    detect "no nudge channel available" with a simple ``if
    ctx.notify is None`` rather than catching an exception at
    runtime.
    """
    if router is None:
        return None

    async def _notify(
        channel: str,
        text: str,
        *,
        user_id: Any | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> Any:
        return await router.notify(
            channel=channel,
            text=text,
            user_id=user_id,
            metadata=metadata,
        )

    return _notify


class BootstrapNotMigratedError(RuntimeError):
    """Raised when bootstrap can't reach ``eidan.plugin_state``.

    Most likely cause: the operator started the REPL / server before
    running ``eidan admin db migrate``. The message is surfaced verbatim
    to the user so the fix is obvious.
    """


async def _plugin_state_exists(pool: asyncpg.Pool) -> bool:
    """Probe ``eidan.plugin_state`` existence without touching the table."""
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            """
            SELECT 1
            FROM information_schema.tables
            WHERE table_schema = 'eidan' AND table_name = 'plugin_state'
            LIMIT 1
            """
        )
    return row is not None


def _make_tool_registry_with_core_tools(
    pool: asyncpg.Pool,
) -> ToolRegistry:
    """Build a :class:`ToolRegistry` with the core memory tools
    pre-registered.

    Memory tools (`docs/025_AGENT_DB_INTROSPECTION.md`,
    :mod:`eidan_backend.memory_tools`) ship in core so the primary
    agent can query its own memory without a dedicated plugin. They
    register before plugin activation so plugins can compose against
    a known surface and the loop always has them whether plugins
    discover or not.
    """
    registry = ToolRegistry()
    register_memory_tools(registry, pool=pool)
    return registry


async def bootstrap(
    *,
    pool: asyncpg.Pool,
    plugins_dir: Path,
    state_store: PluginStateStore | None = None,
    start_dispatcher: bool = True,
    start_telemetry: bool = True,
    provider: Any | None = None,
    default_model: str | None = None,
) -> BootstrapResult:
    """Load and activate every plugin under ``plugins_dir``.

    Idempotent on ``on_install`` (the state store dedupes); ``on_activate``
    runs every call. Safe to call once per host start.

    ``state_store`` is wired against the real ``eidan.plugin_state`` table
    by default; tests inject an in-memory implementation.

    ``start_dispatcher`` controls whether the :class:`BehaviourDispatcher`
    is started (cron triggers begin firing). Defaults to ``True`` for
    the production path; tests pass ``False`` so APScheduler doesn't
    fire jobs against a stub pool.

    ``start_telemetry`` controls whether the per-node heartbeat loop
    and event emitter start. Defaults to ``True`` for production;
    tests that don't have the ``eidan.node_heartbeats`` table
    populated pass ``False`` so the eager first heartbeat doesn't
    raise.

    Raises :class:`BootstrapNotMigratedError` if ``eidan.plugin_state``
    is missing — that's almost always "the operator forgot to run
    `eidan admin db migrate`", and the error message says so explicitly.
    Tests that pass a stub ``state_store`` skip the probe.
    """
    # Orphan-cleanup pre-flight (audit §11 fix). Flag any assistant
    # message left in flight by a previous process so the UI can
    # show "interrupted" rather than silently presenting a partial
    # turn. Cheap — single UPDATE with a WHERE that hits the right
    # partial index on `eidan.messages`. Idempotent.
    if state_store is None:
        async with pool.acquire() as conn:
            flagged = await flag_orphaned_assistant_messages(conn)
        if flagged:
            logger.info(
                "[bootstrap] flagged %d orphaned assistant message(s) from "
                "a previous process",
                flagged,
            )

    plugins = load_plugins(plugins_dir)
    if not plugins:
        logger.info("[bootstrap] no plugins discovered under %s", plugins_dir)
        tool_registry = _make_tool_registry_with_core_tools(pool)
        return BootstrapResult(plugins=[], tool_registry=tool_registry)

    logger.info(
        "[bootstrap] loaded %d plugin(s): %s",
        len(plugins),
        ", ".join(p.manifest.name for p in plugins),
    )

    tool_registry = _make_tool_registry_with_core_tools(pool)
    behaviour_registry = BehaviourRegistry()
    if state_store is None:
        if not await _plugin_state_exists(pool):
            raise BootstrapNotMigratedError(
                "eidan.plugin_state is missing. Run `eidan admin db migrate` "
                "(or `make migrate`) before starting the host."
            )
        state: PluginStateStore = AsyncpgPluginStateStore(pool)
    else:
        state = state_store
    notification_router = build_default_router()
    factory = _make_context_factory(
        pool,
        tool_registry,
        behaviour_registry,
        notification_router=notification_router,
        provider=provider,
        default_model=default_model,
    )

    # Validate every plugin's required ``vault[]`` keys BEFORE the
    # lifecycle hooks run (`docs/012` activation check). A missing
    # required key is a fatal start-up failure, not a runtime None.
    secret_accessor = make_secret_accessor(pool)
    for loaded in plugins:
        declared = getattr(loaded.manifest, "vault", None) or []
        await validate_required_secrets(
            secret_accessor,
            plugin_name=loaded.manifest.name,
            declared=list(declared),
        )

    await install_and_activate(
        plugins,
        state=state,
        context_factory=factory,
    )

    # Resolve this process's node identity once. Cached on the
    # BootstrapResult so HTTP routes / future call sites can read
    # it without re-running the platform fingerprint detector.
    node_identity = detect_node_identity()
    logger.info(
        "[bootstrap] node identity: %s (type=%s)",
        node_identity.node_id,
        node_identity.node_type,
    )

    # Start the per-node telemetry emitter. The eager first heartbeat
    # has to succeed before any event_emit can land (FK constraint),
    # so this runs *before* the boot/plugin.activate events below.
    telemetry: TelemetryEmitter | None = None
    if start_telemetry:
        telemetry = TelemetryEmitter(pool=pool, identity=node_identity)
        try:
            await telemetry.start()
        except Exception:  # noqa: BLE001 — telemetry failure must not block boot
            logger.exception(
                "[bootstrap] telemetry start failed — heartbeat / events disabled"
            )
            telemetry = None

    # One milestone event per plugin we just activated. Cheap; lands
    # the activation trail in node_events for post-boot inspection.
    if telemetry is not None:
        for loaded in plugins:
            await telemetry.emit_event(
                "plugin.activate",
                {
                    "plugin": loaded.manifest.name,
                    "version": loaded.manifest.version,
                },
            )

    # Start the behaviour dispatcher only when any plugin actually
    # registered behaviours — no point spinning up APScheduler for an
    # empty registry. The dispatcher is owned by the BootstrapResult so
    # ``shutdown()`` can stop it cleanly.
    dispatcher: BehaviourDispatcher | None = None
    if behaviour_registry.all():
        # Pass the pool so the dispatcher can take cross-instance
        # advisory locks before firing cron / schedule jobs
        # (`docs/021`). Without it, two backend instances would
        # double-fire the same behaviour every minute.
        dispatcher = BehaviourDispatcher(behaviour_registry, pool=pool)
        if start_dispatcher:
            dispatcher.start()
            cron_count = len(behaviour_registry.by_trigger_kind("cron"))
            logger.info(
                "[bootstrap] behaviour dispatcher started with %d cron job(s)",
                cron_count,
            )
            if telemetry is not None:
                await telemetry.emit_event(
                    "dispatcher.started",
                    {"cron_jobs": cron_count},
                )

    if telemetry is not None:
        await telemetry.emit_event(
            "node.boot",
            {
                "plugins": [p.manifest.name for p in plugins],
                "tool_count": len(tool_registry.surface() or []),
                "metadata": node_identity.metadata,
            },
        )

    return BootstrapResult(
        plugins=plugins,
        tool_registry=tool_registry,
        behaviour_registry=behaviour_registry,
        behaviour_dispatcher=dispatcher,
        telemetry=telemetry,
        node_identity=node_identity,
    )


async def shutdown(
    *,
    pool: asyncpg.Pool,
    bootstrap_result: BootstrapResult,
) -> None:
    """Mirror :func:`bootstrap` — stop the dispatcher, run ``on_deactivate``
    in reverse order.

    Called from the FastAPI lifespan's teardown branch. Catches per-plugin
    exceptions so a misbehaving plugin doesn't block the rest from shutting
    down cleanly (see :func:`deactivate`).
    """
    if bootstrap_result.behaviour_dispatcher is not None:
        try:
            bootstrap_result.behaviour_dispatcher.shutdown()
        except Exception:  # noqa: BLE001 — never block plugin teardown
            logger.exception("[shutdown] behaviour dispatcher raised")

    # Emit the shutdown milestone before stopping the heartbeat — once
    # the loop is cancelled the event-emit transaction is still safe
    # (uses the same pool, not the loop's state), but ordering keeps
    # the journal trail readable.
    if bootstrap_result.telemetry is not None:
        try:
            await bootstrap_result.telemetry.emit_event(
                "node.shutdown",
                {"plugins": [p.manifest.name for p in bootstrap_result.plugins]},
            )
        except Exception:  # noqa: BLE001 — never block teardown
            logger.exception("[shutdown] telemetry emit_event raised")
        try:
            await bootstrap_result.telemetry.stop()
        except Exception:  # noqa: BLE001 — never block teardown
            logger.exception("[shutdown] telemetry stop raised")

    factory = _make_context_factory(
        pool,
        bootstrap_result.tool_registry,
        bootstrap_result.behaviour_registry,
        notification_router=build_default_router(),
    )
    await deactivate(bootstrap_result.plugins, context_factory=factory)


__all__ = ["BootstrapResult", "bootstrap", "shutdown"]
