"""Unit tests for the says-vs-did detector signal (issue #60).

Two surfaces:

- ``failure_detector.detect`` with the new ``intended_actions`` and
  ``tool_uses_seen`` parameters — the signal fires when verifiable
  actions were declared but the primary emitted no tool_use blocks.
- ``critic._render_signals`` formats the signal's evidence into a
  prompt block the critic can act on.

End-to-end loop verification (a scripted turn that triggers the
signal AND records it on the assistant message's metadata) is in
``test_critic.py``'s extended coverage; this file owns the pure
unit tests.
"""

from __future__ import annotations

from eidan_backend.critic import _render_signals
from eidan_backend.failure_detector import FailureSignal, detect
from eidan_schemas import (
    CreateEvent,
    IntendedActions,
    Lookup,
    Unknown,
)


def test_signal_fires_when_verifiable_actions_have_no_tool_calls() -> None:
    intended = IntendedActions(
        actions=[
            CreateEvent(
                kind="create_event",
                when="2026-05-15T19:00:00+01:00",
                summary="dentist",
            )
        ]
    )

    result = detect(
        user_text="book dentist tomorrow at 7pm",
        final_text="Done — I added it to your calendar.",
        final_tool_calls=[],
        iterations_used=1,
        max_iterations=12,
        intended_actions=intended,
        tool_uses_seen=0,
    )

    names = [s.name for s in result.signals]
    assert "actions_declared_not_executed" in names
    fired = next(
        s for s in result.signals if s.name == "actions_declared_not_executed"
    )
    assert fired.evidence["declared"] == [
        {"kind": "create_event", "summary": "dentist"}
    ]
    assert fired.evidence["tool_uses_seen"] == 0


def test_signal_silent_when_tool_uses_observed() -> None:
    intended = IntendedActions(
        actions=[
            CreateEvent(
                kind="create_event",
                when="now",
                summary="standup",
            )
        ]
    )

    result = detect(
        user_text="schedule a standup",
        final_text="Done.",
        final_tool_calls=[],
        iterations_used=2,
        max_iterations=12,
        intended_actions=intended,
        tool_uses_seen=1,  # one tool_use was executed earlier in the loop
    )

    assert all(
        s.name != "actions_declared_not_executed" for s in result.signals
    )


def test_signal_silent_for_lookup_only_intent() -> None:
    """Lookups have no observable side-effect; the signal must NOT fire
    when the entire intent list is unverifiable."""
    intended = IntendedActions(
        actions=[Lookup(kind="lookup", query="what's the weather today")]
    )

    result = detect(
        user_text="what's the weather",
        final_text="It's mild and overcast.",
        final_tool_calls=[],
        iterations_used=1,
        max_iterations=12,
        intended_actions=intended,
        tool_uses_seen=0,
    )

    assert all(
        s.name != "actions_declared_not_executed" for s in result.signals
    )


def test_signal_silent_for_unknown_only_intent() -> None:
    intended = IntendedActions(
        actions=[Unknown(kind="unknown", note="unclear request")]
    )

    result = detect(
        user_text="hmm",
        final_text="Can you say more?",
        final_tool_calls=[],
        iterations_used=1,
        max_iterations=12,
        intended_actions=intended,
        tool_uses_seen=0,
    )

    assert all(
        s.name != "actions_declared_not_executed" for s in result.signals
    )


def test_signal_silent_when_intent_omitted() -> None:
    """Callers from outside the loop (older test fixtures) may not pass
    ``intended_actions``. The detector must degrade silently."""
    result = detect(
        user_text="hi",
        final_text="Hello there.",
        final_tool_calls=[],
        iterations_used=1,
        max_iterations=12,
    )
    assert all(
        s.name != "actions_declared_not_executed" for s in result.signals
    )


def test_render_signals_includes_declared_actions() -> None:
    """The critic's prompt sees the discrepancy with action names."""
    signals = (
        FailureSignal(
            name="actions_declared_not_executed",
            evidence={
                "declared": [
                    {"kind": "create_event", "summary": "dentist"},
                    {"kind": "send_message", "summary": "email"},
                ],
                "tool_uses_seen": 0,
            },
        ),
    )
    rendered = _render_signals(signals)
    assert "actions_declared_not_executed" in rendered
    assert "create_event" in rendered
    assert "dentist" in rendered
    assert "send_message" in rendered
    assert "no tool calls" in rendered


def test_render_signals_handles_empty_list() -> None:
    assert _render_signals(()) == "(none)"


def test_render_signals_renders_other_signals_with_evidence() -> None:
    signals = (
        FailureSignal(
            name="loop_exhausted",
            evidence={"iterations_used": 12, "max_iterations": 12},
        ),
    )
    rendered = _render_signals(signals)
    assert "loop_exhausted" in rendered
    assert "iterations_used" in rendered
