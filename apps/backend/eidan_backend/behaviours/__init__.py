"""Behaviour subsystem — `docs/001 §5`, `docs/006`.

Phase 1.5 surface:

- :class:`Behaviour`, :class:`Trigger`, :class:`TriggerEvent`,
  :class:`BehaviourResult` — the in-process record shape.
- :class:`BehaviourRegistry` — the catalogue a plugin populates from
  ``on_activate(ctx)``.
- :class:`BehaviourDispatcher` — bridges triggers to handler
  invocations; wires ``event:`` and ``cron:`` (via APScheduler).
- :func:`parse_trigger` — manifest-string → :class:`Trigger`.

The classifier-driven ``intent:`` kind (`docs/006 §5`), the AUTO /
OFFER activation modes, and the priority + prompt-stanza fields all
land alongside the agentic-loop wiring in the follow-up issue. What's
here is the substrate they will plug into.
"""

from .dispatch import BehaviourDispatcher, make_idempotency_key
from .registry import (
    Behaviour,
    BehaviourIdConflict,
    BehaviourNotFound,
    BehaviourRegistry,
    BehaviourResult,
    HandlerFn,
    TriggerEvent,
)
from .triggers import Trigger, parse_trigger

__all__ = [
    "Behaviour",
    "BehaviourDispatcher",
    "BehaviourIdConflict",
    "BehaviourNotFound",
    "BehaviourRegistry",
    "BehaviourResult",
    "HandlerFn",
    "Trigger",
    "TriggerEvent",
    "make_idempotency_key",
    "parse_trigger",
]
