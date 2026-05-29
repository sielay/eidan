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

Handler signature widening (`docs/010 §3.1` row 5 / issue #16): a
handler MAY declare a second positional parameter to receive a
:class:`ToolContext`. The registry detects the arity at registration
and dispatches accordingly; single-arg handlers continue to work
unchanged. The :class:`ToolContext` carries the calling turn's
anchor identifiers and ``report_llm_call``, the writer a plugin
calls after invoking an LLM (or a vendor CLI / paid API) outside
the host's in-process Provider abstraction so the resulting spend
lands on ``eidan.llm_calls`` and participates in the host's caps
and dashboards uniformly with in-loop spend.
"""

from __future__ import annotations

import inspect
import re
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any
from uuid import UUID


class ToolError(Exception):
    """Raised when a tool's handler fails or the tool is unknown.

    The loop catches this and surfaces it as an error block to the
    model rather than aborting the turn (`docs/005 §5.5`).
    """


# Writer signature for ``ToolContext.report_llm_call`` (`docs/010 §3.1`
# row 5). The loop binds a closure that snapshots ``pool``, identity,
# anchor message id and agent id; the plugin passes the four token
# axes, the model id, and an optional role / metadata / error envelope.
ReportLlmCall = Callable[..., Awaitable[None]]


@dataclass(frozen=True, slots=True)
class ToolContext:
    """Per-invocation context handed to tool handlers that opt in.

    `docs/010 §3.1` row 5: a plugin's tool handler that invokes an LLM
    (or a paid API) outside the host's in-process Provider
    abstraction calls ``await ctx.report_llm_call(...)`` so the
    resulting cost lands on ``eidan.llm_calls`` with the SAME
    (user_id, conversation_id, message_id, agent_id) anchors as the
    primary loop's own rows. Caps (`docs/010 §4`) and analytics
    (`§7`) then aggregate plugin-emitted spend uniformly with
    in-loop spend.

    The writer is async and EP-bound: it returns only after the
    INSERT has committed (`docs/010 §3`). A plugin that issues
    several calls in a single tool invocation calls
    ``report_llm_call`` once per call — never aggregates, never
    rewrites a prior row's ``cost_usd`` (`docs/010 §2.1`
    "frozen on the row").
    """

    user_id: UUID
    conversation_id: UUID
    message_id: UUID
    agent_id: UUID | None
    report_llm_call: ReportLlmCall

    # Reserved for future fields the loader passes through (the
    # plugin name, a per-tool budget, an idempotency key). Empty
    # today; populating it does not break consumers that destructure
    # the canonical fields above.
    extra: dict[str, Any] = field(default_factory=dict)


ToolHandler = Callable[..., Awaitable[str]]

# Anthropic's Messages API enforces this pattern on tool names; OpenAI
# is looser but accepts the same shape, so we use the strictest common
# subset. A name with a dot or colon will fail the provider call with a
# 400 before any SSE frame is emitted (turn surfaces as `[interrupted]`
# to the UI). Failing fast at registration turns that into a startup
# error the operator can actually fix.
_NAME_PATTERN = re.compile(r"^[a-zA-Z0-9_-]{1,128}$")


def _handler_accepts_context(handler: ToolHandler) -> bool:
    """True when ``handler`` declares a second positional parameter.

    The convention: a handler that wants ``ToolContext`` signs as
    ``async def name(args: dict, ctx: ToolContext) -> str``; one that
    doesn't keeps the historical ``async def name(args: dict) -> str``.
    Detection is by positional-arity inspection — annotations are
    optional and not required to match.

    ``*args`` / ``**kwargs`` shapes are uncommon for tool handlers; if
    a handler uses ``*args``, we conservatively treat it as
    context-accepting so the loop hands it the richer surface.
    """
    try:
        sig = inspect.signature(handler)
    except (TypeError, ValueError):
        # Built-in / C-defined callables can't be introspected.
        return False
    positional = 0
    for param in sig.parameters.values():
        if param.kind in (
            inspect.Parameter.POSITIONAL_ONLY,
            inspect.Parameter.POSITIONAL_OR_KEYWORD,
        ):
            positional += 1
        elif param.kind is inspect.Parameter.VAR_POSITIONAL:
            return True
    return positional >= 2


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
    # Set at __post_init__ from ``inspect.signature(handler)``. Lets
    # the registry dispatch ``handler(args)`` or ``handler(args, ctx)``
    # without re-introspecting on the hot path. Not surfaced in
    # ``surface()`` — purely an internal dispatch hint.
    accepts_context: bool = field(init=False)

    def __post_init__(self) -> None:
        if not _NAME_PATTERN.match(self.name):
            raise ValueError(
                f"invalid tool name {self.name!r}: must match "
                f"{_NAME_PATTERN.pattern} (Anthropic + OpenAI tool-name "
                "rules — no dots, colons, or whitespace)"
            )
        # frozen=True forbids normal assignment; route through __setattr__
        # the same way dataclasses do for default factories.
        object.__setattr__(
            self,
            "accepts_context",
            _handler_accepts_context(self.handler),
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

    async def execute(
        self,
        name: str,
        args: dict,
        ctx: ToolContext | None = None,
    ) -> str:
        """Run the named tool handler.

        ``ctx`` is forwarded when the handler declared two positional
        parameters at registration. Single-arg handlers receive
        ``args`` only — keeping the historical contract intact for
        every tool that doesn't need the writer surface.
        """
        tool = self._tools.get(name)
        if tool is None:
            raise ToolError(f"unknown tool: {name}")
        try:
            if tool.accepts_context and ctx is not None:
                return await tool.handler(args, ctx)
            return await tool.handler(args)
        except ToolError:
            raise
        except Exception as exc:  # noqa: BLE001 — surfaced to the model
            raise ToolError(f"{name} failed: {exc}") from exc


__all__ = [
    "ReportLlmCall",
    "Tool",
    "ToolContext",
    "ToolError",
    "ToolHandler",
    "ToolRegistry",
    "_handler_accepts_context",
]
