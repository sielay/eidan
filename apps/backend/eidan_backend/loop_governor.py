# SPDX-License-Identifier: AGPL-3.0-or-later
"""Autonomous-loop governance — `docs/027` slice 1.

A single turn is already bounded (`005 §5.5` `_MAX_TOOL_ITERATIONS`,
`009` within-turn critic, per-turn cost cap). This module governs the
*loop of turns* an agent drives without a human in the seat — the
sentry research loop is the load-bearing consumer: observe → maybe
research across several turns → decide it has **enough** to act, or
recognise it is **drilling with no progress** (the "keeps re-asking
who am I" failure) and break out before burning budget forever.

Slice 1 is deterministic and **pure** — no DB, no LLM, no provider:

- a cumulative **loop budget** (iterations / cost / wall-clock) — hard
  stops, independent of any semantic judgement; and
- a **no-progress detector** — repeated step intents, or a run of
  steps that wrote nothing new.

The governor only *decides*; it does not act, escalate, or persist.
The loop owner reads the verdict and, on a stop, records an escalation
(`022`) — the verdict's :attr:`LoopVerdict.cause` maps to a reason per
`docs/027 §7`. The sufficiency *critic* (converged → act) and the
escalation wiring land in slice 2, with the bicameral critic surface.
"""

from __future__ import annotations

import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field


@dataclass(frozen=True, slots=True)
class LoopBudget:
    """Cumulative ceilings for one autonomous loop, summed across every
    step. ``None`` disables that axis. Distinct from `010`'s per-turn
    ``max_turn_cost_usd`` — each step is its own turn with its own
    per-turn cap; this is the whole-loop accumulator."""

    max_iterations: int | None = None
    max_cost_usd: float | None = None
    max_wall_clock_s: float | None = None


@dataclass(frozen=True, slots=True)
class LoopVerdict:
    """The governor's decision after a step.

    ``kind`` is the coarse outcome the loop branches on; ``cause`` names
    the specific condition so the loop owner can map a stop onto an
    escalation reason (`docs/027 §7`): ``cost`` → ``over_budget``;
    ``iterations`` / ``wall_clock`` → ``over_capacity``; ``repeat`` /
    ``idle`` → a ``no_progress`` reason (added when escalation is wired).
    """

    kind: str  # "continue" | "budget" | "stuck"
    detail: str = ""
    cause: str = ""  # "cost" | "iterations" | "wall_clock" | "repeat" | "idle" | ""

    @property
    def should_stop(self) -> bool:
        return self.kind != "continue"


@dataclass
class LoopGovernor:
    """Governs one autonomous loop. Opt-in for agent-initiated flows —
    user-driven turns are bounded by the user and never use it.

    Usage (the loop owner drives the cadence)::

        gov = LoopGovernor(budget=LoopBudget(max_iterations=5, max_cost_usd=0.50))
        while True:
            result = await run_one_step(...)
            gov.record_step(
                fingerprint=intent_fingerprint(result),
                cost_usd=result.cost_usd,
                produced_new_memory=result.wrote_anything,
            )
            verdict = gov.verdict()
            if verdict.should_stop:
                # owner escalates per docs/027 §7 using verdict.cause
                break

    The detector is deterministic; a later slice may swap the
    fingerprint for embedding-similarity novelty without changing the
    verdict contract.
    """

    budget: LoopBudget
    #: A repeated trailing run of this many identical fingerprints is
    #: "stuck" (the "who am I" loop).
    no_progress_repeat: int = 3
    #: This many consecutive steps that wrote nothing new is "stuck".
    no_progress_idle: int = 3
    #: Monotonic clock; injectable for tests.
    clock: Callable[[], float] = time.monotonic

    _fingerprints: list[str] = field(default_factory=list, init=False)
    _idle_streak: int = field(default=0, init=False)
    _iterations: int = field(default=0, init=False)
    _cost_usd: float = field(default=0.0, init=False)
    _start: float = field(default=0.0, init=False)

    def __post_init__(self) -> None:
        self._start = self.clock()

    def record_step(
        self,
        *,
        fingerprint: str,
        cost_usd: float = 0.0,
        produced_new_memory: bool = True,
    ) -> None:
        """Record one completed step. ``fingerprint`` is a stable hash of
        the step's *intent* (e.g. the tool + canonical args it ran, or the
        seed text of a turn). ``produced_new_memory`` is whether the step
        wrote anything durable (knowledge / notes / a result)."""
        self._fingerprints.append(fingerprint)
        self._iterations += 1
        self._cost_usd += cost_usd
        self._idle_streak = 0 if produced_new_memory else self._idle_streak + 1

    def verdict(self) -> LoopVerdict:
        """Decide whether the loop may continue, after the latest step.

        Budget ceilings (hard stops) take precedence over no-progress, so
        a loop that has blown its budget stops regardless of whether it
        was still making progress.
        """
        b = self.budget
        if b.max_cost_usd is not None and self._cost_usd >= b.max_cost_usd:
            return LoopVerdict(
                kind="budget",
                cause="cost",
                detail=f"loop cost {self._cost_usd:.4f} >= cap {b.max_cost_usd:.4f}",
            )
        if b.max_iterations is not None and self._iterations >= b.max_iterations:
            return LoopVerdict(
                kind="budget",
                cause="iterations",
                detail=f"loop reached {self._iterations}/{b.max_iterations} steps",
            )
        if b.max_wall_clock_s is not None:
            elapsed = self.clock() - self._start
            if elapsed >= b.max_wall_clock_s:
                return LoopVerdict(
                    kind="budget",
                    cause="wall_clock",
                    detail=f"loop ran {elapsed:.1f}s >= cap {b.max_wall_clock_s:.1f}s",
                )
        if self._is_repeating():
            return LoopVerdict(
                kind="stuck",
                cause="repeat",
                detail=(
                    f"last {self.no_progress_repeat} steps shared one intent "
                    "fingerprint"
                ),
            )
        if self._idle_streak >= self.no_progress_idle:
            return LoopVerdict(
                kind="stuck",
                cause="idle",
                detail=f"{self._idle_streak} steps in a row wrote nothing new",
            )
        return LoopVerdict(kind="continue")

    def _is_repeating(self) -> bool:
        k = self.no_progress_repeat
        if k <= 0 or len(self._fingerprints) < k:
            return False
        tail = self._fingerprints[-k:]
        return len(set(tail)) == 1


@dataclass(frozen=True, slots=True)
class StepResult:
    """What one step of a governed loop reports back to the driver.

    ``fingerprint`` is a stable hash of the step's *intent* (so the
    governor can spot repetition); ``produced_new_memory`` is whether it
    wrote anything durable; ``done`` is the step's own signal that the
    work is complete — the slice-1 sufficiency proxy, refined by the
    critic in slice 2. ``payload`` carries step-specific data the caller
    wants back (e.g. the turn's message ids)."""

    fingerprint: str
    cost_usd: float = 0.0
    produced_new_memory: bool = True
    done: bool = False
    payload: object = None


@dataclass(frozen=True, slots=True)
class LoopOutcome:
    """The result of a governed loop.

    ``stopped_by`` is ``"done"`` (a step signalled completion — the
    closest slice-1 has to StopSufficient), or the governor's verdict
    kind (``"budget"`` / ``"stuck"``). ``verdict`` is the governor's
    last verdict; on a ``"done"`` stop it is the final ``continue``
    verdict. ``bailed`` is True when the loop stopped on budget/stuck
    rather than completing — the caller escalates in that case
    (:func:`escalation_for_loop_stop`)."""

    stopped_by: str  # "done" | "budget" | "stuck"
    steps: int
    verdict: LoopVerdict
    last_payload: object = None

    @property
    def bailed(self) -> bool:
        return self.stopped_by in ("budget", "stuck")


async def run_governed_loop(
    *,
    governor: LoopGovernor,
    step: Callable[[int], Awaitable[StepResult]],
    safety_cap: int = 50,
) -> LoopOutcome:
    """Drive ``step`` repeatedly under ``governor`` until the work is
    done or the governor stops it.

    Each call ``await step(i)`` performs one unit of work (typically one
    turn) and returns a :class:`StepResult`. The loop records it, lets a
    ``done`` step finish cleanly, otherwise consults the governor:
    ``continue`` runs the next step; ``budget`` / ``stuck`` end the loop
    (``LoopOutcome.bailed`` → the caller escalates per ``docs/027 §7``).

    ``safety_cap`` is an absolute backstop independent of the budget — a
    governor misconfigured with all limits ``None`` and a step that
    never reports ``done`` would otherwise spin forever.
    """
    i = 0
    verdict = LoopVerdict(kind="continue")
    last_payload: object = None
    while i < safety_cap:
        result = await step(i)
        i += 1
        last_payload = result.payload
        governor.record_step(
            fingerprint=result.fingerprint,
            cost_usd=result.cost_usd,
            produced_new_memory=result.produced_new_memory,
        )
        if result.done:
            return LoopOutcome(
                stopped_by="done", steps=i, verdict=governor.verdict(),
                last_payload=last_payload,
            )
        verdict = governor.verdict()
        if verdict.should_stop:
            return LoopOutcome(
                stopped_by=verdict.kind, steps=i, verdict=verdict,
                last_payload=last_payload,
            )
    return LoopOutcome(
        stopped_by="budget",
        steps=i,
        verdict=LoopVerdict(
            kind="budget", cause="iterations",
            detail=f"hit safety cap of {safety_cap} steps",
        ),
        last_payload=last_payload,
    )


__all__ = [
    "LoopBudget",
    "LoopGovernor",
    "LoopOutcome",
    "LoopVerdict",
    "StepResult",
    "run_governed_loop",
]
