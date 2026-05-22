"""Tests for the cross-turn failure detector + classifier fallback
(issue #93 / `docs/009 §3.2`, §6).

The within-turn detector already lives in
``failure_detector.detect`` and is exercised by other tests. This file
focuses on:

- the new ``detect_pre_primary`` rules over a synthetic history,
- ``aggregate_weight`` summing the §3.2 weight table,
- the ``classify_failure`` LLM-driven fallback parsing JSON output
  cleanly and collapsing malformed responses to ``proceed``.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from datetime import UTC, datetime

import pytest
from eidan_backend.classifiers.failure import classify_failure
from eidan_backend.failure_detector import (
    HistoryMessage,
    aggregate_weight,
    detect_pre_primary,
)
from eidan_backend.providers.base import (
    AssistantBlock,
    AssistantChunk,
    AssistantMessage,
    ProviderCallResult,
    UserMessage,
)

# ---- pre-primary detector ------------------------------------------------


def test_repeated_correction_prefix_fires() -> None:
    history = [
        HistoryMessage(role="user", content="What time is it?"),
        HistoryMessage(role="assistant", content="It is 3pm."),
    ]
    result = detect_pre_primary(
        user_text="no that's wrong, I asked for the date",
        history=history,
    )
    names = {s.name for s in result.signals}
    assert "repeated_correction" in names
    # Same message also hits the direct-correction-phrase rule.
    assert "direct_correction_phrase" in names


def test_near_identical_user_msg_fires_on_jaccard_match() -> None:
    history = [
        HistoryMessage(role="user", content="Find my dentist appointment for next week"),
        HistoryMessage(
            role="assistant",
            content="I couldn't find a dentist appointment in your calendar.",
        ),
    ]
    result = detect_pre_primary(
        user_text="Find my dentist appointment for next week please",
        history=history,
    )
    names = {s.name for s in result.signals}
    assert "near_identical_user_msg" in names


def test_short_user_msg_does_not_trigger_near_identical() -> None:
    """Token-set Jaccard is unreliable on very short strings — the
    detector skips messages below the minimum token count."""
    history = [
        HistoryMessage(role="user", content="ok"),
    ]
    result = detect_pre_primary(user_text="ok", history=history)
    assert "near_identical_user_msg" not in {s.name for s in result.signals}


def test_unanswered_question_after_refusal() -> None:
    history = [
        HistoryMessage(role="user", content="Can you book the flight?"),
        HistoryMessage(
            role="assistant",
            content="I cannot book flights without confirmation.",
        ),
    ]
    result = detect_pre_primary(
        user_text="Why can't you book the flight?",
        history=history,
    )
    names = {s.name for s in result.signals}
    assert "unanswered_question" in names


def test_prior_critic_fired_signal() -> None:
    history = [
        HistoryMessage(role="user", content="Compose a reply."),
        HistoryMessage(
            role="assistant",
            content="Done.",
            metadata={"critic": {"verdict": "rewrite", "reason": "too curt"}},
        ),
    ]
    result = detect_pre_primary(
        user_text="What about the second paragraph?",
        history=history,
    )
    assert "prior_critic_fired" in {s.name for s in result.signals}


def test_frustration_lexicon_matches_punctuation_runs() -> None:
    history = [
        HistoryMessage(role="user", content="set my alarm"),
        HistoryMessage(role="assistant", content="Alarm set for 7am."),
    ]
    result = detect_pre_primary(
        user_text="That's wrong!!! I said NINE THIRTY MORNING",
        history=history,
    )
    names = {s.name for s in result.signals}
    assert "frustration_marker" in names
    assert "direct_correction_phrase" in names


def test_aggregate_weight_sums_from_table() -> None:
    """Cross-turn weight table from docs/009 §3.2 produces predictable
    aggregates. repeated_correction (0.9) + direct_correction_phrase
    (0.8) = 1.7."""
    history = [
        HistoryMessage(role="assistant", content="answer"),
    ]
    result = detect_pre_primary(
        user_text="no, that's wrong",
        history=history,
    )
    assert aggregate_weight(result) == pytest.approx(1.7)


def test_no_signals_on_clean_first_turn() -> None:
    """A brand-new conversation with no prior turns produces no
    cross-turn signals — the detector is silent when there's no
    history to lean on."""
    result = detect_pre_primary(
        user_text="What's the weather in Paris?",
        history=[],
    )
    assert result.signals == ()
    assert aggregate_weight(result) == 0.0


# ---- classifier fallback -------------------------------------------------


class _ScriptedProvider:
    """Single-call fake provider that yields a scripted JSON string."""

    name = "fake"

    def __init__(self, output: str) -> None:
        self._output = output
        self._last: ProviderCallResult | None = None

    async def stream_turn(
        self, *, model: str, messages, system=None, max_tokens=4096, tools=None
    ) -> AsyncIterator[AssistantBlock]:
        yield AssistantChunk(text=self._output)
        now = datetime.now(UTC)
        self._last = ProviderCallResult(
            message=AssistantMessage(
                content=self._output,
                provider=self.name,
                model=model,
            ),
            input_tokens=20,
            output_tokens=10,
            started_at=now,
            finished_at=now,
            request_id="req-1",
        )

    async def last_call_result(self) -> ProviderCallResult:
        assert self._last is not None
        return self._last


@pytest.mark.asyncio
async def test_classify_failure_parses_escalate_verdict() -> None:
    provider = _ScriptedProvider(
        '{"verdict": "escalate", "reason": "user re-asked the same question"}'
    )
    result, call = await classify_failure(
        provider=provider,
        user_text="please answer my question",
        history=[
            HistoryMessage(role="user", content="please answer my question"),
            HistoryMessage(role="assistant", content="I cannot do that."),
        ],
        matched_signals=["near_identical_user_msg", "repeated_correction"],
    )
    assert result.verdict == "escalate"
    assert "re-asked" in result.reason
    assert result.should_escalate is True
    # Telemetry shape — the loop persists this with role=failure_classifier.
    assert call.input_tokens == 20
    assert call.output_tokens == 10


@pytest.mark.asyncio
async def test_classify_failure_collapses_malformed_to_proceed() -> None:
    provider = _ScriptedProvider("not even close to JSON")
    result, _ = await classify_failure(
        provider=provider,
        user_text="hi",
        history=[],
        matched_signals=[],
    )
    assert result.verdict == "proceed"
    assert result.reason == ""


@pytest.mark.asyncio
async def test_classify_failure_rejects_unknown_verdict() -> None:
    """A well-formed JSON with a verdict outside the allowed set
    collapses to ``proceed`` — same posture as malformed JSON."""
    provider = _ScriptedProvider(
        '{"verdict": "definitely_escalate", "reason": "x"}'
    )
    result, _ = await classify_failure(
        provider=provider,
        user_text="hi",
        history=[],
        matched_signals=[],
    )
    assert result.verdict == "proceed"
    # Reason is preserved even on a rejected verdict, so the operator
    # can see what the model wanted to say.
    assert result.reason == "x"


@pytest.mark.asyncio
async def test_classify_failure_message_includes_matched_signals() -> None:
    """The classifier's prompt should mention the deterministic signals
    so the model has the same context the detector did. A hand-rolled
    fake provider captures the prompt for assertion."""

    captured: dict = {}

    class _CapturingProvider(_ScriptedProvider):
        async def stream_turn(self, **kwargs):
            captured["messages"] = kwargs["messages"]
            async for chunk in super().stream_turn(**kwargs):
                yield chunk

    provider = _CapturingProvider(
        '{"verdict": "proceed", "reason": "ok"}'
    )
    await classify_failure(
        provider=provider,
        user_text="weather?",
        history=[
            HistoryMessage(role="user", content="weather?"),
            HistoryMessage(
                role="assistant", content="I cannot check the weather."
            ),
        ],
        matched_signals=["unanswered_question", "near_identical_user_msg"],
    )
    body = captured["messages"][0].content
    assert "near_identical_user_msg" in body
    assert "unanswered_question" in body
    # And the transcript renders the prior assistant message.
    assert "I cannot check the weather" in body


@pytest.mark.asyncio
async def test_classify_failure_history_drops_tool_turns() -> None:
    """Tool turns are noise for the failure classifier — only
    user/assistant dialogue should reach the prompt."""

    captured: dict = {}

    class _CapturingProvider(_ScriptedProvider):
        async def stream_turn(self, **kwargs):
            captured["messages"] = kwargs["messages"]
            async for chunk in super().stream_turn(**kwargs):
                yield chunk

    provider = _CapturingProvider(
        '{"verdict": "proceed", "reason": "ok"}'
    )
    await classify_failure(
        provider=provider,
        user_text="hi again",
        history=[
            HistoryMessage(role="user", content="run the tool"),
            HistoryMessage(role="tool", content="{result:'42'}"),
            HistoryMessage(role="assistant", content="The answer is 42."),
        ],
        matched_signals=["repeated_correction"],
    )
    body = captured["messages"][0].content
    assert "tool" not in body.lower().split("\n")[2]  # transcript row is user/assistant


# ---- silence the linter on the unused UserMessage import ------------------

_ = UserMessage
