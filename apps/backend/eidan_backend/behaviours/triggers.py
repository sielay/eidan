"""Trigger grammar from `docs/001 §5.1`.

A trigger is the activation entry-point attached to a behaviour. The
grammar is a colon-prefixed string in the manifest (``cron:0 7 * * *``);
in-process it round-trips through a :class:`Trigger` dataclass so the
loader and the dispatcher can pattern-match on ``kind`` without
re-parsing.

Phase 1.5 implements dispatch for ``event:`` and ``cron:``. The other
three kinds parse cleanly so a plugin manifest can mention them, but
the dispatcher raises :class:`NotImplementedError` when asked to wire
them up — see :mod:`eidan_backend.behaviours.dispatch`.
"""

from __future__ import annotations

from dataclasses import dataclass

# Mirrors the grammar pinned in `docs/001 §5.1` plus the `intent:` kind
# added by `docs/006 §1`. The dispatcher only wires `event:` and `cron:`
# in Phase 1.5; the rest are accepted at parse time so plugin manifests
# do not fail validation before their dispatch path lands.
_KNOWN_KINDS: frozenset[str] = frozenset(
    {"event", "cron", "webhook", "schedule", "agent", "intent"}
)


@dataclass(frozen=True, slots=True)
class Trigger:
    """One activation entry-point attached to a behaviour.

    ``kind`` is the discriminator (`event` / `cron` / `webhook` /
    `schedule` / `agent` / `intent`); ``spec`` is the kind-specific
    payload as it appeared after the colon in the manifest.
    """

    kind: str
    spec: str

    def __str__(self) -> str:
        return f"{self.kind}:{self.spec}"


def parse_trigger(raw: str) -> Trigger:
    """Parse ``"event:notes.created"`` → ``Trigger(kind="event", spec="notes.created")``.

    Whitespace around the kind and inside the spec is preserved — cron
    expressions are space-separated and trimming them would silently
    corrupt the schedule.
    """
    if not isinstance(raw, str):
        raise TypeError(f"trigger must be a string, got {type(raw).__name__}")

    kind, sep, spec = raw.partition(":")
    if not sep:
        raise ValueError(
            f"trigger missing kind prefix (expected '<kind>:<spec>'): {raw!r}"
        )
    kind = kind.strip()
    if kind not in _KNOWN_KINDS:
        raise ValueError(
            f"unknown trigger kind {kind!r}; "
            f"valid kinds: {sorted(_KNOWN_KINDS)}"
        )
    if not spec:
        raise ValueError(f"trigger spec is empty: {raw!r}")
    return Trigger(kind=kind, spec=spec)


__all__ = ["Trigger", "parse_trigger"]
