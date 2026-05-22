"""Provider protocol + neutral DTOs.

The agent loop talks to providers through `Provider.stream_turn`, which
yields :class:`AssistantBlock`s and returns a :class:`ProviderCallResult`
once the stream completes. The provider adapter owns:

- prompt-shape translation (the loop's neutral DTOs → the provider's
  native chat format)
- streaming chunk decoding
- token + cost accounting (docs/007 §4, §6.4) computed *as the call
  completes*, so the loop can write a single `llm_calls` row.

Phase 1.5 adds tool-use surfaces: the streaming iterator can yield text
deltas (:class:`AssistantChunk`) *and* completed tool_use blocks
(:class:`ToolUseBlock`), and inbound messages may carry ``tool_calls``
or ``tool_results`` blocks (`docs/005 §5.5`).
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Protocol


@dataclass(frozen=True, slots=True)
class ToolUseBlock:
    """A model-emitted request to invoke a registered tool.

    Persisted into ``messages.tool_calls`` (`docs/003 §3`) on the
    assistant turn that emitted it. The ``id`` is the provider's
    opaque correlation id and MUST round-trip into the matching
    :class:`ToolResultBlock`.
    """

    id: str
    name: str
    input: dict


@dataclass(frozen=True, slots=True)
class ToolResultBlock:
    """The local tool's reply to a :class:`ToolUseBlock`.

    Persisted into ``messages.tool_results`` on the tool-role turn the
    loop writes between provider calls. ``is_error`` follows the
    Anthropic shape: a tool that raised surfaces as an error block
    rather than an exception (`docs/005 §5.5` "tool failures inside
    the loop").
    """

    tool_use_id: str
    content: str
    is_error: bool = False


@dataclass(frozen=True, slots=True)
class UserMessage:
    """Inbound message handed to a provider for the next call.

    Phase 1 used (role, content) tuples; Phase 1.5 adds tool_use /
    tool_result blocks so a turn's intermediate state (assistant
    tool_use, tool reply) can be replayed back to the provider.
    Adapters translate this neutral shape into the provider's native
    multi-block format.
    """

    role: str  # "user" | "assistant" | "system" | "tool"
    content: str = ""
    tool_calls: tuple[ToolUseBlock, ...] = ()
    tool_results: tuple[ToolResultBlock, ...] = ()


@dataclass(frozen=True, slots=True)
class AssistantChunk:
    """A single streamed chunk of assistant text.

    `text` is the *delta* — the new characters since the last chunk, not
    the cumulative buffer. Concatenating every chunk's text yields the
    final assistant text content.
    """

    text: str


# What `Provider.stream_turn` yields. Text deltas arrive as they stream;
# completed tool_use blocks are emitted once the provider has finished
# assembling each one (per `docs/005 §5.5`).
AssistantBlock = AssistantChunk | ToolUseBlock


@dataclass(frozen=True, slots=True)
class AssistantMessage:
    """Final assembled assistant turn.

    Concatenation of every streamed chunk's `text` plus any tool_use
    blocks the model emitted, with provenance the loop needs to write
    the `messages` row.
    """

    content: str
    provider: str
    model: str
    tool_calls: tuple[ToolUseBlock, ...] = ()


@dataclass(frozen=True, slots=True)
class ProviderCallResult:
    """Telemetry the loop writes to `llm_calls`.

    Per docs/003 §9 the four token columns map directly onto the
    Anthropic API; non-Anthropic adapters populate the subset that
    applies and leave the rest at 0.
    """

    message: AssistantMessage
    input_tokens: int
    output_tokens: int
    cache_read_tokens: int = 0
    cache_creation_tokens: int = 0
    cost_usd: float = 0.0
    started_at: datetime = field(default_factory=lambda: datetime.now(UTC))
    finished_at: datetime = field(default_factory=lambda: datetime.now(UTC))
    request_id: str | None = None
    metadata: dict = field(default_factory=dict)


class Provider(Protocol):
    """Contract every provider adapter implements."""

    name: str  # e.g. "anthropic", "openai", "ollama"

    async def stream_turn(
        self,
        *,
        model: str,
        messages: list[UserMessage],
        system: str | None = None,
        max_tokens: int = 4096,
        tools: list[dict] | None = None,
    ) -> AsyncIterator[AssistantBlock]:
        """Yield blocks as they arrive. Caller iterates to completion.

        Text deltas (:class:`AssistantChunk`) arrive incrementally as
        the provider streams; completed tool_use blocks
        (:class:`ToolUseBlock`) are yielded once each is fully
        assembled. After the iterator is exhausted, the caller awaits
        :meth:`last_call_result` to retrieve the assembled message plus
        telemetry. Adapters that need to deliver the result via callback
        instead (because their SDK doesn't expose a tidy "final" event)
        may stash it on `self` and have `last_call_result` read it back.
        """
        ...

    async def last_call_result(self) -> ProviderCallResult:
        """Return telemetry for the most recently completed stream."""
        ...
