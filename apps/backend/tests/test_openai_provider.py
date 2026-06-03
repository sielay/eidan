"""Tests for the OpenAI adapter (issue #91 / docs/007).

Covers:

- Pricing table + env-var overrides (mirrors the Anthropic adapter's
  test surface so an operator's price-override mental model stays
  consistent across providers).
- ``_translate_tools`` — Anthropic-shaped tools land in OpenAI's
  function-call shape; tools already in OpenAI shape pass through.
- ``_to_api_messages`` — neutral :class:`UserMessage` translation,
  including the multi-message fan-out for ``role="tool"`` turns and
  the system-prompt-as-first-message convention.
- End-to-end ``stream_turn`` exercise with a fake AsyncOpenAI client
  that yields a scripted stream of chunks, asserting both text-delta
  yields and the assembled :class:`ToolUseBlock`.
"""

from __future__ import annotations

import json
from collections.abc import AsyncIterator
from dataclasses import dataclass
from typing import Any

import pytest
from eidan_backend.providers.base import (
    AssistantChunk,
    ToolResultBlock,
    ToolUseBlock,
    UserMessage,
)
from eidan_backend.providers.openai import (
    _DEFAULT_PRICING,
    OpenAIProvider,
    _estimate_cost,
    _model_env_key,
    _pricing_for,
    _to_api_messages,
    _translate_tools,
)

# ---- pricing -------------------------------------------------------------


def test_baseline_pricing_matches_default_table() -> None:
    rates = _DEFAULT_PRICING["gpt-4o"]
    cost = _estimate_cost(
        "gpt-4o",
        input_tokens=1_000_000,
        output_tokens=0,
        cache_read=0,
        cache_creation=0,
    )
    assert cost == pytest.approx(rates["input"])


def test_unknown_model_costs_zero() -> None:
    assert (
        _estimate_cost(
            "gpt-not-real",
            input_tokens=1_000_000,
            output_tokens=1_000_000,
            cache_read=0,
            cache_creation=0,
        )
        == 0.0
    )


def test_model_env_key_normalisation() -> None:
    # OpenAI model ids carry dots (gpt-4.1); the env-var rule replaces
    # any non-alphanumeric with `_` so the operator can spell the key.
    assert _model_env_key("gpt-4o") == "GPT_4O"
    assert _model_env_key("gpt-4.1-mini") == "GPT_4_1_MINI"


def test_env_override_arbitrary_rate(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("EIDAN_PRICE_GPT_4O_OUTPUT", "5.0")
    cost = _estimate_cost(
        "gpt-4o",
        input_tokens=0,
        output_tokens=2_000_000,
        cache_read=0,
        cache_creation=0,
    )
    # 2_000_000 * 5 / 1e6 = 10.0
    assert cost == pytest.approx(10.0)


def test_env_override_for_unpriced_model(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("EIDAN_PRICE_GPT_FUTURE_INPUT", "1.0")
    monkeypatch.setenv("EIDAN_PRICE_GPT_FUTURE_OUTPUT", "4.0")
    cost = _estimate_cost(
        "gpt-future",
        input_tokens=1_000_000,
        output_tokens=500_000,
        cache_read=0,
        cache_creation=0,
    )
    # 1 * 1.0 + 0.5 * 4.0 = 3.0
    assert cost == pytest.approx(3.0)


def test_malformed_override_falls_back_to_default(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("EIDAN_PRICE_GPT_4O_INPUT", "not-a-float")
    rates = _pricing_for("gpt-4o")
    assert rates is not None
    assert rates["input"] == _DEFAULT_PRICING["gpt-4o"]["input"]


# ---- tool translation ----------------------------------------------------


def test_translate_tools_from_anthropic_shape() -> None:
    out = _translate_tools(
        [
            {
                "name": "search",
                "description": "Search the index.",
                "input_schema": {"type": "object", "properties": {}},
            }
        ]
    )
    assert out == [
        {
            "type": "function",
            "function": {
                "name": "search",
                "description": "Search the index.",
                "parameters": {"type": "object", "properties": {}},
            },
        }
    ]


def test_translate_tools_passes_openai_shape_through() -> None:
    native = {
        "type": "function",
        "function": {
            "name": "x",
            "description": "y",
            "parameters": {"type": "object"},
        },
    }
    assert _translate_tools([native]) == [native]


def test_translate_tools_none_or_empty() -> None:
    assert _translate_tools(None) is None
    assert _translate_tools([]) is None


# ---- message translation -------------------------------------------------


def test_to_api_messages_prepends_system_when_present() -> None:
    out = _to_api_messages(
        [UserMessage(role="user", content="hi")],
        system="You are concise.",
    )
    assert out[0] == {"role": "system", "content": "You are concise."}
    assert out[1] == {"role": "user", "content": "hi"}


def test_to_api_messages_omits_system_when_absent() -> None:
    out = _to_api_messages(
        [UserMessage(role="user", content="hi")],
        system=None,
    )
    assert out == [{"role": "user", "content": "hi"}]


def test_to_api_messages_fans_out_tool_results() -> None:
    """A neutral ``role="tool"`` turn with two tool_results becomes two
    OpenAI ``role="tool"`` messages, each with its own ``tool_call_id``."""
    out = _to_api_messages(
        [
            UserMessage(
                role="tool",
                tool_results=(
                    ToolResultBlock(tool_use_id="call-1", content="ok"),
                    ToolResultBlock(
                        tool_use_id="call-2", content="boom", is_error=True
                    ),
                ),
            )
        ],
        system=None,
    )
    assert out == [
        {"role": "tool", "tool_call_id": "call-1", "content": "ok"},
        {"role": "tool", "tool_call_id": "call-2", "content": "boom"},
    ]


def test_to_api_messages_assistant_tool_calls() -> None:
    """Assistant turns carrying tool_calls serialise the input dict as
    a JSON string, matching OpenAI's wire shape."""
    out = _to_api_messages(
        [
            UserMessage(
                role="assistant",
                content="checking",
                tool_calls=(
                    ToolUseBlock(id="call-1", name="search", input={"q": "x"}),
                ),
            )
        ],
        system=None,
    )
    assert out == [
        {
            "role": "assistant",
            "content": "checking",
            "tool_calls": [
                {
                    "id": "call-1",
                    "type": "function",
                    "function": {
                        "name": "search",
                        "arguments": json.dumps({"q": "x"}),
                    },
                }
            ],
        }
    ]


# ---- streaming end-to-end ------------------------------------------------


@dataclass
class _FakeDeltaFn:
    name: str | None = None
    arguments: str | None = None


@dataclass
class _FakeDeltaToolCall:
    index: int
    id: str | None = None
    function: _FakeDeltaFn | None = None


@dataclass
class _FakeDelta:
    content: str | None = None
    tool_calls: list[_FakeDeltaToolCall] | None = None


@dataclass
class _FakeChoice:
    delta: _FakeDelta
    finish_reason: str | None = None


@dataclass
class _FakeUsageDetails:
    cached_tokens: int = 0


@dataclass
class _FakeUsage:
    prompt_tokens: int = 0
    completion_tokens: int = 0
    prompt_tokens_details: _FakeUsageDetails | None = None


@dataclass
class _FakeChunk:
    choices: list[_FakeChoice]
    usage: _FakeUsage | None = None
    id: str | None = None


class _FakeStream:
    """Async iterable that walks a scripted list of chunks."""

    def __init__(self, chunks: list[_FakeChunk]) -> None:
        self._chunks = chunks

    def __aiter__(self) -> AsyncIterator[_FakeChunk]:
        async def gen() -> AsyncIterator[_FakeChunk]:
            for c in self._chunks:
                yield c

        return gen()


class _FakeCompletions:
    def __init__(self, chunks: list[_FakeChunk]) -> None:
        self._chunks = chunks
        self.last_kwargs: dict[str, Any] | None = None

    async def create(self, **kwargs: Any) -> _FakeStream:
        self.last_kwargs = kwargs
        return _FakeStream(self._chunks)


class _FakeChat:
    def __init__(self, completions: _FakeCompletions) -> None:
        self.completions = completions


class _FakeClient:
    def __init__(self, chunks: list[_FakeChunk]) -> None:
        self.chat = _FakeChat(_FakeCompletions(chunks))


def _provider_with_fake(chunks: list[_FakeChunk]) -> OpenAIProvider:
    provider = OpenAIProvider(api_key="sk-test")
    provider._client = _FakeClient(chunks)  # type: ignore[assignment]
    return provider


@pytest.mark.asyncio
async def test_stream_turn_yields_text_deltas_and_records_usage() -> None:
    chunks = [
        _FakeChunk(
            id="cmpl-1",
            choices=[_FakeChoice(delta=_FakeDelta(content="Hello"))],
        ),
        _FakeChunk(
            choices=[_FakeChoice(delta=_FakeDelta(content=" world"))],
        ),
        _FakeChunk(
            choices=[_FakeChoice(delta=_FakeDelta(), finish_reason="stop")],
        ),
        _FakeChunk(
            choices=[],
            usage=_FakeUsage(
                prompt_tokens=12,
                completion_tokens=4,
                prompt_tokens_details=_FakeUsageDetails(cached_tokens=3),
            ),
        ),
    ]
    provider = _provider_with_fake(chunks)
    blocks = []
    async for block in provider.stream_turn(
        model="gpt-4o",
        messages=[UserMessage(role="user", content="hi")],
    ):
        blocks.append(block)
    result = await provider.last_call_result()

    text_chunks = [b for b in blocks if isinstance(b, AssistantChunk)]
    assert [c.text for c in text_chunks] == ["Hello", " world"]
    assert result.message.content == "Hello world"
    assert result.message.tool_calls == ()
    assert result.input_tokens == 12
    assert result.output_tokens == 4
    assert result.cache_read_tokens == 3
    assert result.cache_creation_tokens == 0
    # cost rolls up: 12 * 2.5 / 1e6 + 4 * 10 / 1e6 + 3 * 1.25 / 1e6
    expected = round((12 * 2.5 + 4 * 10.0 + 3 * 1.25) / 1_000_000, 6)
    assert result.cost_usd == pytest.approx(expected)
    assert result.request_id == "cmpl-1"


@pytest.mark.asyncio
async def test_stream_turn_assembles_fragmented_tool_call() -> None:
    """OpenAI streams tool_call name/arguments in fragments by index;
    the adapter must reassemble and emit one finished ToolUseBlock."""
    chunks = [
        _FakeChunk(
            choices=[
                _FakeChoice(
                    delta=_FakeDelta(
                        tool_calls=[
                            _FakeDeltaToolCall(
                                index=0,
                                id="call-a",
                                function=_FakeDeltaFn(name="search"),
                            )
                        ]
                    )
                )
            ],
        ),
        _FakeChunk(
            choices=[
                _FakeChoice(
                    delta=_FakeDelta(
                        tool_calls=[
                            _FakeDeltaToolCall(
                                index=0,
                                function=_FakeDeltaFn(arguments='{"q": "ei'),
                            )
                        ]
                    )
                )
            ],
        ),
        _FakeChunk(
            choices=[
                _FakeChoice(
                    delta=_FakeDelta(
                        tool_calls=[
                            _FakeDeltaToolCall(
                                index=0,
                                function=_FakeDeltaFn(arguments='dan"}'),
                            )
                        ]
                    )
                )
            ],
        ),
        _FakeChunk(
            choices=[
                _FakeChoice(
                    delta=_FakeDelta(),
                    finish_reason="tool_calls",
                )
            ],
            usage=_FakeUsage(prompt_tokens=8, completion_tokens=6),
        ),
    ]
    provider = _provider_with_fake(chunks)
    tool_blocks = []
    async for block in provider.stream_turn(
        model="gpt-4o-mini",
        messages=[UserMessage(role="user", content="search eidan")],
    ):
        if isinstance(block, ToolUseBlock):
            tool_blocks.append(block)
    result = await provider.last_call_result()

    assert len(tool_blocks) == 1
    assert tool_blocks[0].id == "call-a"
    assert tool_blocks[0].name == "search"
    assert tool_blocks[0].input == {"q": "eidan"}
    assert result.message.tool_calls == (tool_blocks[0],)


@pytest.mark.asyncio
async def test_stream_turn_handles_malformed_tool_args() -> None:
    """A truncated JSON tool-call argument lands as an empty dict with
    a synthetic ``_parse_error`` key the tool handler can surface."""
    chunks = [
        _FakeChunk(
            choices=[
                _FakeChoice(
                    delta=_FakeDelta(
                        tool_calls=[
                            _FakeDeltaToolCall(
                                index=0,
                                id="call-x",
                                function=_FakeDeltaFn(
                                    name="search",
                                    arguments='{"q": "broken',
                                ),
                            )
                        ]
                    ),
                    finish_reason="tool_calls",
                )
            ],
            usage=_FakeUsage(prompt_tokens=1, completion_tokens=1),
        ),
    ]
    provider = _provider_with_fake(chunks)
    tool_blocks = []
    async for block in provider.stream_turn(
        model="gpt-4o-mini",
        messages=[UserMessage(role="user", content="broken")],
    ):
        if isinstance(block, ToolUseBlock):
            tool_blocks.append(block)
    assert len(tool_blocks) == 1
    assert tool_blocks[0].input == {"_parse_error": '{"q": "broken'}


@pytest.mark.asyncio
async def test_stream_turn_passes_system_and_tools_to_api() -> None:
    chunks = [
        _FakeChunk(
            choices=[_FakeChoice(delta=_FakeDelta(content="ok"))],
        ),
        _FakeChunk(
            choices=[_FakeChoice(delta=_FakeDelta(), finish_reason="stop")],
            usage=_FakeUsage(prompt_tokens=1, completion_tokens=1),
        ),
    ]
    provider = _provider_with_fake(chunks)
    async for _ in provider.stream_turn(
        model="gpt-4o",
        messages=[UserMessage(role="user", content="hi")],
        system="be brief",
        tools=[
            {
                "name": "search",
                "description": "Search",
                "input_schema": {"type": "object"},
            }
        ],
    ):
        pass

    sent = provider._client.chat.completions.last_kwargs  # type: ignore[union-attr]
    assert sent is not None
    assert sent["messages"][0] == {"role": "system", "content": "be brief"}
    assert sent["tools"][0]["function"]["name"] == "search"
    assert sent["stream"] is True
    assert sent["stream_options"] == {"include_usage": True}


# ---- timeout ------------------------------------------------------------


def test_timeout_kwarg_flows_into_async_openai_client() -> None:
    """``timeout`` is the load-bearing knob for the Ollama path on
    slow hardware — a 3B tools model on a Pi CPU takes 15–25 min per
    primary call and the SDK's 10-min default trips before the call
    completes (#157)."""
    provider = OpenAIProvider(api_key="sk-test", timeout=1800.0)
    # The AsyncOpenAI client exposes the per-request timeout it was
    # constructed with on its ``timeout`` attribute.
    assert provider._client.timeout == 1800.0


def test_timeout_unset_preserves_async_openai_default() -> None:
    """``timeout=None`` (default) means we do NOT pass the kwarg, so
    the openai SDK's own default applies. Backwards-compat for every
    Anthropic / OpenAI.com operator who never set the env."""
    provider = OpenAIProvider(api_key="sk-test")
    # The SDK's default is a non-None httpx.Timeout / float; asserting
    # it's specifically not the value we'd set is the cheapest check
    # that no override leaked in.
    assert provider._client.timeout != 1800.0
