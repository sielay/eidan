"""MCP surface tests (issue #97 / `docs/013`).

Exercises both halves of the seam:

- Inbound: list_inbound_tools filters by the new
  ``expose_to_external_mcp`` flag; call_inbound_tool runs the
  handler and shapes the response into the ``content`` / ``isError``
  envelope.
- Outbound: register_outbound_tools mounts each upstream tool into
  the host's ToolRegistry as a regular Tool — the agent loop sees
  it through the same surface as local tools.

The full stdio / SSE MCP transport from §4 is out of scope here;
these tests exercise the structural seam that the transport plugs
into.
"""

from __future__ import annotations

import pytest
from eidan_backend.mcp import (
    OutboundClient,
    UpstreamTool,
    call_inbound_tool,
    list_inbound_tools,
    register_outbound_tools,
)
from eidan_backend.tools import Tool, ToolError, ToolRegistry


async def _ok_handler(args: dict) -> str:
    return f"echoed: {args.get('q', '')}"


async def _failing_handler(args: dict) -> str:
    raise ToolError("upstream blew up")


def test_list_inbound_filters_by_flag() -> None:
    registry = ToolRegistry()
    registry.register(
        Tool(
            name="public-tool",
            description="exposed",
            input_schema={"type": "object"},
            handler=_ok_handler,
            expose_to_external_mcp=True,
        )
    )
    registry.register(
        Tool(
            name="local-tool",
            description="kept local",
            input_schema={"type": "object"},
            handler=_ok_handler,
        )
    )
    out = list_inbound_tools(registry)
    assert [t.name for t in out] == ["public-tool"]


@pytest.mark.asyncio
async def test_call_inbound_routes_exposed_tools() -> None:
    registry = ToolRegistry()
    registry.register(
        Tool(
            name="echo",
            description="echo the input",
            input_schema={"type": "object"},
            handler=_ok_handler,
            expose_to_external_mcp=True,
        )
    )
    envelope = await call_inbound_tool(
        registry, name="echo", arguments={"q": "hello"}
    )
    assert "isError" not in envelope
    assert envelope["content"][0]["text"] == "echoed: hello"


@pytest.mark.asyncio
async def test_call_inbound_refuses_unexposed_tools() -> None:
    registry = ToolRegistry()
    registry.register(
        Tool(
            name="local-only",
            description="not exposed",
            input_schema={"type": "object"},
            handler=_ok_handler,
        )
    )
    envelope = await call_inbound_tool(
        registry, name="local-only", arguments={}
    )
    assert envelope.get("isError") is True
    assert "unknown or unexposed" in envelope["content"][0]["text"]


@pytest.mark.asyncio
async def test_call_inbound_unknown_tool_is_error_envelope() -> None:
    registry = ToolRegistry()
    envelope = await call_inbound_tool(
        registry, name="not-real", arguments={}
    )
    assert envelope.get("isError") is True


@pytest.mark.asyncio
async def test_call_inbound_tool_error_lands_in_envelope() -> None:
    registry = ToolRegistry()
    registry.register(
        Tool(
            name="boom",
            description="raises",
            input_schema={"type": "object"},
            handler=_failing_handler,
            expose_to_external_mcp=True,
        )
    )
    envelope = await call_inbound_tool(registry, name="boom", arguments={})
    assert envelope.get("isError") is True
    assert "upstream blew up" in envelope["content"][0]["text"]


@pytest.mark.asyncio
async def test_outbound_register_mounts_upstream_tools() -> None:
    captured: list[tuple[str, dict]] = []

    async def fake_upstream_call(name: str, args: dict) -> dict:
        captured.append((name, args))
        return {"content": [{"type": "text", "text": f"from upstream: {name}"}]}

    client = OutboundClient(
        upstream_name="example-upstream",
        tools=(
            UpstreamTool(
                name="search",
                description="upstream search",
                input_schema={"type": "object"},
            ),
        ),
        call=fake_upstream_call,
    )

    registry = ToolRegistry()
    names = register_outbound_tools(
        registry, client=client, namespace="example"
    )
    assert names == ["example__search"]

    tool = registry.get("example__search")
    assert tool is not None
    result = await tool.handler({"q": "x"})
    assert "from upstream: search" in result
    # Upstream was actually called with the inner (un-namespaced) name.
    assert captured == [("search", {"q": "x"})]


@pytest.mark.asyncio
async def test_outbound_upstream_error_raises_tool_error() -> None:
    async def err_upstream(name: str, args: dict) -> dict:
        return {
            "isError": True,
            "content": [{"type": "text", "text": "permission denied"}],
        }

    client = OutboundClient(
        upstream_name="example-upstream",
        tools=(
            UpstreamTool(
                name="forbidden",
                description="errors",
                input_schema={"type": "object"},
            ),
        ),
        call=err_upstream,
    )
    registry = ToolRegistry()
    register_outbound_tools(registry, client=client)
    tool = registry.get("forbidden")
    assert tool is not None
    with pytest.raises(ToolError, match="permission denied"):
        await tool.handler({})


def test_outbound_no_caller_is_noop() -> None:
    """A client constructed without a transport is a no-op when
    registered — the operator wires the transport once it lands."""
    registry = ToolRegistry()
    client = OutboundClient(
        upstream_name="example",
        tools=(
            UpstreamTool(
                name="t", description="x", input_schema={"type": "object"}
            ),
        ),
        call=None,
    )
    assert register_outbound_tools(registry, client=client) == []
