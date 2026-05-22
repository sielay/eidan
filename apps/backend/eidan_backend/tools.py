"""In-process tool registry — Phase 1.5 surface for the primary loop.

A tool is a name, a JSON schema describing its argument shape, and an
async handler. The registry exposes a small contract:

- :meth:`ToolRegistry.surface` returns the provider-shaped list of
  tool definitions (the same one Anthropic's Messages API accepts), so
  the loop can hand it to :meth:`Provider.stream_turn` without
  reshaping.
- :meth:`ToolRegistry.execute` runs the named handler with the
  model-supplied arguments and returns the textual content the loop
  packs into a :class:`ToolResultBlock`.
- :meth:`ToolRegistry.is_empty` lets the loop decline tool_use blocks
  the model emitted while no tools were registered (`docs/005 §5.5`
  "tool failures inside the loop").

Phase 1.5 ships with no built-in tools; bundles register their own.
MCP-wrapped tools (`docs/013 §4`) come later and plug into the same
contract.
"""

from __future__ import annotations

import re
from collections.abc import Awaitable, Callable
from dataclasses import dataclass


class ToolError(Exception):
    """Raised when a tool's handler fails or the tool is unknown.

    The loop catches this and surfaces it as an error block to the
    model rather than aborting the turn (`docs/005 §5.5`).
    """


ToolHandler = Callable[[dict], Awaitable[str]]

# Anthropic's Messages API enforces this pattern on tool names; OpenAI
# is looser but accepts the same shape, so we use the strictest common
# subset. A name with a dot or colon will fail the provider call with a
# 400 before any SSE frame is emitted (turn surfaces as `[interrupted]`
# to the UI). Failing fast at registration turns that into a startup
# error the operator can actually fix.
_NAME_PATTERN = re.compile(r"^[a-zA-Z0-9_-]{1,128}$")


@dataclass(frozen=True, slots=True)
class Tool:
    name: str
    description: str
    input_schema: dict
    handler: ToolHandler
    # `docs/013` — when True, the inbound MCP server exposes this
    # tool to external clients. Defaults False so plugins that don't
    # opt in keep their tools local to the loop.
    expose_to_external_mcp: bool = False

    def __post_init__(self) -> None:
        if not _NAME_PATTERN.match(self.name):
            raise ValueError(
                f"invalid tool name {self.name!r}: must match "
                f"{_NAME_PATTERN.pattern} (Anthropic + OpenAI tool-name "
                "rules — no dots, colons, or whitespace)"
            )


class ToolRegistry:
    """An ordered, name-keyed map of registered tools.

    Insertion order is preserved so the provider-shaped surface is
    deterministic between runs, which matters for cache hit rates on
    providers that key on the tool list.
    """

    def __init__(self) -> None:
        self._tools: dict[str, Tool] = {}

    def register(self, tool: Tool) -> None:
        if tool.name in self._tools:
            raise ValueError(f"tool already registered: {tool.name}")
        self._tools[tool.name] = tool

    def get(self, name: str) -> Tool | None:
        return self._tools.get(name)

    def is_empty(self) -> bool:
        return not self._tools

    def surface(self) -> list[dict]:
        """The provider-shaped tool definition list.

        Returns an empty list when no tools are registered. Callers
        should pass ``None`` to the provider in that case so the
        request payload omits the field entirely.
        """
        return [
            {
                "name": t.name,
                "description": t.description,
                "input_schema": t.input_schema,
            }
            for t in self._tools.values()
        ]

    async def execute(self, name: str, args: dict) -> str:
        tool = self._tools.get(name)
        if tool is None:
            raise ToolError(f"unknown tool: {name}")
        try:
            return await tool.handler(args)
        except ToolError:
            raise
        except Exception as exc:  # noqa: BLE001 — surfaced to the model
            raise ToolError(f"{name} failed: {exc}") from exc
