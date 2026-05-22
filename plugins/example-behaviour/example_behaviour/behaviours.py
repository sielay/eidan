"""Behaviour handlers for the example-behaviour plugin.

A single ``tick`` handler bound to ``cron: '* * * * *'`` in the
manifest. The handler records each invocation in a module-level list
so the smoke test can assert how many times the dispatcher fired it.

The handler is intentionally idempotent on
``TriggerEvent.idempotency_key`` (`docs/001 §5.2`): a key it has
already seen is skipped. The registry-level dedupe in
:class:`BehaviourRegistry` would catch it too, but doubling up here
mirrors what real plugin handlers should do — the host's at-least-
once delivery guarantee leaks the contract to handler authors.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from eidan_backend.behaviours import BehaviourResult, TriggerEvent


@dataclass
class _State:
    """Per-process scratch state for the test handler.

    Phase 1.5 has no real persistence story for behaviour handlers;
    this exists only so the smoke test can read what the handler did.
    Production handlers would write to the plugin's own schema.
    """

    seen_keys: set[str] = field(default_factory=set)
    invocations: list[TriggerEvent] = field(default_factory=list)


state = _State()


async def tick(event: TriggerEvent) -> BehaviourResult:
    """Record one cron firing and short-circuit on a repeat key."""
    if event.idempotency_key in state.seen_keys:
        return BehaviourResult(ok=True, notes_for_model="duplicate; skipped")
    state.seen_keys.add(event.idempotency_key)
    state.invocations.append(event)
    return BehaviourResult(ok=True, notes_for_model="tick")


def reset() -> None:
    """Drop accumulated state. Tests call this between runs."""
    state.seen_keys.clear()
    state.invocations.clear()


__all__ = ["reset", "state", "tick"]
