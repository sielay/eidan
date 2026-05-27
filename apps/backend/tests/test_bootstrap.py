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
from eidan_backend.bootstrap import _make_context_factory, bootstrap
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
    # (docs/025) so the agent can query its own state.
    assert {"learn", "remember", "note", "event"} <= tool_names
    assert _MEMORY_TOOL_NAMES <= tool_names


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
    # tools (docs/025) so the agent has its read surface available.
    surface_names = {t["name"] for t in (result.tool_registry.surface() or [])}
    assert surface_names == _MEMORY_TOOL_NAMES
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
    plugin_dir = Path(__file__).resolve().parents[3] / "plugins" / "example-core"
    loaded = LoadedPlugin(
        manifest=load_manifest(plugin_dir),
        plugin=_StubPluginBase(),  # type: ignore[arg-type]
        plugin_dir=plugin_dir,
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
    plugin_dir = Path(__file__).resolve().parents[3] / "plugins" / "example-core"
    loaded = LoadedPlugin(
        manifest=load_manifest(plugin_dir),
        plugin=_StubPluginBase(),  # type: ignore[arg-type]
        plugin_dir=plugin_dir,
    )
    ctx = factory(loaded)

    assert ctx.publish_event is None
