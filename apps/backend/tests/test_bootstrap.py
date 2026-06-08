"""Tests for :func:`eidan_backend.bootstrap.bootstrap`.

The bootstrap is the host's wire-up between the plugin loader and the
agent-loop tool registry. The test exercises the contract against a
staged plugin tree:

- a copy of ``plugins/example-core/`` (loads cleanly per the bot's
  Phase-4 fixtures) and
- a copy of ``plugins/learn/`` (registers a tool via the new
  ``register_tools`` surface).

A pool-less fake gets us past the lifecycle's state-store call; the
plugin context's ``ctx.db`` and the state-store argument are stubbed
so the test stays self-contained (no Postgres needed).
"""

from __future__ import annotations

import shutil
from pathlib import Path
from typing import Any
from uuid import UUID, uuid4

import pytest
from apscheduler.schedulers.asyncio import AsyncIOScheduler
from eidan_backend.behaviours import (
    Behaviour,
    BehaviourDispatcher,
    BehaviourRegistry,
    BehaviourResult,
    TriggerEvent,
    parse_trigger,
)
from eidan_backend.bootstrap import (
    _disabled_plugins_from_env,
    _make_context_factory,
    _make_spawn_turn_callable,
    _register_declared_notification_adapters,
    bootstrap,
)
from eidan_backend.escalations import EscalationReason, EscalationSeverity
from eidan_backend.notifications import (
    NotificationAdapter,
    NotificationResult,
    NotificationRouter,
)
from eidan_backend.plugins import LoadedPlugin, PluginBase, load_manifest
from eidan_backend.tools import ToolRegistry

# Memory introspection tools (docs/025) that the bootstrap pre-registers
# on the tool registry, with or without plugins. Kept in lockstep with
# eidan_backend.memory_tools.register_memory_tools.
_MEMORY_TOOL_NAMES = frozenset(
    {
        "memory_events_due",
        "memory_list_knowledge",
        "memory_get_knowledge",
        "memory_recall",
        "memory_notes_recent",
        "memory_user_context",
        "memory_query_sql",
    }
)

# Plugin-introspection tools the host always registers, alongside
# the memory tools above. Kept in lockstep with
# eidan_backend.plugin_tools.register_plugin_tools.
_PLUGIN_INTROSPECTION_TOOL_NAMES = frozenset(
    {
        "plugins_list",
        "plugins_describe",
    }
)


class _InMemoryStateStore:
    """Mirrors the bot's ``_InMemoryStateStore`` from ``test_plugin_loader``."""

    def __init__(self) -> None:
        self._installed: set[str] = set()

    async def is_installed(self, name: str) -> bool:
        return name in self._installed

    async def mark_installed(self, name: str, version: str) -> None:
        self._installed.add(name)

    async def mark_uninstalled(self, name: str) -> None:
        self._installed.discard(name)


class _FakePool:
    """Pool stand-in. The bootstrap wraps it in a ``_PluginDb`` whose
    ``acquire()`` is never called during install/activate for these
    plugins — neither example-core nor learn touches the DB in
    ``on_activate``. A real test that hits the DB swaps in pytest-postgresql.
    """

    def acquire(self) -> Any:
        raise NotImplementedError("the test plugins should not call db.acquire()")


_EXAMPLE_CORE_DIR = (
    Path(__file__).resolve().parents[3] / "plugins" / "example-core"
)


class _StubPluginBase(PluginBase):
    """No-op subclass so :class:`LoadedPlugin` has a concrete ``plugin``
    attribute when a test builds the loader's record by hand. The
    publish-event wiring tests never invoke the lifecycle hooks, but
    :class:`LoadedPlugin` keeps the field non-optional."""

    name = "stub"


def _stage_plugins(tmp_path: Path) -> Path:
    """Copy the real plugins into ``tmp_path/plugins`` for the loader."""
    src_root = Path(__file__).resolve().parents[3] / "plugins"
    dst_root = tmp_path / "plugins"
    dst_root.mkdir()
    for name in ("example-core", "example-behaviour", "learn", "capture"):
        shutil.copytree(src_root / name, dst_root / name)
    return dst_root


@pytest.mark.asyncio
async def test_bootstrap_activates_plugins_and_registers_tools(
    tmp_path: Path,
) -> None:
    plugins_dir = _stage_plugins(tmp_path)
    result = await bootstrap(
        pool=_FakePool(),  # type: ignore[arg-type]
        plugins_dir=plugins_dir,
        state_store=_InMemoryStateStore(),
        start_dispatcher=False,
    )

    names = {p.manifest.name for p in result.plugins}
    assert {"example-core", "learn", "capture"} <= names

    surface = result.tool_registry.surface() or []
    tool_names = {tool["name"] for tool in surface}
    # /learn registers one tool; /capture registers three (remember, note,
    # event). Core also pre-registers the memory introspection tools
    # (docs/025) and the plugin-introspection tools (#136) so the
    # agent can query its own state and its loaded plugin set.
    assert {"learn", "remember", "note", "event"} <= tool_names
    assert _MEMORY_TOOL_NAMES <= tool_names
    assert _PLUGIN_INTROSPECTION_TOOL_NAMES <= tool_names


@pytest.mark.asyncio
async def test_bootstrap_returns_empty_when_no_plugins(tmp_path: Path) -> None:
    """An empty ``plugins/`` directory is a valid deployment shape —
    the bootstrap returns an empty registry rather than raising."""
    (tmp_path / "plugins").mkdir()
    result = await bootstrap(
        pool=_FakePool(),  # type: ignore[arg-type]
        plugins_dir=tmp_path / "plugins",
        state_store=_InMemoryStateStore(),
        start_dispatcher=False,
    )
    assert result.plugins == []
    # Even with no plugins, core registers the memory introspection
    # tools (docs/025) AND the plugin-introspection tools (#136) so
    # the agent has its read surface available and can answer
    # "what plugins are loaded?" with an honest empty list.
    surface_names = {t["name"] for t in (result.tool_registry.surface() or [])}
    assert surface_names == _MEMORY_TOOL_NAMES | _PLUGIN_INTROSPECTION_TOOL_NAMES
    assert result.behaviour_dispatcher is None


@pytest.mark.asyncio
async def test_bootstrap_idempotent_on_repeat(tmp_path: Path) -> None:
    """A second bootstrap with the same state store activates without
    re-running ``on_install``. The bot's lifecycle handles that via
    the state store; this test asserts the contract end-to-end."""
    plugins_dir = _stage_plugins(tmp_path)
    state = _InMemoryStateStore()

    first = await bootstrap(
        pool=_FakePool(),  # type: ignore[arg-type]
        plugins_dir=plugins_dir,
        state_store=state,
        start_dispatcher=False,
    )
    second = await bootstrap(
        pool=_FakePool(),  # type: ignore[arg-type]
        plugins_dir=plugins_dir,
        state_store=state,
        start_dispatcher=False,
    )

    first_tools = {t["name"] for t in (first.tool_registry.surface() or [])}
    second_tools = {t["name"] for t in (second.tool_registry.surface() or [])}
    assert first_tools == second_tools
    assert {"learn", "remember", "note", "event"} <= first_tools
    assert _MEMORY_TOOL_NAMES <= first_tools


@pytest.mark.asyncio
async def test_bootstrap_registers_behaviours_and_creates_dispatcher(
    tmp_path: Path,
) -> None:
    """example-behaviour ships a cron-triggered ``tick`` behaviour. After
    bootstrap, the behaviour registry holds it and the dispatcher exists
    (we don't `start_dispatcher` here so APScheduler stays cold)."""
    plugins_dir = _stage_plugins(tmp_path)
    result = await bootstrap(
        pool=_FakePool(),  # type: ignore[arg-type]
        plugins_dir=plugins_dir,
        state_store=_InMemoryStateStore(),
        start_dispatcher=False,
    )

    behaviour_ids = {b.id for b in result.behaviour_registry.all()}
    assert "example-behaviour:tick" in behaviour_ids
    assert result.behaviour_dispatcher is not None


@pytest.mark.asyncio
async def test_context_factory_binds_publish_event_to_dispatcher(
    tmp_path: Path,
) -> None:
    """A :class:`PluginContext` built by the bootstrap factory MUST
    expose ``ctx.publish_event`` wired to the same
    :class:`BehaviourDispatcher` the host owns, so plugins fan out
    through the standard idempotency-key + per-subscriber dedupe
    path rather than a parallel bus.

    Covers `docs/001 §2.2` (publish side) and the issue-15 contract.
    """
    fired: list[TriggerEvent] = []

    async def _subscriber(event: TriggerEvent) -> BehaviourResult:
        fired.append(event)
        return BehaviourResult(ok=True)

    registry = BehaviourRegistry()
    registry.register(
        Behaviour(
            id="example-core:probe-sub",
            trigger=parse_trigger("event:probe.fired"),
            handler=_subscriber,
        )
    )
    dispatcher = BehaviourDispatcher(registry, scheduler=AsyncIOScheduler())

    factory = _make_context_factory(
        _FakePool(),  # type: ignore[arg-type]
        ToolRegistry(),
        registry,
        behaviour_dispatcher=dispatcher,
    )
    loaded = LoadedPlugin(
        manifest=load_manifest(_EXAMPLE_CORE_DIR),
        plugin=_StubPluginBase(),  # type: ignore[arg-type]
        plugin_dir=_EXAMPLE_CORE_DIR,
    )
    ctx = factory(loaded)

    assert ctx.publish_event is not None
    results = await ctx.publish_event("probe.fired", {"payload": 1})

    assert len(results) == 1
    assert results[0].ok is True
    assert [e.payload["payload"] for e in fired] == [1]


@pytest.mark.asyncio
async def test_context_factory_publish_event_is_none_without_dispatcher(
    tmp_path: Path,
) -> None:
    """The factory must tolerate the degraded-boot path: when no
    dispatcher is wired (deactivate path, future test stubs),
    ``ctx.publish_event`` is ``None`` so plugins can fall back."""
    factory = _make_context_factory(
        _FakePool(),  # type: ignore[arg-type]
        ToolRegistry(),
        BehaviourRegistry(),
        behaviour_dispatcher=None,
    )
    loaded = LoadedPlugin(
        manifest=load_manifest(_EXAMPLE_CORE_DIR),
        plugin=_StubPluginBase(),  # type: ignore[arg-type]
        plugin_dir=_EXAMPLE_CORE_DIR,
    )
    ctx = factory(loaded)

    assert ctx.publish_event is None


# ---------- ctx.escalate (#271) -----------------------------------------------


class _RecordingConn:
    """Captures the args of every ``execute`` so a test can assert what
    :func:`record_escalation` wrote without a real Postgres."""

    def __init__(self) -> None:
        self.calls: list[tuple[str, tuple[Any, ...]]] = []

    async def execute(self, query: str, *args: Any) -> str:
        self.calls.append((query, args))
        return "INSERT 0 1"


class _RecordingPool:
    """Pool stand-in whose ``acquire()`` yields a connection that records
    its ``execute`` calls. Doubles as its own async context manager."""

    def __init__(self) -> None:
        self.conn = _RecordingConn()

    def acquire(self) -> Any:
        return self

    async def __aenter__(self) -> _RecordingConn:
        return self.conn

    async def __aexit__(self, *_args: Any) -> bool:
        return False


@pytest.mark.asyncio
async def test_context_factory_escalate_writes_row() -> None:
    """``ctx.escalate`` MUST write one ``eidan.escalations`` row via
    :func:`record_escalation`, owned by the caller-supplied ``user_id``,
    and return the new row id — so an autonomous behaviour's blocker
    lands in the operator inbox (`docs/022`, #271)."""
    pool = _RecordingPool()
    factory = _make_context_factory(
        pool,  # type: ignore[arg-type]
        ToolRegistry(),
        BehaviourRegistry(),
    )
    loaded = LoadedPlugin(
        manifest=load_manifest(_EXAMPLE_CORE_DIR),
        plugin=_StubPluginBase(),  # type: ignore[arg-type]
        plugin_dir=_EXAMPLE_CORE_DIR,
    )
    ctx = factory(loaded)
    assert ctx.escalate is not None

    user_id = uuid4()
    row_id = await ctx.escalate(
        user_id=user_id,
        severity=EscalationSeverity.MEDIUM,
        reason_class=EscalationReason.AMBIGUOUS_INTENT,
        suggested_action="confirm the licensing model for the new plugin",
        evidence=("https://github.com/owner/repo/pull/10",),
        metadata={"repo": "owner/repo", "pr_number": 10},
    )

    assert isinstance(row_id, UUID)
    assert len(pool.conn.calls) == 1
    query, args = pool.conn.calls[0]
    assert "INSERT INTO eidan.escalations" in query
    # record_escalation arg order: row_id, user_id, conversation_id,
    # agent_id, severity, reason_class, suggested_action, evidence, metadata.
    assert args[0] == row_id
    assert args[1] == user_id
    assert args[4] == "medium"
    assert args[5] == "ambiguous_intent"


@pytest.mark.asyncio
async def test_context_factory_escalate_rejects_null_user() -> None:
    """The inbox is user-scoped (``user_id`` NOT NULL). A null user_id
    MUST raise an actionable error before touching the pool — autonomous
    callers with no originating user fall back to ``notify_topic``."""
    pool = _FakePool()  # .acquire() raises if touched
    factory = _make_context_factory(
        pool,  # type: ignore[arg-type]
        ToolRegistry(),
        BehaviourRegistry(),
    )
    loaded = LoadedPlugin(
        manifest=load_manifest(_EXAMPLE_CORE_DIR),
        plugin=_StubPluginBase(),  # type: ignore[arg-type]
        plugin_dir=_EXAMPLE_CORE_DIR,
    )
    ctx = factory(loaded)
    assert ctx.escalate is not None

    with pytest.raises(ValueError, match="user_id"):
        await ctx.escalate(
            user_id=None,
            severity=EscalationSeverity.MEDIUM,
            reason_class=EscalationReason.AMBIGUOUS_INTENT,
        )


# ---------- EIDAN_DISABLED_PLUGINS env parsing --------------------------------


def test_disabled_plugins_from_env_unset(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("EIDAN_DISABLED_PLUGINS", raising=False)
    assert _disabled_plugins_from_env() == set()


def test_disabled_plugins_from_env_empty(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("EIDAN_DISABLED_PLUGINS", "")
    assert _disabled_plugins_from_env() == set()


def test_disabled_plugins_from_env_single(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("EIDAN_DISABLED_PLUGINS", "imap")
    assert _disabled_plugins_from_env() == {"imap"}


def test_disabled_plugins_from_env_multiple_with_whitespace(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Operator-friendly: pad commas with spaces, mix empties — all
    normalised to a clean set."""
    monkeypatch.setenv("EIDAN_DISABLED_PLUGINS", "  imap, sentry ,,calendar,  ")
    assert _disabled_plugins_from_env() == {"imap", "sentry", "calendar"}


# ---------- notifications.adapters[] registration ------------------------------


async def _stub_secret(key: str) -> str | None:
    return None


async def _stub_adapter(payload: dict[str, Any]) -> NotificationResult:
    return NotificationResult(
        channel="stub", message_id="m1", delivered_at="1970-01-01T00:00:00+00:00"
    )


def _make_loaded_plugin(
    *,
    name: str,
    notifications: Any,
    plugin_dir: Path,
) -> LoadedPlugin:
    """Hand-build a :class:`LoadedPlugin` carrying just enough manifest
    surface for the adapter-registration tests. Real manifests in the
    full suite cover the loader path end-to-end; this fixture lets us
    test the registration helper in isolation."""

    class _ManifestStub:
        def __init__(self, name: str, notifications: Any) -> None:
            self.name = name
            self.version = "0.1.0"
            self.tier = "pro"
            self.notifications = notifications

    return LoadedPlugin(
        manifest=_ManifestStub(name, notifications),  # type: ignore[arg-type]
        plugin=_StubPluginBase(),
        plugin_dir=plugin_dir,
    )


def test_register_declared_adapters_imports_factory_and_registers(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Happy path: a plugin declaring ``notifications.adapters[]`` has
    its factory imported, called with the secret accessor, and the
    returned adapter registered on the router under the declared
    channel."""
    captured: dict[str, Any] = {}

    def _factory(secret: Any) -> NotificationAdapter:
        captured["secret"] = secret
        return _stub_adapter

    # Stash on the helper module so we can resolve it via "module:func".
    module_name = "eidan_backend.bootstrap"
    monkeypatch.setattr(
        f"{module_name}._test_factory", _factory, raising=False
    )

    class _Adapter:
        channel = "stub"
        factory = f"{module_name}:_test_factory"

    class _Notifications:
        adapters = [_Adapter()]

    loaded = _make_loaded_plugin(
        name="stub-plugin", notifications=_Notifications(), plugin_dir=tmp_path
    )
    router = NotificationRouter()
    _register_declared_notification_adapters(
        [loaded], router, _stub_secret
    )

    assert router.channels() == ["stub"]
    assert captured["secret"] is _stub_secret


def test_register_declared_adapters_supports_keyword_only_secret(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Regression for #131. The slack plugin (and others) declare
    ``def build_adapter(*, secret: SecretAccessor)`` — keyword-only.
    Core must inspect the signature and pass ``secret`` as a kwarg
    rather than positional; calling positionally crashes with
    'takes 0 positional arguments but 1 was given' even though
    the parameter exists."""
    captured: dict[str, Any] = {}

    def _factory(*, secret: Any) -> NotificationAdapter:
        captured["secret"] = secret
        return _stub_adapter

    module_name = "eidan_backend.bootstrap"
    monkeypatch.setattr(
        f"{module_name}._kwonly_factory", _factory, raising=False
    )

    class _Adapter:
        channel = "kwonly"
        factory = f"{module_name}:_kwonly_factory"

    class _Notifications:
        adapters = [_Adapter()]

    loaded = _make_loaded_plugin(
        name="kw-plugin", notifications=_Notifications(), plugin_dir=tmp_path
    )
    router = NotificationRouter()
    _register_declared_notification_adapters(
        [loaded], router, _stub_secret
    )

    assert router.channels() == ["kwonly"]
    assert captured["secret"] is _stub_secret


def test_register_declared_adapters_supports_no_args_factory(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Stateless adapters that read config from env directly declare
    ``def build_adapter()`` (no params). Core must call them with
    no args; passing ``secret`` positionally OR as kwarg would
    crash."""

    def _factory() -> NotificationAdapter:
        return _stub_adapter

    module_name = "eidan_backend.bootstrap"
    monkeypatch.setattr(
        f"{module_name}._noargs_factory", _factory, raising=False
    )

    class _Adapter:
        channel = "noargs"
        factory = f"{module_name}:_noargs_factory"

    class _Notifications:
        adapters = [_Adapter()]

    loaded = _make_loaded_plugin(
        name="env-plugin", notifications=_Notifications(), plugin_dir=tmp_path
    )
    router = NotificationRouter()
    _register_declared_notification_adapters(
        [loaded], router, _stub_secret
    )

    assert router.channels() == ["noargs"]


def test_register_declared_adapters_skips_plugins_without_notifications(
    tmp_path: Path,
) -> None:
    """A plugin with no ``notifications`` field is a no-op — no
    registration, no error. Mirrors the optional-field contract."""
    loaded = _make_loaded_plugin(
        name="silent", notifications=None, plugin_dir=tmp_path
    )
    router = NotificationRouter()
    _register_declared_notification_adapters([loaded], router, _stub_secret)
    assert router.channels() == []


def test_register_declared_adapters_duplicate_channel_raises(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Two plugins (or a plugin + the host default) claiming the same
    channel is fatal: the operator sees which plugin tried to
    double-register, not a silent overwrite."""
    module_name = "eidan_backend.bootstrap"
    monkeypatch.setattr(
        f"{module_name}._dup_factory",
        lambda _secret: _stub_adapter,
        raising=False,
    )

    class _Adapter:
        channel = "dup"
        factory = f"{module_name}:_dup_factory"

    class _Notifications:
        adapters = [_Adapter()]

    loaded_a = _make_loaded_plugin(
        name="a", notifications=_Notifications(), plugin_dir=tmp_path
    )
    loaded_b = _make_loaded_plugin(
        name="b", notifications=_Notifications(), plugin_dir=tmp_path
    )
    router = NotificationRouter()
    with pytest.raises(RuntimeError, match="dup"):
        _register_declared_notification_adapters(
            [loaded_a, loaded_b], router, _stub_secret
        )


def test_register_declared_adapters_missing_factory_raises(
    tmp_path: Path,
) -> None:
    """Factory entrypoint that imports cleanly but doesn't resolve to
    a real attribute fails fast at boot, not silently at first emit."""

    class _Adapter:
        channel = "ghost"
        factory = "eidan_backend.bootstrap:_does_not_exist"

    class _Notifications:
        adapters = [_Adapter()]

    loaded = _make_loaded_plugin(
        name="ghost", notifications=_Notifications(), plugin_dir=tmp_path
    )
    router = NotificationRouter()
    with pytest.raises(RuntimeError, match="_does_not_exist"):
        _register_declared_notification_adapters(
            [loaded], router, _stub_secret
        )


# ---------- _make_spawn_turn_callable + telemetry holder (#174) ----------


@pytest.mark.asyncio
async def test_spawn_turn_callable_reads_telemetry_through_holder(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The factory binds before the emitter is built, so the closure
    reads through a mutable holder. When the holder is populated
    after construction, the next spawn passes that emitter to
    `run_agent_initiated_turn`."""
    captured: dict[str, Any] = {}

    async def _fake_yield() -> Any:
        if False:  # pragma: no cover
            yield None

    def _fake_run_agent_initiated_turn(**kwargs: Any) -> Any:
        captured.update(kwargs)
        return _fake_yield()

    # Monkeypatch the symbol the closure imports at call time.
    import eidan_backend.loop as loop_mod

    monkeypatch.setattr(
        loop_mod, "run_agent_initiated_turn", _fake_run_agent_initiated_turn
    )

    holder: list[Any] = [None]
    spawn_turn = _make_spawn_turn_callable(
        pool=object(),  # type: ignore[arg-type]
        provider=object(),
        default_model="claude-haiku-4-5-20251001",
        tool_registry=ToolRegistry(),
        telemetry_holder=holder,
    )
    assert spawn_turn is not None

    # Pre-populate scenario: bootstrap drops the emitter into the holder
    # AFTER the factory binds. Mirror that ordering here.
    class _RecordingTelemetry:
        async def emit_event(self, *args: Any, **kwargs: Any) -> None:
            pass

    emitter = _RecordingTelemetry()
    holder[0] = emitter

    # Drain the generator so the kwargs we want to inspect are passed.
    async for _ in spawn_turn(
        user_id="00000000-0000-0000-0000-000000000001",
        agent_name="example-tick",
        prompt_text="hi",
    ):
        pass

    assert captured["telemetry"] is emitter
    assert captured["agent_name"] == "example-tick"


@pytest.mark.asyncio
async def test_spawn_turn_callable_yields_none_telemetry_when_holder_empty(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A spawn that happens before the holder is populated (degraded
    boot, telemetry start failure) passes ``telemetry=None`` rather
    than raising — the loop's emit code paths are already None-safe."""
    captured: dict[str, Any] = {}

    async def _fake_yield() -> Any:
        if False:  # pragma: no cover
            yield None

    def _fake_run_agent_initiated_turn(**kwargs: Any) -> Any:
        captured.update(kwargs)
        return _fake_yield()

    import eidan_backend.loop as loop_mod

    monkeypatch.setattr(
        loop_mod, "run_agent_initiated_turn", _fake_run_agent_initiated_turn
    )

    holder: list[Any] = [None]
    spawn_turn = _make_spawn_turn_callable(
        pool=object(),  # type: ignore[arg-type]
        provider=object(),
        default_model="claude-haiku-4-5-20251001",
        tool_registry=ToolRegistry(),
        telemetry_holder=holder,
    )
    assert spawn_turn is not None

    async for _ in spawn_turn(
        user_id="00000000-0000-0000-0000-000000000001",
        agent_name="early-spawn",
        prompt_text="hi",
    ):
        pass

    assert captured["telemetry"] is None


@pytest.mark.asyncio
async def test_spawn_turn_callable_works_without_holder(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Callers that don't care about telemetry (tests, REPL boots,
    every existing call site before #174) pass no holder and the
    spawn still goes through; the loop just doesn't get an emitter."""
    captured: dict[str, Any] = {}

    async def _fake_yield() -> Any:
        if False:  # pragma: no cover
            yield None

    def _fake_run_agent_initiated_turn(**kwargs: Any) -> Any:
        captured.update(kwargs)
        return _fake_yield()

    import eidan_backend.loop as loop_mod

    monkeypatch.setattr(
        loop_mod, "run_agent_initiated_turn", _fake_run_agent_initiated_turn
    )

    spawn_turn = _make_spawn_turn_callable(
        pool=object(),  # type: ignore[arg-type]
        provider=object(),
        default_model="claude-haiku-4-5-20251001",
        tool_registry=ToolRegistry(),
        # telemetry_holder kwarg intentionally omitted
    )
    assert spawn_turn is not None

    async for _ in spawn_turn(
        user_id="00000000-0000-0000-0000-000000000001",
        agent_name="legacy",
        prompt_text="hi",
    ):
        pass

    assert captured["telemetry"] is None
