# SPDX-License-Identifier: AGPL-3.0-or-later
"""Plugin introspection tools — surface the installed plugin set to the agent.

Two tools live here:

- ``list_plugins`` returns a compact summary of every plugin loaded
  by :func:`eidan_backend.bootstrap.bootstrap` on this process. The
  primary agent calls it to find out what extension points the host
  actually exposes — without it the model only sees a flat tool list
  and cannot reason about which plugin owns which capability.

- ``describe_plugin`` returns the full detail for a single plugin:
  manifest declarations (depends_on, host constraint, declared vault
  / env / notifications / mcp surface), the tool and behaviour names
  it actually registered at activation, plus runtime state from
  ``eidan.plugin_state`` and the plugin's own ``alembic_version``.

Both tools are read-only, take no per-user state, and are flagged
``expose_to_external_mcp=True`` so the inbound MCP server forwards
them to external clients (Sage, future tooling).

The runtime state queries (``plugin_state`` row, alembic revision)
are best-effort: a missing table or unreachable connection returns
``null`` with a ``state_unavailable_reason`` rather than failing the
whole tool call. That keeps introspection working in degraded boots
where ``eidan.plugin_state`` is present but a plugin schema's
migration history is not.
"""

from __future__ import annotations

import json
from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from typing import Any

import asyncpg

from .plugins.loader import LoadedPlugin
from .plugins.migrations import schema_for_plugin
from .tools import Tool, ToolError, ToolRegistry


@dataclass(frozen=True, slots=True)
class PluginIntrospection:
    """Snapshot of the bootstrap's plugin state for the introspection tools.

    Built once at the end of :func:`eidan_backend.bootstrap.bootstrap`
    after ``install_and_activate`` returns. The ``tools_by_plugin`` /
    ``behaviours_by_plugin`` maps are populated by registrar closures
    in the bootstrap that record the names each plugin contributed —
    the global :class:`ToolRegistry` does not track attribution itself
    because it is shared across plugins and core.

    ``pool`` is optional: when ``None`` the tools skip the runtime
    state queries (``plugin_state``, ``alembic_version``) and return
    only manifest-derived fields. Test boots that don't have those
    tables migrated rely on this fallback.
    """

    plugins: tuple[LoadedPlugin, ...]
    tools_by_plugin: Mapping[str, tuple[str, ...]]
    behaviours_by_plugin: Mapping[str, tuple[str, ...]]
    pool: asyncpg.Pool | None = None


def _tier_value(tier: Any) -> str:
    """PluginManifest.tier is a Pydantic enum; surface its raw string."""
    return tier.value if hasattr(tier, "value") else str(tier)


def _depends_on(manifest: Any) -> list[dict[str, str]]:
    items = manifest.depends_on or []
    return [{"name": d.name, "version": d.version} for d in items]


def _host_constraint(manifest: Any) -> dict[str, str | None]:
    host = getattr(manifest, "host", None)
    if host is None:
        return {"eidan": None, "python": None}
    return {
        "eidan": getattr(host, "eidan", None),
        "python": getattr(host, "python", None),
    }


def _declared_env(manifest: Any) -> list[dict[str, str | None]]:
    env = getattr(manifest, "env", None) or []
    return [
        {"name": e.name, "description": getattr(e, "description", None)}
        for e in env
    ]


def _declared_vault(manifest: Any) -> list[dict[str, Any]]:
    vault = getattr(manifest, "vault", None) or []
    out: list[dict[str, Any]] = []
    for entry in vault:
        out.append(
            {
                "key": getattr(entry, "key", None),
                "required": getattr(entry, "required", None),
                "description": getattr(entry, "description", None),
            }
        )
    return out


def _declared_notifications(manifest: Any) -> list[dict[str, str]]:
    notifications = getattr(manifest, "notifications", None)
    if notifications is None:
        return []
    return [
        {"channel": a.channel, "factory": a.factory}
        for a in (notifications.adapters or [])
    ]


def _declared_mcp(manifest: Any) -> dict[str, Any]:
    mcp = getattr(manifest, "mcp", None)
    if mcp is None:
        return {"enabled": False, "tools": []}
    return {
        "enabled": bool(getattr(mcp, "enabled", False)),
        "tools": list(getattr(mcp, "tools", []) or []),
    }


def _summary(
    loaded: LoadedPlugin,
    *,
    tools: tuple[str, ...],
    behaviours: tuple[str, ...],
) -> dict[str, Any]:
    """Per-plugin row in ``list_plugins`` output."""
    manifest = loaded.manifest
    bundle = getattr(manifest, "bundle", None)
    return {
        "name": manifest.name,
        "version": manifest.version,
        "tier": _tier_value(manifest.tier),
        "bundle": getattr(bundle, "name", None) if bundle is not None else None,
        "schema": schema_for_plugin(manifest.name),
        "display_name": getattr(manifest, "display_name", None),
        "depends_on": _depends_on(manifest),
        "tool_count": len(tools),
        "behaviour_count": len(behaviours),
        "status": "active",
    }


async def _runtime_state(
    pool: asyncpg.Pool | None,
    plugin_name: str,
) -> dict[str, Any]:
    """Read ``eidan.plugin_state`` + ``plugin_<name>.alembic_version``.

    Both queries are best-effort. Missing tables or query errors
    surface as ``state_unavailable_reason`` so the agent can still
    reason about the manifest-derived parts of the description.
    """
    state: dict[str, Any] = {
        "installed_version_recorded": None,
        "migrations_revision": None,
        "state_unavailable_reason": None,
    }
    if pool is None:
        state["state_unavailable_reason"] = "no_pool"
        return state
    schema = schema_for_plugin(plugin_name)
    try:
        async with pool.acquire() as conn:
            row = await conn.fetchrow(
                "SELECT version FROM eidan.plugin_state WHERE name = $1",
                plugin_name,
            )
            if row is not None:
                state["installed_version_recorded"] = row["version"]
            rev_row = await conn.fetchrow(
                f'SELECT version_num FROM "{schema}".alembic_version LIMIT 1'
            )
            if rev_row is not None:
                state["migrations_revision"] = rev_row["version_num"]
    except Exception as exc:  # noqa: BLE001 — runtime state is best-effort
        # A missing table, a degraded boot, or a stubbed pool in tests
        # all surface here. Carry the exception type so the agent /
        # operator can see what happened without the tool failing.
        state["state_unavailable_reason"] = type(exc).__name__
    return state


def register_plugin_introspection_tools(
    registry: ToolRegistry,
    introspection: PluginIntrospection,
) -> list[str]:
    """Register ``list_plugins`` and ``describe_plugin`` against ``registry``.

    Returns the names of the registered tools so the caller can log /
    test the surface. Both tools are exposed to external MCP clients
    (`docs/013`) because introspection is a natural cross-process
    capability — Sage and other MCP consumers want to see which
    plugins the host is running.
    """
    by_name = {p.manifest.name: p for p in introspection.plugins}

    async def list_plugins(_args: dict) -> str:
        rows = [
            _summary(
                p,
                tools=introspection.tools_by_plugin.get(p.manifest.name, ()),
                behaviours=introspection.behaviours_by_plugin.get(
                    p.manifest.name, ()
                ),
            )
            for p in introspection.plugins
        ]
        return json.dumps({"plugins": rows}, ensure_ascii=False)

    async def describe_plugin(args: dict) -> str:
        name = args.get("name")
        if not isinstance(name, str) or not name:
            raise ToolError("describe_plugin: 'name' is required")
        loaded = by_name.get(name)
        if loaded is None:
            known = sorted(by_name)
            raise ToolError(
                f"describe_plugin: no plugin named {name!r}. "
                f"Known plugins: {known}"
            )
        manifest = loaded.manifest
        tools = list(introspection.tools_by_plugin.get(name, ()))
        behaviours = list(introspection.behaviours_by_plugin.get(name, ()))
        runtime = await _runtime_state(introspection.pool, name)
        detail = {
            "name": manifest.name,
            "version": manifest.version,
            "tier": _tier_value(manifest.tier),
            "schema": schema_for_plugin(name),
            "display_name": getattr(manifest, "display_name", None),
            "description": getattr(manifest, "description", None),
            "host": _host_constraint(manifest),
            "depends_on": _depends_on(manifest),
            "declared": {
                "env": _declared_env(manifest),
                "vault": _declared_vault(manifest),
                "notifications": _declared_notifications(manifest),
                "mcp": _declared_mcp(manifest),
            },
            "registered": {
                "tools": tools,
                "behaviours": behaviours,
            },
            "runtime": runtime,
        }
        return json.dumps({"plugin": detail}, ensure_ascii=False)

    tools: Iterable[Tool] = (
        Tool(
            name="list_plugins",
            description=(
                "List every plugin loaded by the host on this process. "
                "Returns a compact summary per plugin: name, version, "
                "tier, schema, display_name, depends_on, the count of "
                "registered tools and behaviours, and an 'active' "
                "status. Use this first to discover what extension "
                "points the host actually exposes before calling "
                "describe_plugin for full detail."
            ),
            input_schema={
                "type": "object",
                "properties": {},
                "additionalProperties": False,
            },
            handler=list_plugins,
            expose_to_external_mcp=True,
        ),
        Tool(
            name="describe_plugin",
            description=(
                "Return the full detail for a single loaded plugin: "
                "manifest fields (description, host constraint, "
                "depends_on), declared access (env, vault, "
                "notifications adapters, mcp surface), the tool and "
                "behaviour names it registered at activation, and "
                "runtime state (plugin_state version, current "
                "alembic_version revision). 'name' must match a value "
                "from list_plugins. Runtime state may be null when the "
                "host can't reach the underlying tables; "
                "state_unavailable_reason carries the reason."
            ),
            input_schema={
                "type": "object",
                "required": ["name"],
                "properties": {
                    "name": {
                        "type": "string",
                        "description": (
                            "Plugin slug as it appears in plugin.yaml "
                            "and in the list_plugins output."
                        ),
                    },
                },
                "additionalProperties": False,
            },
            handler=describe_plugin,
            expose_to_external_mcp=True,
        ),
    )
    registered: list[str] = []
    for tool in tools:
        registry.register(tool)
        registered.append(tool.name)
    return registered


__all__ = [
    "PluginIntrospection",
    "register_plugin_introspection_tools",
]
