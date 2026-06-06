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

import importlib
import inspect
import logging
import os
from collections.abc import AsyncIterator, Iterable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import asyncpg

from .behaviours import Behaviour, BehaviourDispatcher, BehaviourRegistry
from .memory_tools import register_memory_tools
from .node_identity import NodeIdentity
from .node_identity import detect as detect_node_identity
from .notifications import NotificationRouter, build_default_router
from .notify_routes import make_route_resolver
from .persistence import flag_orphaned_assistant_messages
from .plugin_tools import register_plugin_tools
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
      cron- and schedule-triggered behaviours, and also the
      ``publish_event`` accessor plugins receive via
      ``ctx.publish_event``. Constructed whenever any plugins are
      discovered, even if none of them register behaviours, so the
      event-bus publish path is always wired. ``None`` only on the
      empty-plugins early-return. ``start()`` runs only when the
      registry has at least one behaviour AND ``start_dispatcher``
      is True; stopped in :func:`shutdown`.
    """

    plugins: list[LoadedPlugin]
    tool_registry: ToolRegistry
    behaviour_registry: BehaviourRegistry = field(default_factory=BehaviourRegistry)
    behaviour_dispatcher: BehaviourDispatcher | None = None
    # Per-node telemetry emitter. Started in :func:`bootstrap`, stopped
    # in :func:`shutdown`. ``None`` when the caller opted out via
    # ``start_telemetry=False`` OR when the eager heartbeat raised
    # (the bootstrap wrapper logs and sets this to None so milestone
    # emits below skip cleanly).
    telemetry: TelemetryEmitter | None = None
    # Resolved by :func:`bootstrap` unconditionally — identity is
    # cheap (pure Python, no DB / network) and host-global; HTTP
    # routes and future plugin call sites may want it even when
    # telemetry itself is disabled. The ``| None`` type slot exists
    # only because the dataclass needs a default.
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
    behaviour_dispatcher: BehaviourDispatcher | None = None,
    telemetry_holder: list[Any] | None = None,
) -> Any:
    """Build a :class:`ContextFactory` closed over the host's wiring.

    ``provider`` + ``default_model`` are optional: when provided, the
    factory exposes a ``ctx.spawn_turn`` accessor that lets plugins
    initiate agent turns without an inbound user JWT. When not
    provided (unit-test boot, "no LLM creds" mode), ``ctx.spawn_turn``
    is ``None`` so plugins can detect the absence and fall back to
    writing an escalation.

    ``behaviour_dispatcher`` is optional for the same reason: when
    provided, plugins receive a ``ctx.publish_event`` accessor bound
    to :meth:`BehaviourDispatcher.publish_event` so they can emit on
    the same event bus they subscribe to via the manifest's
    ``behaviours[]``. When ``None`` (deactivate path, degraded boots),
    ``ctx.publish_event`` is ``None`` and plugins must detect the
    absence.
    """
    secret_accessor = make_secret_accessor(pool)
    notify_callable = _make_notify_callable(notification_router)
    route_resolver = make_route_resolver(notification_router)
    notify_topic_callable = (
        route_resolver.emit if route_resolver is not None else None
    )
    spawn_turn_callable = _make_spawn_turn_callable(
        pool,
        provider,
        default_model,
        tool_registry,
        telemetry_holder=telemetry_holder,
    )
    assess_sufficiency_callable = _make_sufficiency_assessor(provider, default_model)
    publish_event_callable = (
        behaviour_dispatcher.publish_event if behaviour_dispatcher is not None else None
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
            notify_topic=notify_topic_callable,
            spawn_turn=spawn_turn_callable,
            assess_sufficiency=assess_sufficiency_callable,
            publish_event=publish_event_callable,
            identity=None,
        )

    return _factory


def _make_spawn_turn_callable(
    pool: asyncpg.Pool,
    provider: Any | None,
    default_model: str | None,
    tool_registry: ToolRegistry,
    telemetry_holder: list[Any] | None = None,
) -> Any:
    """Bind :func:`run_agent_initiated_turn` to the host's pool +
    provider + model so plugins receive a ``ctx.spawn_turn(...)``
    accessor that takes only the per-call shape (user_id, agent_name,
    prompt_text).

    Returns ``None`` when either the provider or the default model is
    missing (test boots, degraded starts) so plugins can detect the
    absence via ``ctx.spawn_turn is None`` and fall back to writing an
    escalation instead.

    ``telemetry_holder`` is a one-element list bootstrap populates
    *after* the emitter is built (the emitter needs the activated
    plugin snapshot, which the factory doesn't have at construction
    time). When set, the closure reads through the holder at each
    spawn so plugin-initiated turns inherit the host's emitter and
    drop the `agent.turn.*` beacons #172 wired up. When unset
    (test boots, degraded starts), spawns just don't emit.
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
        telemetry = (
            telemetry_holder[0]
            if telemetry_holder is not None and telemetry_holder
            else None
        )
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
            telemetry=telemetry,
        )

    return _spawn_turn


def _make_sufficiency_assessor(
    provider: Any | None,
    default_model: str | None,
) -> Any:
    """Bind :func:`assess_sufficiency` to the host's provider + model so a
    plugin gets a ``ctx.assess_sufficiency(goal, gathered)`` accessor — the
    loop-level second-voice critic (#186 / `docs/027 §5`).

    ``None`` when no provider / model is wired (test boots, degraded
    starts), so a consumer falls back to the investigator's own ``[DONE]``
    self-declaration via ``if ctx.assess_sufficiency is None``.
    """
    if provider is None or default_model is None:
        return None

    from .sufficiency import assess_sufficiency

    async def _assess(*, goal: str, gathered: str) -> Any:
        return await assess_sufficiency(
            provider=provider,
            model=default_model,
            goal=goal,
            gathered=gathered,
        )

    return _assess


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


def _register_declared_notification_adapters(
    plugins: list[LoadedPlugin],
    router: NotificationRouter,
    secret: Any,
) -> None:
    """Walk each plugin's ``manifest.notifications.adapters[]`` and
    register the resolved :class:`NotificationAdapter` on the host
    router (`docs/001 §6`).

    Factory contract: a ``module:func`` entrypoint resolving to a
    callable ``factory(secret) -> NotificationAdapter``. The factory
    is called once at bootstrap; the resulting coroutine is what
    ``router.notify(channel, ...)`` dispatches to.

    Bootstrap-fatal on any failure (bad import, bad factory shape,
    duplicate channel). A notification path that silently doesn't
    register is exactly the failure mode :class:`NotificationError`
    is designed to prevent — operators learn at boot, not when the
    first nudge silently disappears.
    """
    for loaded in plugins:
        notifications = getattr(loaded.manifest, "notifications", None)
        if notifications is None:
            continue
        for entry in notifications.adapters:
            module_path, _, func_name = entry.factory.partition(":")
            if not module_path or not func_name:
                raise RuntimeError(
                    f"plugin {loaded.manifest.name!r}: notifications "
                    f"adapter factory {entry.factory!r} is not a valid "
                    "'module:func' entrypoint"
                )
            try:
                module = importlib.import_module(module_path)
            except ImportError as exc:
                raise RuntimeError(
                    f"plugin {loaded.manifest.name!r}: cannot import "
                    f"notifications adapter factory {entry.factory!r}: {exc}"
                ) from exc
            factory = getattr(module, func_name, None)
            if factory is None:
                raise RuntimeError(
                    f"plugin {loaded.manifest.name!r}: notifications "
                    f"adapter factory {func_name!r} not found in "
                    f"{module_path!r}"
                )
            try:
                # Pass `secret` only when the factory declares it.
                # Some plugins use a keyword-only `*, secret=...`
                # parameter (idiomatic when the factory's contract is
                # "I'll ask you for what I need"); others — usually
                # stateless adapters that read config from env — take
                # no args at all. Inspect once + call with the right
                # kwargs so the contract stays permissive.
                #
                # We don't pass `secret` positionally because the slack
                # plugin (and others) declare keyword-only — positional
                # would crash with "takes 0 positional arguments but 1
                # was given" even though the parameter exists.
                sig = inspect.signature(factory)
                kwargs: dict[str, Any] = {}
                if "secret" in sig.parameters:
                    kwargs["secret"] = secret
                adapter = factory(**kwargs)
            except Exception as exc:  # noqa: BLE001 — narrow & rewrap
                raise RuntimeError(
                    f"plugin {loaded.manifest.name!r}: notifications "
                    f"adapter factory {entry.factory!r} raised at "
                    f"construction: {exc}"
                ) from exc
            try:
                router.register(entry.channel, adapter)
            except ValueError as exc:
                # NotificationRouter raises ValueError on duplicate; rewrap so
                # the operator sees which plugin tried to double-register.
                raise RuntimeError(
                    f"plugin {loaded.manifest.name!r}: channel "
                    f"{entry.channel!r} already registered (host default "
                    "or another plugin claimed it first)"
                ) from exc
            logger.info(
                "[notifications] registered %r adapter from plugin %r",
                entry.channel,
                loaded.manifest.name,
            )


class BootstrapNotMigratedError(RuntimeError):
    """Raised when bootstrap can't reach ``eidan.plugin_state``.

    Most likely cause: the operator started the REPL / server before
    running ``eidan admin db migrate``. The message is surfaced verbatim
    to the user so the fix is obvious.
    """


def _disabled_plugins_from_env() -> set[str]:
    """Parse ``EIDAN_DISABLED_PLUGINS`` into a set of plugin names.

    Comma-separated, case-sensitive, whitespace around each entry is
    trimmed, empty entries dropped. Unset or empty → empty set (no
    filtering). The loader treats unknown names as a soft warning, so
    operators can safely ship the same value across nodes with
    different installed bundles.
    """
    raw = os.environ.get("EIDAN_DISABLED_PLUGINS", "")
    return {name.strip() for name in raw.split(",") if name.strip()}


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

    plugins = load_plugins(plugins_dir, disabled=_disabled_plugins_from_env())
    if not plugins:
        logger.info("[bootstrap] no plugins discovered under %s", plugins_dir)
        tool_registry = _make_tool_registry_with_core_tools(pool)
        # Plugin-introspection tools are useful even on a core-only
        # host — answering "what plugins are loaded?" with an empty
        # list is more helpful than the agent guessing.
        register_plugin_tools(tool_registry, plugins=[])
        return BootstrapResult(plugins=[], tool_registry=tool_registry)

    logger.info(
        "[bootstrap] loaded %d plugin(s): %s",
        len(plugins),
        ", ".join(p.manifest.name for p in plugins),
    )

    tool_registry = _make_tool_registry_with_core_tools(pool)
    # Register plugin-introspection tools AFTER load_plugins so the
    # closure inside `plugins_list` / `plugins_describe` sees the
    # final loaded set. The list doesn't mutate after this point;
    # capture by reference is safe.
    register_plugin_tools(tool_registry, plugins=plugins)
    behaviour_registry = BehaviourRegistry(tool_registry=tool_registry)
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
    # Construct the dispatcher BEFORE install_and_activate so the
    # context factory can bind ``ctx.publish_event`` to
    # :meth:`BehaviourDispatcher.publish_event`. The dispatcher reads
    # from ``behaviour_registry`` at call time, so behaviours
    # registered during activation are visible to the bus immediately.
    # ``start()`` still runs after activation, gated on the registry
    # having at least one behaviour and ``start_dispatcher`` being
    # True.
    # Holder lets the spawn-turn closure + the behaviour dispatcher see
    # the telemetry emitter once it's built — telemetry construction
    # needs the activated plugin snapshot (computed below), so neither
    # the factory nor the dispatcher can receive the emitter directly.
    # bootstrap() populates `telemetry_holder[0]` right after
    # `telemetry = TelemetryEmitter(...)` and both consumers read
    # through at fire/spawn time. See #174 (spawn-turn) + #179 (dispatcher).
    telemetry_holder: list[Any] = [None]
    _dispatch_resolver = make_route_resolver(notification_router)
    dispatcher = BehaviourDispatcher(
        behaviour_registry,
        pool=pool,
        telemetry_holder=telemetry_holder,
        notify_topic=(
            _dispatch_resolver.emit if _dispatch_resolver is not None else None
        ),
    )
    factory = _make_context_factory(
        pool,
        tool_registry,
        behaviour_registry,
        notification_router=notification_router,
        provider=provider,
        default_model=default_model,
        behaviour_dispatcher=dispatcher,
        telemetry_holder=telemetry_holder,
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

    # Register plugin-declared notification adapters BEFORE on_activate
    # runs (`docs/001 §6`). on_activate hooks may call ctx.notify, so
    # the router must be fully populated by the time the lifecycle
    # hooks fire. notification_router and the factory closure both
    # hold the same router reference; this is the population step
    # the factory's _make_notify_callable captures.
    _register_declared_notification_adapters(
        plugins, notification_router, secret_accessor
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

    # Start the per-node telemetry emitter. ``start()`` performs the
    # eager first heartbeat *strictly* — if it fails (table missing,
    # DB unreachable, RLS misconfiguration), the exception surfaces
    # here and we disable telemetry for this boot rather than fall
    # through into milestone emits that would silently FK-fail
    # (eidan.node_events.node_id references eidan.node_heartbeats).
    # The background loop inside start() keeps swallowing so a
    # transient blip later doesn't kill the heartbeat task.
    telemetry: TelemetryEmitter | None = None
    if start_telemetry:
        # Pass the loaded-plugin set so each heartbeat UPSERT records
        # what landed on this node (issue #52). Plugin discovery has
        # already run; the set is stable for this process's lifetime.
        plugin_snapshot = [
            {
                "name": p.manifest.name,
                "version": p.manifest.version,
                "tier": (
                    p.manifest.tier.value
                    if hasattr(p.manifest.tier, "value")
                    else str(p.manifest.tier)
                ),
            }
            for p in plugins
        ]
        telemetry = TelemetryEmitter(
            pool=pool, identity=node_identity, plugins=plugin_snapshot
        )
        try:
            await telemetry.start()
        except Exception:  # noqa: BLE001 — telemetry failure must not block boot
            logger.exception(
                "[bootstrap] telemetry start failed — heartbeat / events disabled"
            )
            telemetry = None
        # Populate the holder the context factory closes over so every
        # plugin-spawned turn from this point forward inherits the
        # emitter and drops the `agent.turn.*` beacons. See #174.
        telemetry_holder[0] = telemetry

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
    # empty registry. The dispatcher itself is constructed above so
    # the context factory can bind ``ctx.publish_event``; it carries
    # the pool so it can take cross-instance advisory locks before
    # firing cron / schedule jobs (`docs/021`). Without it, two
    # backend instances would double-fire the same behaviour every
    # minute.
    if behaviour_registry.all() and start_dispatcher:
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

    # Operator-routed startup notification (distinct from the telemetry
    # event above): lands on whatever channel this node's
    # ``EIDAN_NOTIFY_ROUTES`` maps ``node.startup`` to (e.g.
    # ``#eidan-deployments``). No route configured → silent no-op, and a
    # delivery failure is logged inside ``emit``, never raised — a boot
    # must not depend on a webhook.
    startup_resolver = make_route_resolver(notification_router)
    if startup_resolver is not None:
        await startup_resolver.emit(
            "node.startup",
            f"\U0001f7e2 {node_identity.node_id} started — "
            f"{len(plugins)} plugin(s), "
            f"{len(tool_registry.surface() or [])} tool(s)",
            severity="info",
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
