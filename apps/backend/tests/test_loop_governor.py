# SPDX-License-Identifier: AGPL-3.0-or-later
"""LoopGovernor (#186 / docs/027 slice 1).

Pure deterministic governance of an autonomous loop of turns — no DB,
no LLM. Covers the loop budget (iterations / cost / wall-clock), the
no-progress detector (repeated intent / idle), streak reset on
progress, and budget-takes-precedence-over-stuck ordering.
"""

from __future__ import annotations

from eidan_backend.loop_governor import LoopBudget, LoopGovernor


class _FakeClock:
    """Controllable monotonic clock for wall-clock assertions."""

    def __init__(self) -> None:
        self.t = 0.0

    def __call__(self) -> float:
        return self.t


def test_continue_while_under_budget_and_progressing() -> None:
    gov = LoopGovernor(
        budget=LoopBudget(max_iterations=10, max_cost_usd=1.0),
        no_progress_repeat=3,
        no_progress_idle=3,
    )
    for i in range(4):
        gov.record_step(fingerprint=f"step-{i}", cost_usd=0.01, produced_new_memory=True)
        assert gov.verdict().kind == "continue"


def test_budget_iterations() -> None:
    gov = LoopGovernor(budget=LoopBudget(max_iterations=3))
    for i in range(2):
        gov.record_step(fingerprint=f"s{i}")
        assert gov.verdict().kind == "continue"
    gov.record_step(fingerprint="s2")
    v = gov.verdict()
    assert v.kind == "budget"
    assert v.cause == "iterations"


def test_budget_cost() -> None:
    gov = LoopGovernor(budget=LoopBudget(max_cost_usd=0.10))
    gov.record_step(fingerprint="a", cost_usd=0.04)
    assert gov.verdict().kind == "continue"
    gov.record_step(fingerprint="b", cost_usd=0.07)  # cumulative 0.11 >= 0.10
    v = gov.verdict()
    assert v.kind == "budget"
    assert v.cause == "cost"


def test_budget_wall_clock() -> None:
    clock = _FakeClock()
    gov = LoopGovernor(budget=LoopBudget(max_wall_clock_s=10.0), clock=clock)
    gov.record_step(fingerprint="a")
    assert gov.verdict().kind == "continue"
    clock.t = 11.0  # past the cap
    v = gov.verdict()
    assert v.kind == "budget"
    assert v.cause == "wall_clock"


def test_stuck_on_repeated_intent() -> None:
    """The 'who am I' loop: the same intent fingerprint three times."""
    gov = LoopGovernor(budget=LoopBudget(), no_progress_repeat=3)
    gov.record_step(fingerprint="who-am-i")
    gov.record_step(fingerprint="who-am-i")
    assert gov.verdict().kind == "continue"  # only 2 so far
    gov.record_step(fingerprint="who-am-i")
    v = gov.verdict()
    assert v.kind == "stuck"
    assert v.cause == "repeat"


def test_stuck_on_idle_no_new_memory() -> None:
    gov = LoopGovernor(budget=LoopBudget(), no_progress_idle=3)
    for _ in range(2):
        gov.record_step(fingerprint="x", produced_new_memory=False)
    # distinct enough not to trip 'repeat' yet — but vary fingerprints to be safe
    gov2 = LoopGovernor(budget=LoopBudget(), no_progress_idle=3, no_progress_repeat=99)
    for i in range(3):
        gov2.record_step(fingerprint=f"d{i}", produced_new_memory=False)
    v = gov2.verdict()
    assert v.kind == "stuck"
    assert v.cause == "idle"


def test_progress_resets_idle_streak() -> None:
    gov = LoopGovernor(budget=LoopBudget(), no_progress_idle=3, no_progress_repeat=99)
    gov.record_step(fingerprint="a", produced_new_memory=False)
    gov.record_step(fingerprint="b", produced_new_memory=False)
    gov.record_step(fingerprint="c", produced_new_memory=True)  # resets streak
    gov.record_step(fingerprint="d", produced_new_memory=False)
    gov.record_step(fingerprint="e", produced_new_memory=False)
    # only 2 idle since the reset — not stuck
    assert gov.verdict().kind == "continue"


def test_distinct_intents_do_not_trip_repeat() -> None:
    gov = LoopGovernor(budget=LoopBudget(), no_progress_repeat=3)
    for i in range(6):
        gov.record_step(fingerprint=f"distinct-{i}")
    assert gov.verdict().kind == "continue"


def test_budget_takes_precedence_over_stuck() -> None:
    """When a step trips both the iteration cap and the repeat detector,
    the hard budget stop wins (and reports its cause)."""
    gov = LoopGovernor(
        budget=LoopBudget(max_iterations=3), no_progress_repeat=3
    )
    for _ in range(3):
        gov.record_step(fingerprint="same")  # 3 identical → would be 'repeat'
    v = gov.verdict()
    assert v.kind == "budget"
    assert v.cause == "iterations"
