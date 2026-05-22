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
from eidan_backend.bootstrap import bootstrap

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
