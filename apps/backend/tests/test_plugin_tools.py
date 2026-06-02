# SPDX-License-Identifier: AGPL-3.0-or-later
"""Tests for the plugin-introspection tools (#136).

Covers:

- ``plugins_list`` returns one entry per loaded plugin with the
  shape the agent will read (name / version / tier / description /
  counts).
- ``plugins_describe`` returns the full surface for a named
  plugin and raises a typed error when asked for a name that
  isn't loaded.
- The empty case: a host with no plugins loaded still registers
  the tools and ``plugins_list`` returns ``[]``. Important
  because operators ask the agent "what's loaded?" on a fresh
  install before any bundle is added.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest
from eidan_backend.plugin_tools import register_plugin_tools
from eidan_backend.tools import ToolError, ToolRegistry


class _ManifestStub:
    """Minimum-surface manifest for the introspection tests. The
    actual ``PluginManifestModel`` is a Pydantic model with a much
    larger graph; this stub mirrors only the attributes
    ``plugin_tools.py`` reads. Mirrors the same approach
    ``test_bootstrap.py`` uses for its notification-adapter tests."""

    def __init__(
        self,
        *,
        name: str,
        version: str = "0.1.0",
        tier: str = "core",
        display_name: str | None = None,
        description: str | None = None,
        bundle_name: str | None = None,
        backend: Any = None,
        behaviours: list[Any] | None = None,
        mcp: Any = None,
        notifications: Any = None,
    ) -> None:
        self.name = name
        self.version = version
        self.tier = tier
        self.display_name = display_name
        self.description = description
        self.bundle = (
            type("_Bundle", (), {"name": bundle_name})() if bundle_name else None
        )
        self.backend = backend
        self.behaviours = behaviours or []
        self.mcp = mcp
        self.notifications = notifications


class _LoadedStub:
    """Mirrors :class:`LoadedPlugin` for the test fixtures."""

    def __init__(self, manifest: _ManifestStub) -> None:
        self.manifest = manifest
        self.plugin = None  # not introspected by these tools
        self.plugin_dir = Path("/dev/null")  # ditto


async def _call(registry: ToolRegistry, name: str, args: dict[str, Any]) -> Any:
    """Invoke a registered tool via the registry. ``surface()``
    strips ``handler`` to produce the provider-facing shape, so we
    go through ``execute`` for the actual call. The introspection
    tools don't need a context."""
    return await registry.execute(name, args)


def _make_registry(plugins: list[_LoadedStub]) -> ToolRegistry:
    registry = ToolRegistry()
    register_plugin_tools(registry, plugins=plugins)  # type: ignore[arg-type]
    return registry


# ---------- plugins_list ----------------------------------------------------


@pytest.mark.asyncio
async def test_plugins_list_returns_each_loaded_plugin() -> None:
    """The list view enumerates every loaded plugin with the
    summary fields the agent uses to answer 'what's loaded?'.
    Each entry must carry name, version, tier, and the
    extension-point counts the operator cares about."""
    plugins = [
        _LoadedStub(
            _ManifestStub(
                name="slack",
                version="0.1.0",
                tier="pro",
                display_name="Slack notification surface",
                description="Outbound Slack adapter",
                bundle_name="eidan-pro",
                notifications=type(
                    "_N", (), {
                        "adapters": [
                            type("_A", (), {
                                "channel": "slack",
                                "factory": "eidan_slack.adapter:build_adapter",
                            })(),
                        ],
                    },
                )(),
            )
        ),
        _LoadedStub(
            _ManifestStub(
                name="gh",
                tier="pro",
                bundle_name="eidan-sage",
                behaviours=[
                    type("_B", (), {
                        "name": "claim_ready_issue",
                        "trigger": "cron: */2 * * * *",
                        "handler": "eidan_gh.claim:run",
                    })(),
                ],
            )
        ),
    ]
    registry = _make_registry(plugins)

    result_raw = await _call(registry, "plugins_list", {})
    result = json.loads(result_raw)

    assert isinstance(result, list)
    assert len(result) == 2
    by_name = {entry["name"]: entry for entry in result}
    assert by_name["slack"]["tier"] == "pro"
    assert by_name["slack"]["bundle"] == "eidan-pro"
    assert by_name["slack"]["notification_adapter_count"] == 1
    assert by_name["slack"]["behaviour_count"] == 0
    assert by_name["gh"]["behaviour_count"] == 1
    assert by_name["gh"]["notification_adapter_count"] == 0


@pytest.mark.asyncio
async def test_plugins_list_empty_when_no_plugins_loaded() -> None:
    """A host with no plugins still registers the tool. Asking it
    returns ``[]`` — an honest answer beats the agent guessing
    from its system prompt. Important for the freshly-bootstrapped
    'what's installed?' check."""
    registry = _make_registry([])

    result = json.loads(await _call(registry, "plugins_list", {}))

    assert result == []


# ---------- plugins_describe -------------------------------------------------


@pytest.mark.asyncio
async def test_plugins_describe_returns_full_surface_for_named_plugin() -> None:
    """The detail view returns behaviours with their triggers,
    notification adapters by channel, and the MCP block. The agent
    drills here after ``plugins_list`` when the operator asks
    about a specific plugin."""
    plugins = [
        _LoadedStub(
            _ManifestStub(
                name="slack",
                tier="pro",
                bundle_name="eidan-pro",
                notifications=type(
                    "_N", (), {
                        "adapters": [
                            type("_A", (), {
                                "channel": "slack",
                                "factory": "eidan_slack.adapter:build_adapter",
                            })(),
                        ],
                    },
                )(),
            )
        ),
    ]
    registry = _make_registry(plugins)

    result = json.loads(
        await _call(registry, "plugins_describe", {"name": "slack"})
    )

    assert result["name"] == "slack"
    assert result["notification_adapters"] == [
        {
            "channel": "slack",
            "factory": "eidan_slack.adapter:build_adapter",
        }
    ]


@pytest.mark.asyncio
async def test_plugins_describe_unknown_name_raises_tool_error() -> None:
    """Asking for a plugin name that isn't loaded must raise a
    typed :class:`ToolError` so the agent surfaces a real
    "no such plugin" message instead of returning an empty result
    the model might mistake for "exists but empty"."""
    plugins = [_LoadedStub(_ManifestStub(name="slack"))]
    registry = _make_registry(plugins)

    with pytest.raises(ToolError, match="no loaded plugin"):
        await _call(registry, "plugins_describe", {"name": "imap"})


@pytest.mark.asyncio
async def test_plugins_describe_missing_name_raises_tool_error() -> None:
    """The handler must validate its own input. The model can
    occasionally call a tool with the wrong args; raise a typed
    error rather than KeyError."""
    registry = _make_registry([_LoadedStub(_ManifestStub(name="slack"))])

    with pytest.raises(ToolError, match="non-empty"):
        await _call(registry, "plugins_describe", {})


# ---------- registration shape ----------------------------------------------


def test_register_plugin_tools_returns_registered_names() -> None:
    """The registration helper returns the list of tool names it
    registered. Bootstrap uses this for the boot-time log line so
    operators see what landed on the registry."""
    registry = ToolRegistry()
    names = register_plugin_tools(registry, plugins=[])  # type: ignore[arg-type]

    assert set(names) == {"plugins_list", "plugins_describe"}
