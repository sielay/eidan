"""MCP surface — `docs/013`.

Two halves the spec calls for:

- **Inbound**: a JSON-RPC-shaped server that exposes host tools
  flagged ``expose_to_external_mcp = True`` to external MCP clients
  (Claude Desktop, IDE plugins, …).
- **Outbound**: a client wrapper that lists an upstream MCP server's
  tools and registers them into the host's :class:`ToolRegistry` so
  the agentic loop's primary call sees them alongside in-process
  tools.

Phase 1 lands a structural skeleton — full MCP transport (stdio +
SSE per `docs/013 §4`) and the protocol-version handshake are
follow-ups. The seam here is small enough to integrate with the
existing tool registry without inventing a parallel runtime.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any

from .tools import Tool, ToolError, ToolRegistry

# ---------------------------------------------------------------------------
# Inbound server (JSON-RPC-style methods over HTTP).
# ---------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class McpToolDescriptor:
    """The list_tools wire shape per the MCP spec.

    ``name``, ``description``, and ``input_schema`` round-trip
    verbatim from :class:`eidan_backend.tools.Tool`. Tools that
    don't set ``expose_to_external_mcp = True`` are filtered out
    before this list is built.
    """

    name: str
    description: str
    input_schema: dict


def list_inbound_tools(registry: ToolRegistry) -> list[McpToolDescriptor]:
    """Project the registry's externally-tagged tools into MCP shape."""
    out: list[McpToolDescriptor] = []
    for tool in registry._tools.values():  # noqa: SLF001 — internal projection
        if not tool.expose_to_external_mcp:
            continue
        out.append(
            McpToolDescriptor(
                name=tool.name,
                description=tool.description,
                input_schema=tool.input_schema,
            )
        )
    return out


async def call_inbound_tool(
    registry: ToolRegistry,
    *,
    name: str,
    arguments: dict[str, Any],
) -> dict[str, Any]:
    """Dispatch an external MCP ``tools/call`` against the registry.

    Returns a result envelope matching the MCP spec shape:
    ``{"content": [{"type": "text", "text": <handler output>}]}``.
    Tool errors land as ``{"isError": true, "content": [...]}`` per
    the §4.1 outbound error-normalisation envelope; the inbound
    server reuses the same shape so the model on the *other* side
    of the MCP boundary sees errors consistently.

    External callers may only invoke tools whose
    ``expose_to_external_mcp`` flag is set; everything else surfaces
    as a 404-class error.
    """
    tool = registry.get(name)
    if tool is None or not tool.expose_to_external_mcp:
        return {
            "isError": True,
            "content": [
                {
                    "type": "text",
                    "text": f"unknown or unexposed tool: {name}",
                }
            ],
        }
    try:
        output = await registry.execute(name, arguments)
    except ToolError as exc:
        return {
            "isError": True,
            "content": [{"type": "text", "text": str(exc)}],
        }
    return {"content": [{"type": "text", "text": output}]}


# ---------------------------------------------------------------------------
# Outbound client wrapper.
# ---------------------------------------------------------------------------


# The handler shape upstream tools satisfy when wrapped — the host's
# ToolRegistry expects an async callable taking a dict and returning a
# string. The outbound wrapper translates each upstream call into the
# inbound MCP shape.
UpstreamCaller = Callable[[str, dict[str, Any]], Awaitable[dict[str, Any]]]


@dataclass(frozen=True, slots=True)
class UpstreamTool:
    """One row from an upstream MCP server's ``list_tools`` response,
    pre-shaping for ingestion into the host's ToolRegistry."""

    name: str
    description: str
    input_schema: dict


@dataclass(frozen=True, slots=True)
class OutboundClient:
    """Skeleton for the outbound half of `docs/013 §4.2`.

    Phase 1 doesn't wire a real MCP transport — the upstream caller
    is injected by the operator (or a stub in tests). When the
    transport lands, ``stdio_client`` / ``sse_client`` builders will
    produce instances of this struct against the real protocol.
    """

    upstream_name: str
    tools: tuple[UpstreamTool, ...] = field(default_factory=tuple)
    call: UpstreamCaller | None = None


def register_outbound_tools(
    registry: ToolRegistry,
    *,
    client: OutboundClient,
    namespace: str | None = None,
) -> list[str]:
    """Mount each tool the upstream advertises into ``registry``.

    Returns the list of registered tool names. When ``namespace`` is
    set, every name is prefixed ``<namespace>__<name>`` so two
    upstream servers with overlapping tool names can coexist. The
    double-underscore (not a colon) keeps the joined name inside
    Anthropic's tool-name pattern ``^[a-zA-Z0-9_-]{1,128}$``.

    The host loop sees these wrapped tools indistinguishable from
    local ones — the agentic primary's tool surface treats them as
    one flat list, but the registered handler routes the call back
    out through the upstream caller and normalises any error per
    `docs/013 §4.1`.
    """
    if client.call is None:
        return []
    registered: list[str] = []
    for upstream in client.tools:
        public_name = (
            f"{namespace}__{upstream.name}" if namespace else upstream.name
        )

        async def handler(
            args: dict[str, Any],
            _name: str = upstream.name,
            _call: UpstreamCaller = client.call,
        ) -> str:
            envelope = await _call(_name, args)
            if envelope.get("isError"):
                texts = [
                    block.get("text", "")
                    for block in envelope.get("content", [])
                    if isinstance(block, dict)
                ]
                raise ToolError(
                    f"upstream MCP tool {_name!r} returned error: "
                    + "; ".join(t for t in texts if t)
                )
            blocks = envelope.get("content", [])
            return "\n".join(
                block.get("text", "")
                for block in blocks
                if isinstance(block, dict) and block.get("type") == "text"
            )

        registry.register(
            Tool(
                name=public_name,
                description=upstream.description,
                input_schema=upstream.input_schema,
                handler=handler,
            )
        )
        registered.append(public_name)
    return registered


__all__ = [
    "McpToolDescriptor",
    "OutboundClient",
    "UpstreamCaller",
    "UpstreamTool",
    "call_inbound_tool",
    "list_inbound_tools",
    "register_outbound_tools",
]
