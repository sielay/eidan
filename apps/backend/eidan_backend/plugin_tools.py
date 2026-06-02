"""Plugin-introspection tools for the agent loop — `docs/001 §3`.

The host loads plugins at bootstrap (manifest, tools, behaviours,
MCP surface, notification adapters — all known). The HTTP layer
exposes ``/api/plugins`` for the operator UI. The agent loop got
nothing equivalent until now: asking the running agent "what
plugins do you have?" produced a guess from the system prompt,
not a real answer.

This module registers two tools the agent can call:

- ``plugins_list``: enumerate every loaded plugin with name,
  version, tier, display name, description, bundle, and the
  declared extension-point shape (how many tools, how many
  behaviours, whether MCP is enabled, whether the plugin
  contributes notification adapters).
- ``plugins_describe``: zoom into one plugin by name and return
  the full surface — every tool name + description, every
  behaviour name + trigger, the MCP block as-is, the
  notifications adapters list.

Both capture the loaded plugin list by closure at registration
time. Bootstrap registers them AFTER ``load_plugins`` returns so
the closure sees the final set; the list itself doesn't mutate
afterwards.
"""

from __future__ import annotations

import json
from typing import TYPE_CHECKING, Any

from .tools import Tool, ToolError, ToolRegistry

if TYPE_CHECKING:
    from .plugins import LoadedPlugin


def _manifest_dict(loaded: LoadedPlugin) -> dict[str, Any]:
    """Compact summary of a plugin for the list view.

    Counts rather than full surface — the agent's primary call
    doesn't need the every-tool-name detail until it drills in
    with ``plugins_describe``. Keeps the list response small
    enough that listing 20+ plugins doesn't blow the context.
    """
    m = loaded.manifest
    tier = m.tier.value if hasattr(m.tier, "value") else str(m.tier)
    bundle_obj = getattr(m, "bundle", None)
    bundle_name = (
        getattr(bundle_obj, "name", None) if bundle_obj is not None else None
    )

    backend = getattr(m, "backend", None)
    behaviours = list(getattr(m, "behaviours", None) or [])
    mcp = getattr(m, "mcp", None)
    notifications = getattr(m, "notifications", None)
    notif_count = (
        len(notifications.adapters)
        if notifications is not None
        and getattr(notifications, "adapters", None) is not None
        else 0
    )

    return {
        "name": m.name,
        "version": m.version,
        "tier": tier,
        "display_name": getattr(m, "display_name", None),
        "description": getattr(m, "description", None),
        "bundle": bundle_name,
        "has_backend": backend is not None,
        "behaviour_count": len(behaviours),
        "mcp_enabled": bool(mcp is not None and getattr(mcp, "enabled", False)),
        "notification_adapter_count": notif_count,
    }


def _full_dict(loaded: LoadedPlugin) -> dict[str, Any]:
    """Full operator-facing detail. Used by ``plugins_describe``.

    Behaviours include the trigger spec verbatim (cron / event /
    schedule / webhook / agent — whichever the manifest declared),
    so the agent can answer "what fires this plugin?". MCP block
    is rendered as-is, including the public tool allowlist. Tool
    surface is read from the manifest's declarative ``commands[]``
    + ``backend.tool_count`` if present — we don't introspect the
    live ``ToolRegistry`` here because the agent already sees
    that surface via its own tool inventory; the question being
    answered is "what did this plugin DECLARE", not "what's wired
    right now".
    """
    base = _manifest_dict(loaded)
    m = loaded.manifest

    behaviours = list(getattr(m, "behaviours", None) or [])
    base["behaviours"] = [
        {
            "name": getattr(b, "name", None),
            "trigger": getattr(b, "trigger", None),
            "handler": getattr(b, "handler", None),
        }
        for b in behaviours
    ]

    mcp = getattr(m, "mcp", None)
    if mcp is not None and getattr(mcp, "enabled", False):
        base["mcp"] = {
            "enabled": True,
            "transport": getattr(mcp, "transport", None),
            "entrypoint": getattr(mcp, "entrypoint", None),
            "tools": list(getattr(mcp, "tools", None) or []),
        }

    notifications = getattr(m, "notifications", None)
    if notifications is not None:
        adapters = getattr(notifications, "adapters", None) or []
        base["notification_adapters"] = [
            {
                "channel": getattr(a, "channel", None),
                "factory": getattr(a, "factory", None),
            }
            for a in adapters
        ]

    commands = list(getattr(m, "commands", None) or [])
    if commands:
        base["commands"] = [
            {
                "name": getattr(c, "name", None),
                "description": getattr(c, "description", None),
            }
            for c in commands
        ]

    return base


# --- registration -------------------------------------------------------


def register_plugin_tools(
    registry: ToolRegistry,
    *,
    plugins: list[LoadedPlugin],
) -> list[str]:
    """Register ``plugins_list`` + ``plugins_describe`` against the
    host's tool registry.

    ``plugins`` is captured by closure. Bootstrap's loaded list is
    built once and doesn't mutate afterwards, so the capture is
    stable across every agent turn. Returns the registered tool
    names so the caller can log them.
    """

    async def plugins_list(_args: dict[str, Any]) -> str:
        return json.dumps([_manifest_dict(p) for p in plugins])

    async def plugins_describe(args: dict[str, Any]) -> str:
        name = args.get("name") if isinstance(args, dict) else None
        if not isinstance(name, str) or not name.strip():
            raise ToolError(
                "plugins_describe requires a non-empty `name` argument"
            )
        target = name.strip()
        for loaded in plugins:
            if loaded.manifest.name == target:
                return json.dumps(_full_dict(loaded))
        raise ToolError(
            f"no loaded plugin named {target!r}. "
            f"Call plugins_list to see what's available."
        )

    tools = [
        Tool(
            name="plugins_list",
            description=(
                "List every plugin the host loaded at bootstrap. Each "
                "entry carries name, version, tier (core/pro/commercial), "
                "display_name, description, bundle, plus counts of the "
                "declared behaviours and notification adapters and "
                "booleans for whether the plugin has a backend stanza "
                "or an MCP server. Use this when an operator asks "
                "\"what plugins are loaded?\" or \"what does the X "
                "bundle install?\" — drill into one entry with "
                "plugins_describe."
            ),
            input_schema={
                "type": "object",
                "properties": {},
            },
            handler=plugins_list,
        ),
        Tool(
            name="plugins_describe",
            description=(
                "Return the full declared surface of one loaded plugin: "
                "behaviours with their triggers, MCP block + tool "
                "allowlist, notification adapters by channel, declared "
                "commands. Use after plugins_list when the operator "
                "asks about a specific plugin's capabilities."
            ),
            input_schema={
                "type": "object",
                "required": ["name"],
                "properties": {
                    "name": {
                        "type": "string",
                        "description": "Exact plugin name from plugins_list.",
                    },
                },
            },
            handler=plugins_describe,
        ),
    ]
    registered: list[str] = []
    for tool in tools:
        registry.register(tool)
        registered.append(tool.name)
    return registered


__all__ = ["register_plugin_tools"]
