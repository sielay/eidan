"""Anthropic adapter — streaming, multi-block, with tool use.

Phase 1 talked to the Messages API for text-only single-turn calls.
Phase 1.5 adds tool_use streaming: the adapter accepts a `tools=`
surface, translates :class:`UserMessage`s with `tool_calls` /
`tool_results` blocks into the provider's multi-block content, and
yields completed :class:`ToolUseBlock`s alongside text deltas.

Pricing for cost_usd: a small in-process table per (model, token_type).
Updates roll forward in a single place — docs/007 §6.4 puts pricing
ownership on the host so historical reporting does not need to know past
prices.
"""

from __future__ import annotations

import os
from collections.abc import AsyncIterator
from dataclasses import dataclass
from datetime import UTC, datetime

from anthropic import AsyncAnthropic

from .base import (
    AssistantBlock,
    AssistantChunk,
    AssistantMessage,
    ProviderCallResult,
    ToolUseBlock,
    UserMessage,
)

# USD per 1M tokens. Conservative defaults; an operator can override at
# runtime via env vars (see :func:`_pricing_for`).
_DEFAULT_PRICING: dict[str, dict[str, float]] = {
    "claude-opus-4-7": {
        "input": 15.0,
        "output": 75.0,
        "cache_read": 1.50,
        "cache_creation": 18.75,
    },
    "claude-sonnet-4-6": {
        "input": 3.0,
        "output": 15.0,
        "cache_read": 0.30,
        "cache_creation": 3.75,
    },
    "claude-haiku-4-5-20251001": {
        "input": 1.0,
        "output": 5.0,
        "cache_read": 0.10,
        "cache_creation": 1.25,
    },
}

_RATE_KEYS = ("input", "output", "cache_read", "cache_creation")


def _model_env_key(model: str) -> str:
    """Normalise a model id for env-var lookup.

    ``claude-opus-4-7`` → ``CLAUDE_OPUS_4_7``. Any character outside
    ``[A-Z0-9_]`` collapses to ``_`` so a future model id with unusual
    punctuation still maps to a legal env-var suffix.
    """
    upper = model.upper()
    return "".join(c if c.isalnum() else "_" for c in upper)


def _pricing_for(model: str) -> dict[str, float] | None:
    """Resolve per-Mtok rates for ``model``, applying env overrides.

    Starts from :data:`_DEFAULT_PRICING` and overlays
    ``EIDAN_PRICE_<MODEL>_{INPUT,OUTPUT,CACHE_READ,CACHE_CREATION}``
    from the environment. Returns ``None`` for an unknown model with
    no env overrides — the caller treats that as "cannot price."
    """
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


def _to_api_messages(messages: list[UserMessage]) -> list[dict]:
    """Translate neutral :class:`UserMessage`s into the Anthropic shape.

    On the wire Anthropic carries tool_result blocks inside a *user*
    turn, not a separate "tool" role. Eidan's DB schema uses a distinct
    ``role='tool'`` for hygiene (`docs/003 §3`); the translation
    happens here so the loop and the schema stay in one consistent
    shape.
    """
    api: list[dict] = []
    for m in messages:
        if m.role == "tool":
            api.append(
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "tool_result",
                            "tool_use_id": r.tool_use_id,
                            "content": r.content,
                            **({"is_error": True} if r.is_error else {}),
                        }
                        for r in m.tool_results
                    ],
                }
            )
            continue

        if m.role == "assistant" and m.tool_calls:
            blocks: list[dict] = []
            if m.content:
                blocks.append({"type": "text", "text": m.content})
            for t in m.tool_calls:
                blocks.append(
                    {
                        "type": "tool_use",
                        "id": t.id,
                        "name": t.name,
                        "input": t.input,
                    }
                )
            api.append({"role": "assistant", "content": blocks})
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


class AnthropicProvider:
    """Adapter for `anthropic.AsyncAnthropic`'s Messages streaming API."""

    name = "anthropic"

    def __init__(self, *, api_key: str) -> None:
        self._client = AsyncAnthropic(api_key=api_key)
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

        kwargs: dict = {
            "model": model,
            "messages": _to_api_messages(messages),
            "max_tokens": max_tokens,
        }
        if system:
            kwargs["system"] = system
        if tools:
            kwargs["tools"] = tools

        text_buffer: list[str] = []

        async with self._client.messages.stream(**kwargs) as stream:
            async for text_delta in stream.text_stream:
                text_buffer.append(text_delta)
                yield AssistantChunk(text=text_delta)

            final = await stream.get_final_message()

        tool_uses: list[ToolUseBlock] = []
        for block in final.content:
            if getattr(block, "type", None) == "tool_use":
                tu = ToolUseBlock(
                    id=block.id,
                    name=block.name,
                    input=dict(block.input) if block.input is not None else {},
                )
                tool_uses.append(tu)
                yield tu

        usage = final.usage
        self._pending.input_tokens = getattr(usage, "input_tokens", 0) or 0
        self._pending.output_tokens = getattr(usage, "output_tokens", 0) or 0
        self._pending.cache_read_tokens = (
            getattr(usage, "cache_read_input_tokens", 0) or 0
        )
        self._pending.cache_creation_tokens = (
            getattr(usage, "cache_creation_input_tokens", 0) or 0
        )
        self._pending.cost_usd = _estimate_cost(
            model,
            self._pending.input_tokens,
            self._pending.output_tokens,
            self._pending.cache_read_tokens,
            self._pending.cache_creation_tokens,
        )
        self._pending.finished_at = datetime.now(UTC)
        self._pending.request_id = getattr(final, "id", None)
        self._pending.message = AssistantMessage(
            content="".join(text_buffer),
            provider=self.name,
            model=model,
            tool_calls=tuple(tool_uses),
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
