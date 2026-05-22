"""Behaviour-classifier tests (issue #104 / `docs/006 §5`).

Exercises the §5 prompt-assembly + JSON-parsing layer with a
scripted fake provider. The runner-side integration (filtering
candidate behaviours, snapshotting the registry per turn, mutating
the primary's system prompt + tool surface, AUTO vs OFFER routing)
lands once the BehaviourRegistry's shape extends to carry
prompt_stanza + tools at registration time — out of scope here.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from datetime import UTC, datetime

import pytest
from eidan_backend.classifiers.behaviour import (
    ActivationMode,
    IntentSituation,
    classify_behaviour,
)
from eidan_backend.providers.base import (
    AssistantBlock,
    AssistantChunk,
    AssistantMessage,
    ProviderCallResult,
)


class _ScriptedProvider:
    name = "fake"

    def __init__(self, output: str) -> None:
        self._output = output
        self._last: ProviderCallResult | None = None
        self.last_kwargs: dict | None = None

    async def stream_turn(
        self, *, model: str, messages, system=None, max_tokens=4096, tools=None
    ) -> AsyncIterator[AssistantBlock]:
        self.last_kwargs = {
            "model": model,
            "system": system,
            "messages": messages,
        }
        yield AssistantChunk(text=self._output)
        now = datetime.now(UTC)
        self._last = ProviderCallResult(
            message=AssistantMessage(
                content=self._output,
                provider=self.name,
                model=model,
            ),
            input_tokens=30,
            output_tokens=8,
            started_at=now,
            finished_at=now,
            request_id="req-1",
        )

    async def last_call_result(self) -> ProviderCallResult:
        assert self._last is not None
        return self._last


def test_activation_mode_enum() -> None:
    assert ActivationMode.AUTO == "auto"
    assert ActivationMode.OFFER == "offer"


@pytest.mark.asyncio
async def test_classify_behaviour_parses_match_indices() -> None:
    provider = _ScriptedProvider(
        '{"matches": [1, 3], "reason": "asks about notes; is brief"}'
    )
    result, call = await classify_behaviour(
        provider=provider,
        user_text="morning! summarise today's notes please",
        situations=[
            IntentSituation(
                trigger_index=1,
                description="user asks for a summary of today's notes",
            ),
            IntentSituation(
                trigger_index=2,
                description="user wants to schedule a reminder",
            ),
            IntentSituation(
                trigger_index=3,
                description="user message is short and conversational",
            ),
        ],
    )
    assert result.matches == (1, 3)
    assert "notes" in result.reason
    assert call.input_tokens == 30


@pytest.mark.asyncio
async def test_classify_behaviour_empty_matches_is_common() -> None:
    """Most turns load no behaviours; the classifier returning [] is
    a normal path, not an error."""
    provider = _ScriptedProvider('{"matches": [], "reason": "no match"}')
    result, _ = await classify_behaviour(
        provider=provider,
        user_text="hello",
        situations=[
            IntentSituation(
                trigger_index=1,
                description="user wants to send an email",
            ),
        ],
    )
    assert result.matches == ()
    assert result.reason == "no match"


@pytest.mark.asyncio
async def test_classify_behaviour_dedupes_repeat_indices() -> None:
    """A misbehaving classifier that returns the same index twice
    collapses to a single entry, preserving order."""
    provider = _ScriptedProvider('{"matches": [2, 2, 1], "reason": "x"}')
    result, _ = await classify_behaviour(
        provider=provider,
        user_text="any",
        situations=[
            IntentSituation(trigger_index=1, description="a"),
            IntentSituation(trigger_index=2, description="b"),
        ],
    )
    assert result.matches == (2, 1)


@pytest.mark.asyncio
async def test_classify_behaviour_malformed_returns_empty() -> None:
    """Garbage output collapses to ``matches = ()`` — the loop
    continues without any behaviours loaded for the turn, same
    posture as the scope classifier (`docs/006 §5.5`)."""
    provider = _ScriptedProvider("not json at all")
    result, _ = await classify_behaviour(
        provider=provider,
        user_text="any",
        situations=[IntentSituation(trigger_index=1, description="a")],
    )
    assert result.matches == ()
    assert result.reason == ""


@pytest.mark.asyncio
async def test_classify_behaviour_renders_recent_context() -> None:
    """The §5.2 RECENT CONTEXT section is included when the caller
    supplies messages. The classifier sees a bounded tail (default 4)."""
    provider = _ScriptedProvider('{"matches": [], "reason": ""}')
    await classify_behaviour(
        provider=provider,
        user_text="follow-up",
        situations=[IntentSituation(trigger_index=1, description="anything")],
        recent_context=[
            "USER: first thing",
            "ASSISTANT: an answer",
            "USER: second thing",
            "ASSISTANT: another answer",
            "USER: third thing",
        ],
    )
    body = provider.last_kwargs["messages"][0].content  # type: ignore[index]
    # The most recent four lines land; the oldest is dropped.
    assert "first thing" not in body
    assert "second thing" in body
    assert "another answer" in body


@pytest.mark.asyncio
async def test_classify_behaviour_rejects_empty_situations() -> None:
    """An empty survivor set means the classifier shouldn't run at
    all — the caller is expected to short-circuit. We raise so the
    bug surfaces loudly rather than spending a provider call on
    nothing."""
    provider = _ScriptedProvider("")
    with pytest.raises(ValueError):
        await classify_behaviour(
            provider=provider, user_text="x", situations=[]
        )
