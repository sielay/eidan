# SPDX-License-Identifier: AGPL-3.0-or-later
"""Tests for the plugin introspection tools.

Exercise the ``list_plugins`` / ``describe_plugin`` surface against a
hand-built :class:`PluginIntrospection` snapshot — no bootstrap, no
asyncpg pool — so the tool's manifest-derived output is isolated
from lifecycle wiring concerns.

A separate end-to-end test in ``test_bootstrap.py`` covers the
registration path.
"""

from __future__ import annotations

import json
import shutil
from pathlib import Path

import pytest
from eidan_backend.plugin_introspection import (
    PluginIntrospection,
    register_plugin_introspection_tools,
)
from eidan_backend.plugins import LoadedPlugin, PluginBase, load_manifest
from eidan_backend.tools import ToolError, ToolRegistry


class _StubPluginBase(PluginBase):
    """Concrete no-op so :class:`LoadedPlugin` has a valid plugin field.

    The introspection tools never invoke hooks; they only read manifest
    + attribution maps. A stub keeps the test from importing the real
    plugin entrypoints (which would pull in DB / provider modules).
    """

    name = "stub"


def _load(tmp_path: Path, names: list[str]) -> list[LoadedPlugin]:
    """Copy named plugins into ``tmp_path`` and load their manifests."""
    src_root = Path(__file__).resolve().parents[3] / "plugins"
    dst_root = tmp_path / "plugins"
    dst_root.mkdir(exist_ok=True)
    loaded: list[LoadedPlugin] = []
    for name in names:
        dst = dst_root / name
        if not dst.exists():
            shutil.copytree(src_root / name, dst)
        manifest = load_manifest(dst)
        loaded.append(
            LoadedPlugin(manifest=manifest, plugin=_StubPluginBase(), plugin_dir=dst)
        )
    return loaded


@pytest.mark.asyncio
async def test_list_plugins_emits_row_per_plugin(tmp_path: Path) -> None:
    loaded = _load(tmp_path, ["example-core", "learn", "capture"])
    introspection = PluginIntrospection(
        plugins=tuple(loaded),
        tools_by_plugin={
            "learn": ("learn",),
            "capture": ("remember", "note", "event"),
        },
        behaviours_by_plugin={},
        pool=None,
    )
    registry = ToolRegistry()
    register_plugin_introspection_tools(registry, introspection)

    tool = registry.get("list_plugins")
    assert tool is not None
    out = await tool.handler({})
    payload = json.loads(out)
    rows = {row["name"]: row for row in payload["plugins"]}
    assert set(rows) == {"example-core", "learn", "capture"}
    assert rows["learn"]["tool_count"] == 1
    assert rows["capture"]["tool_count"] == 3
    assert rows["example-core"]["tool_count"] == 0
    # Schema name follows the plugins.migrations helper — replaces dashes
    # with underscores under the plugin_ prefix.
    assert rows["learn"]["schema"] == "plugin_learn"
    assert rows["capture"]["schema"] == "plugin_capture"
    # Every loaded plugin reports active — list_plugins doesn't model
    # half-loaded states yet (the host fails loud on partial activation).
    assert all(row["status"] == "active" for row in payload["plugins"])
    # Tier is surfaced as the raw enum value, not the enum repr.
    assert rows["learn"]["tier"] in {"core", "pro", "commercial"}


@pytest.mark.asyncio
async def test_describe_plugin_returns_full_detail(tmp_path: Path) -> None:
    loaded = _load(tmp_path, ["learn"])
    introspection = PluginIntrospection(
        plugins=tuple(loaded),
        tools_by_plugin={"learn": ("learn",)},
        behaviours_by_plugin={"learn": ()},
        pool=None,
    )
    registry = ToolRegistry()
    register_plugin_introspection_tools(registry, introspection)

    tool = registry.get("describe_plugin")
    assert tool is not None
    out = await tool.handler({"name": "learn"})
    detail = json.loads(out)["plugin"]
    assert detail["name"] == "learn"
    assert detail["schema"] == "plugin_learn"
    assert detail["registered"]["tools"] == ["learn"]
    assert detail["registered"]["behaviours"] == []
    # Manifest declarations are surfaced verbatim.
    assert "eidan" in detail["host"]
    # Runtime state is best-effort; with pool=None the tool returns
    # null fields and names the reason rather than raising.
    assert detail["runtime"]["installed_version_recorded"] is None
    assert detail["runtime"]["migrations_revision"] is None
    assert detail["runtime"]["state_unavailable_reason"] == "no_pool"


@pytest.mark.asyncio
async def test_describe_plugin_unknown_name_raises(tmp_path: Path) -> None:
    loaded = _load(tmp_path, ["learn"])
    introspection = PluginIntrospection(
        plugins=tuple(loaded),
        tools_by_plugin={"learn": ("learn",)},
        behaviours_by_plugin={},
        pool=None,
    )
    registry = ToolRegistry()
    register_plugin_introspection_tools(registry, introspection)

    tool = registry.get("describe_plugin")
    assert tool is not None
    with pytest.raises(ToolError) as exc_info:
        await tool.handler({"name": "does-not-exist"})
    assert "does-not-exist" in str(exc_info.value)
    assert "learn" in str(exc_info.value)


@pytest.mark.asyncio
async def test_describe_plugin_missing_name_raises(tmp_path: Path) -> None:
    introspection = PluginIntrospection(
        plugins=(), tools_by_plugin={}, behaviours_by_plugin={}, pool=None
    )
    registry = ToolRegistry()
    register_plugin_introspection_tools(registry, introspection)

    tool = registry.get("describe_plugin")
    assert tool is not None
    with pytest.raises(ToolError):
        await tool.handler({})
    with pytest.raises(ToolError):
        await tool.handler({"name": ""})


@pytest.mark.asyncio
async def test_list_plugins_handles_empty_set() -> None:
    introspection = PluginIntrospection(
        plugins=(), tools_by_plugin={}, behaviours_by_plugin={}, pool=None
    )
    registry = ToolRegistry()
    register_plugin_introspection_tools(registry, introspection)

    tool = registry.get("list_plugins")
    assert tool is not None
    out = await tool.handler({})
    assert json.loads(out) == {"plugins": []}


@pytest.mark.asyncio
async def test_introspection_tools_are_mcp_exposed() -> None:
    """`docs/013` — introspection is a natural cross-process capability;
    Sage and other MCP consumers should see it."""
    introspection = PluginIntrospection(
        plugins=(), tools_by_plugin={}, behaviours_by_plugin={}, pool=None
    )
    registry = ToolRegistry()
    register_plugin_introspection_tools(registry, introspection)
    for name in ("list_plugins", "describe_plugin"):
        tool = registry.get(name)
        assert tool is not None
        assert tool.expose_to_external_mcp is True
