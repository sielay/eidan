"""Unit tests for the deterministic failure detector.

Covers the Phase 1.5 signal subset from `docs/009 §3.1` plus the
echoed-question heuristic the issue calls out.
"""

from __future__ import annotations

from eidan_backend.failure_detector import detect
from eidan_backend.providers.base import ToolUseBlock


def test_empty_response_triggers() -> None:
    result = detect(
        user_text="what is the capital of France?",
        final_text="",
        final_tool_calls=[],
        iterations_used=1,
        max_iterations=12,
    )
    names = [s.name for s in result.signals]
    assert "empty_response" in names
    assert result.should_critique


def test_whitespace_only_response_triggers_empty() -> None:
    result = detect(
        user_text="hi",
        final_text="   \n\t  ",
        final_tool_calls=[],
        iterations_used=1,
        max_iterations=12,
    )
    assert any(s.name == "empty_response" for s in result.signals)


def test_empty_text_with_tool_use_does_not_trigger_empty() -> None:
    """Tool-use without text is a legitimate intermediate state."""
    result = detect(
        user_text="please look it up",
        final_text="",
        final_tool_calls=[ToolUseBlock(id="t1", name="search", input={})],
        iterations_used=1,
        max_iterations=12,
    )
    assert not any(s.name == "empty_response" for s in result.signals)


def test_refusal_prefix_triggers() -> None:
    result = detect(
        user_text="explain how to do X",
        final_text="I cannot help with that request.",
        final_tool_calls=[],
        iterations_used=1,
        max_iterations=12,
    )
    names = [s.name for s in result.signals]
    assert "refusal" in names
    assert result.should_critique


def test_alternative_refusal_prefix_triggers() -> None:
    result = detect(
        user_text="do the thing",
        final_text="I'm sorry, but I can't help with that.",
        final_tool_calls=[],
        iterations_used=1,
        max_iterations=12,
    )
    assert any(s.name == "refusal" for s in result.signals)


def test_loop_exhausted_triggers() -> None:
    result = detect(
        user_text="run lots of tools",
        final_text="",
        final_tool_calls=[ToolUseBlock(id="t1", name="search", input={})],
        iterations_used=12,
        max_iterations=12,
    )
    assert any(s.name == "loop_exhausted" for s in result.signals)


def test_loop_exhausted_does_not_trigger_when_text_terminal() -> None:
    """Iteration cap hit but the final iteration produced text — that's a
    normal exit, not an exhaustion."""
    result = detect(
        user_text="something",
        final_text="here is your answer",
        final_tool_calls=[],
        iterations_used=12,
        max_iterations=12,
    )
    assert not any(s.name == "loop_exhausted" for s in result.signals)


def test_echoed_question_triggers() -> None:
    result = detect(
        user_text="what is the meaning of life and everything",
        final_text="what is the meaning of life and everything",
        final_tool_calls=[],
        iterations_used=1,
        max_iterations=12,
    )
    assert any(s.name == "echoed_question" for s in result.signals)


def test_short_answer_is_not_an_echo() -> None:
    """Short replies like "yes" are not echoes of the question."""
    result = detect(
        user_text="is the sky blue?",
        final_text="yes",
        final_tool_calls=[],
        iterations_used=1,
        max_iterations=12,
    )
    assert not any(s.name == "echoed_question" for s in result.signals)


def test_no_signals_on_normal_response() -> None:
    result = detect(
        user_text="what is 2 + 2?",
        final_text="The answer is 4. Let me know if you want a longer explanation.",
        final_tool_calls=[],
        iterations_used=1,
        max_iterations=12,
    )
    assert result.signals == ()
    assert not result.should_critique
