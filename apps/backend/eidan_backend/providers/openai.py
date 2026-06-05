"""OpenAI adapter — streaming, multi-block, with tool use.

The shape mirrors :mod:`eidan_backend.providers.anthropic` so the loop
needs no branching: it consumes the same neutral DTOs (``UserMessage``,
``AssistantChunk``, ``ToolUseBlock``) regardless of which adapter is in
play. Phase 1 ships this adapter as the second provider so the
multi-provider claim in ``docs/007`` is real.

Notable shape differences hidden inside the adapter:

- OpenAI's chat API takes a ``messages`` list with the system prompt as
  the first entry (``role: "system"``), not a separate ``system=``
  kwarg the way Anthropic does.
- Tool-result turns ride a dedicated ``role: "tool"`` shape with a
  ``tool_call_id`` reference; the eidan ``UserMessage(role="tool",
  tool_results=...)`` neutral shape fans out to one OpenAI message per
  tool result.
- Streaming yields ``ChatCompletionChunk`` deltas; tool calls arrive in
  fragments keyed by ``index`` rather than as a finished block. The
  adapter assembles them and emits a :class:`ToolUseBlock` once each
  fragment stream completes.
- ``cache_read_tokens`` maps onto OpenAI's prompt-caching read count
  (``usage.prompt_tokens_details.cached_tokens``); cache_creation has
  no OpenAI analogue and stays 0.
"""

from __future__ import annotations

import json
import os
from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from datetime import UTC, datetime

from openai import AsyncOpenAI

from .base import (
    AssistantBlock,
    AssistantChunk,
    AssistantMessage,
    ProviderCallResult,
    ToolUseBlock,
    UserMessage,
)

# USD per 1M tokens. Public OpenAI pricing as of early 2026; operator
# overrides take precedence via env vars (see :func:`_pricing_for`).
# Local models routed through the OpenAI-compatible adapter (Ollama,
# vLLM, LocalAI) carry zero pricing by default — the operator runs
# inference on hardware they already own, so per-token billing is
# misleading. Operators with metered local hosting set the
# EIDAN_PRICE_<MODEL>_* env vars to override.
_DEFAULT_PRICING: dict[str, dict[str, float]] = {
    "gpt-4o": {
        "input": 2.50,
        "output": 10.0,
        "cache_read": 1.25,
        "cache_creation": 0.0,
    },
    "gpt-4o-mini": {
        "input": 0.15,
        "output": 0.60,
        "cache_read": 0.075,
        "cache_creation": 0.0,
    },
    "gpt-4.1": {
        "input": 2.0,
        "output": 8.0,
        "cache_read": 0.50,
        "cache_creation": 0.0,
    },
    "gpt-4.1-mini": {
        "input": 0.40,
        "output": 1.60,
        "cache_read": 0.10,
        "cache_creation": 0.0,
    },
    # Local-inference defaults — every entry priced at zero so the
    # llm_calls.cost_usd column reads as "no marginal $ cost" out of
    # the box. The Sentry plugin's tick prompt drives these.
    "phi3": {
        "input": 0.0,
        "output": 0.0,
        "cache_read": 0.0,
        "cache_creation": 0.0,
    },
    "phi3:mini": {
        "input": 0.0,
        "output": 0.0,
        "cache_read": 0.0,
        "cache_creation": 0.0,
    },
    "mistral": {
        "input": 0.0,
        "output": 0.0,
        "cache_read": 0.0,
        "cache_creation": 0.0,
    },
    "mistral:7b": {
        "input": 0.0,
        "output": 0.0,
        "cache_read": 0.0,
        "cache_creation": 0.0,
    },
    "llama3": {
        "input": 0.0,
        "output": 0.0,
        "cache_read": 0.0,
        "cache_creation": 0.0,
    },
    "qwen2.5": {
        "input": 0.0,
        "output": 0.0,
        "cache_read": 0.0,
        "cache_creation": 0.0,
    },
}

_RATE_KEYS = ("input", "output", "cache_read", "cache_creation")


def _model_env_key(model: str) -> str:
    """Normalise a model id for env-var lookup.

    Same rule as the Anthropic adapter uses, applied to the OpenAI
    family — keeps the operator's env-var naming pattern consistent.
    """
    upper = model.upper()
    return "".join(c if c.isalnum() else "_" for c in upper)


def _pricing_for(model: str) -> dict[str, float] | None:
    base = _DEFAULT_PRICING.get(model)
    rates = dict(base) if base is not None else {}
    env_prefix = f"EIDAN_PRICE_{_model_env_key(model)}_"
    for key in _RATE_KEYS:
        raw = os.environ.get(env_prefix + key.upper())
        if raw is None:
            continue
        try:
            rates[key] = float(raw)
        except ValueError:
            continue
    if not rates:
        return None
    for key in _RATE_KEYS:
        rates.setdefault(key, 0.0)
    return rates


def _estimate_cost(
    model: str,
    input_tokens: int,
    output_tokens: int,
    cache_read: int,
    cache_creation: int,
) -> float:
    rates = _pricing_for(model)
    if rates is None:
        from ..pricing import warn_unpriced_model

        warn_unpriced_model(model, source="openai")
        return 0.0
    return round(
        (
            input_tokens * rates["input"]
            + output_tokens * rates["output"]
            + cache_read * rates["cache_read"]
            + cache_creation * rates["cache_creation"]
        )
        / 1_000_000,
        6,
    )


def _translate_tools(tools: list[dict] | None) -> list[dict] | None:
    """Convert the host's Anthropic-shaped tool list into OpenAI's shape.

    Input shape (per ``ToolRegistry.surface()``):
        {"name": str, "description": str, "input_schema": dict}

    Output shape (OpenAI Chat Completions):
        {"type": "function", "function": {"name": str, "description": str,
                                          "parameters": dict}}

    Tools already in OpenAI shape pass through untouched so callers that
    want provider-specific tool metadata can opt in.
    """
    if not tools:
        return None
    out: list[dict] = []
    for t in tools:
        if t.get("type") == "function" and "function" in t:
            out.append(t)
            continue
        out.append(
            {
                "type": "function",
                "function": {
                    "name": t["name"],
                    "description": t.get("description", ""),
                    "parameters": t.get("input_schema", {}),
                },
            }
        )
    return out


def _to_api_messages(
    messages: list[UserMessage],
    system: str | None,
) -> list[dict]:
    """Translate neutral :class:`UserMessage`s into OpenAI's chat shape.

    OpenAI threads the system prompt into the message list rather than
    accepting it as a separate kwarg, so the system text lands as the
    first entry when present.
    """
    api: list[dict] = []
    if system:
        api.append({"role": "system", "content": system})

    for m in messages:
        if m.role == "tool":
            # Each tool_result becomes its own OpenAI tool message.
            for r in m.tool_results:
                api.append(
                    {
                        "role": "tool",
                        "tool_call_id": r.tool_use_id,
                        "content": r.content,
                    }
                )
            continue

        if m.role == "assistant" and m.tool_calls:
            assistant_msg: dict = {
                "role": "assistant",
                "content": m.content or None,
                "tool_calls": [
                    {
                        "id": t.id,
                        "type": "function",
                        "function": {
                            "name": t.name,
                            "arguments": json.dumps(t.input or {}),
                        },
                    }
                    for t in m.tool_calls
                ],
            }
            api.append(assistant_msg)
            continue

        api.append({"role": m.role, "content": m.content})
    return api


@dataclass(slots=True)
class _PendingResult:
    message: AssistantMessage | None = None
    input_tokens: int = 0
    output_tokens: int = 0
    cache_read_tokens: int = 0
    cache_creation_tokens: int = 0
    cost_usd: float = 0.0
    started_at: datetime | None = None
    finished_at: datetime | None = None
    request_id: str | None = None


@dataclass(slots=True)
class _PendingToolCall:
    """A tool call being streamed in fragments.

    OpenAI's streaming API emits tool calls indexed by position; the
    name and arguments arrive as a series of deltas. This dataclass
    accumulates them so the adapter can emit a finished
    :class:`ToolUseBlock` once the stream's ``finish_reason`` arrives.
    """

    id: str = ""
    name: str = ""
    arguments_buffer: list[str] = field(default_factory=list)


class OpenAIProvider:
    """Adapter for ``openai.AsyncOpenAI``'s chat completions streaming API."""

    name = "openai"

    def __init__(
        self,
        *,
        api_key: str,
        base_url: str | None = None,
        timeout: float | None = None,
    ) -> None:
        # ``base_url`` lets the operator point the adapter at an
        # OpenAI-compatible endpoint (Azure, vLLM, local Ollama proxy
        # speaking the OpenAI dialect). Defaults to api.openai.com.
        # ``timeout`` (seconds) overrides the openai SDK default of
        # 600s. Load-bearing for the Ollama path on slow hardware —
        # a 3B tools model on a Pi CPU can take 15–25 min per primary
        # call; default 10 min trips before the call completes. None
        # = SDK default applies.
        kwargs: dict = {"api_key": api_key}
        if base_url:
            kwargs["base_url"] = base_url
        if timeout is not None:
            kwargs["timeout"] = timeout
        self._client = AsyncOpenAI(**kwargs)
        self._pending = _PendingResult()

    async def stream_turn(
        self,
        *,
        model: str,
        messages: list[UserMessage],
        system: str | None = None,
        max_tokens: int = 4096,
        tools: list[dict] | None = None,
    ) -> AsyncIterator[AssistantBlock]:
        self._pending = _PendingResult(started_at=datetime.now(UTC))

        api_messages = _to_api_messages(messages, system)
        kwargs: dict = {
            "model": model,
            "messages": api_messages,
            "max_tokens": max_tokens,
            "stream": True,
            "stream_options": {"include_usage": True},
        }
        api_tools = _translate_tools(tools)
        if api_tools:
            kwargs["tools"] = api_tools

        text_buffer: list[str] = []
        tool_calls_by_index: dict[int, _PendingToolCall] = {}
        emitted_ids: set[str] = set()
        usage = None
        request_id: str | None = None

        stream = await self._client.chat.completions.create(**kwargs)
        async for chunk in stream:
            if request_id is None:
                request_id = getattr(chunk, "id", None)
            # Usage rides on the final chunk when ``include_usage`` is set.
            if getattr(chunk, "usage", None) is not None:
                usage = chunk.usage

            if not chunk.choices:
                continue

            choice = chunk.choices[0]
            delta = choice.delta

            text_delta = getattr(delta, "content", None) or ""
            if text_delta:
                text_buffer.append(text_delta)
                yield AssistantChunk(text=text_delta)

            for tc_delta in getattr(delta, "tool_calls", None) or []:
                idx = tc_delta.index
                pending = tool_calls_by_index.setdefault(
                    idx, _PendingToolCall()
                )
                if tc_delta.id:
                    pending.id = tc_delta.id
                fn = getattr(tc_delta, "function", None)
                if fn is not None:
                    if fn.name:
                        pending.name = fn.name
                    if fn.arguments:
                        pending.arguments_buffer.append(fn.arguments)

            if choice.finish_reason is not None:
                # The stream is signalling end-of-turn. Flush any tool
                # calls whose fragments have fully arrived but were not
                # yet emitted as finished blocks.
                for pending in tool_calls_by_index.values():
                    if pending.id in emitted_ids:
                        continue
                    if not pending.id or not pending.name:
                        continue
                    block = _finalise_tool_call(pending)
                    emitted_ids.add(pending.id)
                    yield block

        tool_uses = tuple(
            _finalise_tool_call(pending)
            for pending in tool_calls_by_index.values()
            if pending.id and pending.name and pending.id in emitted_ids
        )

        if usage is not None:
            self._pending.input_tokens = getattr(usage, "prompt_tokens", 0) or 0
            self._pending.output_tokens = (
                getattr(usage, "completion_tokens", 0) or 0
            )
            details = getattr(usage, "prompt_tokens_details", None)
            if details is not None:
                self._pending.cache_read_tokens = (
                    getattr(details, "cached_tokens", 0) or 0
                )
        self._pending.cost_usd = _estimate_cost(
            model,
            self._pending.input_tokens,
            self._pending.output_tokens,
            self._pending.cache_read_tokens,
            self._pending.cache_creation_tokens,
        )
        self._pending.finished_at = datetime.now(UTC)
        self._pending.request_id = request_id
        self._pending.message = AssistantMessage(
            content="".join(text_buffer),
            provider=self.name,
            model=model,
            tool_calls=tool_uses,
        )

    async def last_call_result(self) -> ProviderCallResult:
        p = self._pending
        if p.message is None:
            raise RuntimeError(
                "last_call_result() called before stream_turn completed"
            )
        return ProviderCallResult(
            message=p.message,
            input_tokens=p.input_tokens,
            output_tokens=p.output_tokens,
            cache_read_tokens=p.cache_read_tokens,
            cache_creation_tokens=p.cache_creation_tokens,
            cost_usd=p.cost_usd,
            started_at=p.started_at or datetime.now(UTC),
            finished_at=p.finished_at or datetime.now(UTC),
            request_id=p.request_id,
        )


def _finalise_tool_call(pending: _PendingToolCall) -> ToolUseBlock:
    """Turn a fully-arrived fragmented tool call into a :class:`ToolUseBlock`.

    The arguments arrive as a concatenated JSON string; the loop wants
    a parsed ``dict``. Parse-failures fall back to an empty dict and
    surface a synthetic ``_parse_error`` key so the tool handler can
    decide whether to reject or paper over the input.
    """
    raw = "".join(pending.arguments_buffer)
    try:
        parsed = json.loads(raw) if raw else {}
    except (json.JSONDecodeError, ValueError):
        parsed = {"_parse_error": raw}
    if not isinstance(parsed, dict):
        parsed = {"value": parsed}
    return ToolUseBlock(id=pending.id, name=pending.name, input=parsed)
