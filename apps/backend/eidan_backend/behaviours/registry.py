"""In-process behaviour registry — `docs/001 §5`, `docs/006 §4`.

The registry is the catalogue a plugin populates from
``on_activate(ctx)``. It owns:

- the ``id -> Behaviour`` map a dispatcher walks at trigger time
- the per-process idempotency gate over ``(behaviour_id,
  idempotency_key)`` pairs

Phase 1.5 keeps the surface deliberately small. There is no
``for_agent`` filter (`docs/006 §4.2`) yet because there is no
classifier; there is no per-turn snapshot (`docs/006 §4.4`) yet
because nothing in the agentic loop reads behaviours during a turn.
What lands here is what the dispatch path actually needs.

Idempotency: the host guarantees at-least-once delivery
(`docs/001 §5.2`). When a trigger fires the dispatcher calls
:meth:`BehaviourRegistry.dispatch` with a fresh
``idempotency_key``; a repeat call with the same ``(behaviour_id,
key)`` pair returns ``None`` without invoking the handler. The
window is process-local — multi-instance dedupe (leader election,
`docs/004 multi-instance`) is Phase 3 / 4.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable, Iterable
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Literal

from .context import BehaviourContext
from .triggers import Trigger

if TYPE_CHECKING:
    from ..tools import ToolRegistry

#: Dispatch shape declared per behaviour. See `docs/026`. ``llm_turn``
#: is the default and matches today's host behaviour (run the handler,
#: it may call `spawn_turn` internally for the full agentic loop). The
#: other three are operator hints today and grow host-side ctx-shaping
#: in follow-up slices (#161 ships the field; slice 2 adds per-kind
#: ctx and validates that a handler's runtime shape matches its
#: declared kind).
BehaviourKind = Literal["llm_turn", "tool_chain", "classifier_gate", "notify"]
BEHAVIOUR_KINDS: tuple[BehaviourKind, ...] = (
    "llm_turn",
    "tool_chain",
    "classifier_gate",
    "notify",
)


class BehaviourIdConflict(Exception):
    """Raised when two behaviours register with the same ``id``.

    Mirrors the route-collision rule in `docs/001 §3.3` and the
    behaviour-collision rule in `docs/006 §2.3`.
    """


class BehaviourNotFound(KeyError):
    """Raised when the dispatcher targets an unregistered behaviour."""


@dataclass(frozen=True, slots=True)
class TriggerEvent:
    """Payload handed to a handler when a trigger fires.

    Mirrors the shape pinned in `docs/001 §5.2`. ``payload`` carries
    kind-specific data (the bus event body for ``event:``; empty for
    ``cron:``); ``idempotency_key`` is generated per-dispatch by the
    host and is what the handler keys on to be a no-op on retries.
    """

    trigger: Trigger
    idempotency_key: str
    payload: dict = field(default_factory=dict)


@dataclass(frozen=True, slots=True)
class BehaviourResult:
    """What a handler returns.

    Phase 1.5 ships the subset of `docs/006 §2.2` the dispatcher
    actually consumes. ``follow_up_events`` are republished by the
    dispatcher onto the in-process bus so a behaviour can chain.
    """

    ok: bool = True
    notes_for_model: str | None = None
    follow_up_events: tuple[dict, ...] = ()
    error: str | None = None


HandlerFn = Callable[..., Awaitable[BehaviourResult | None]]


@dataclass(frozen=True, slots=True)
class Behaviour:
    """Registered behaviour: id, trigger, callable, dispatch kind.

    ``id`` is globally unique and plugin-prefixed
    (``"example-behaviour:tick"``); the registry refuses a second
    registration under the same id (:class:`BehaviourIdConflict`).
    The full `Behaviour` dataclass in `docs/006 §2.1` adds mode,
    prompt stanza, tools, and priority — those land alongside the
    classifier in the follow-up issue.

    ``kind`` declares the dispatch shape per `docs/026`. Defaults to
    ``"llm_turn"`` so existing plugins are unaffected. The host does
    not branch on the kind yet — slice 1 (#161) ships the field as
    metadata; slice 2 builds the per-kind ``ctx``.
    """

    id: str
    trigger: Trigger
    handler: HandlerFn = field(repr=False)
    kind: BehaviourKind = "llm_turn"

    def __post_init__(self) -> None:
        if self.kind not in BEHAVIOUR_KINDS:
            raise ValueError(
                f"behaviour {self.id!r}: unknown kind {self.kind!r}; "
                f"expected one of {BEHAVIOUR_KINDS}"
            )


class BehaviourRegistry:
    """In-process behaviour catalogue.

    Read-mostly: writes happen at plugin activation, reads happen at
    trigger time. The map is keyed by ``id``; the dispatcher walks
    the values to find subscribers for a given trigger kind / spec.

    Slice 3 addition: routes handlers based on their declared `kind`,
    providing appropriate context (tools, classifier) per kind.
    """

    def __init__(self, tool_registry: ToolRegistry | None = None) -> None:
        self._behaviours: dict[str, Behaviour] = {}
        self._seen_keys: set[tuple[str, str]] = set()
        self._tool_registry = tool_registry

    def register(self, behaviour: Behaviour) -> None:
        if behaviour.id in self._behaviours:
            raise BehaviourIdConflict(behaviour.id)
        self._behaviours[behaviour.id] = behaviour

    def register_all(self, behaviours: Iterable[Behaviour]) -> None:
        # Two-pass so a conflict in the middle of the iterable leaves
        # the registry unchanged. Matches `docs/001 §3.3`'s
        # "rejected, not partially loaded" posture for manifests.
        new = list(behaviours)
        conflicts = [b.id for b in new if b.id in self._behaviours]
        if conflicts:
            raise BehaviourIdConflict(conflicts[0])
        seen_in_batch: set[str] = set()
        for b in new:
            if b.id in seen_in_batch:
                raise BehaviourIdConflict(b.id)
            seen_in_batch.add(b.id)
        for b in new:
            self._behaviours[b.id] = b

    def unregister(self, behaviour_id: str) -> None:
        self._behaviours.pop(behaviour_id, None)
        # Idempotency state is intentionally NOT cleared on
        # unregister — re-registering a behaviour under the same id
        # should not let a previously-seen idempotency key fire again.
        # If that ever becomes a problem in practice we'll revisit;
        # see `docs/001 §5.2`.

    def get(self, behaviour_id: str) -> Behaviour | None:
        return self._behaviours.get(behaviour_id)

    def all(self) -> tuple[Behaviour, ...]:
        return tuple(self._behaviours.values())

    def by_trigger_kind(self, kind: str) -> tuple[Behaviour, ...]:
        return tuple(
            b for b in self._behaviours.values() if b.trigger.kind == kind
        )

    def subscribers(self, kind: str, spec: str) -> tuple[Behaviour, ...]:
        return tuple(
            b
            for b in self._behaviours.values()
            if b.trigger.kind == kind and b.trigger.spec == spec
        )

    async def dispatch(
        self,
        behaviour_id: str,
        *,
        idempotency_key: str,
        payload: dict | None = None,
    ) -> BehaviourResult | None:
        """Invoke the named behaviour.

        Returns ``None`` when the ``(behaviour_id, idempotency_key)``
        pair has already been dispatched in this process; otherwise
        runs the handler and returns its result based on its declared
        `kind`. The key is recorded *before* the handler runs so two
        concurrent dispatches with the same key collapse to one invocation.

        Dispatch routing (slice 3 — docs/026 §4):
        - `llm_turn`: Handler called with TriggerEvent only
        - `tool_chain`: Handler called with TriggerEvent + BehaviourContext(tools)
        - `classifier_gate`: Handler called with TriggerEvent + BehaviourContext(tools, classify)
        - `notify`: Handler NOT called; event written directly to node_events
        """
        if (behaviour_id, idempotency_key) in self._seen_keys:
            return None
        beh = self._behaviours.get(behaviour_id)
        if beh is None:
            raise BehaviourNotFound(behaviour_id)
        self._seen_keys.add((behaviour_id, idempotency_key))
        event = TriggerEvent(
            trigger=beh.trigger,
            idempotency_key=idempotency_key,
            payload=dict(payload) if payload else {},
        )

        if beh.kind == "llm_turn":
            # Current path: handler calls spawn_turn internally
            return await beh.handler(event)

        if beh.kind == "tool_chain":
            # Handler gets tools, deterministic orchestration
            ctx = BehaviourContext(tools=self._tool_registry)
            return await beh.handler(event, ctx)

        if beh.kind == "classifier_gate":
            # Handler gets tools + classifier for branching
            ctx = BehaviourContext(
                tools=self._tool_registry,
                classify=None,  # TODO: wire classify helper from bootstrap
            )
            return await beh.handler(event, ctx)

        if beh.kind == "notify":
            # No handler call; write event directly
            # TODO: implement node_events write
            return BehaviourResult(ok=True)

        raise ValueError(f"unknown behaviour kind: {beh.kind!r}")


__all__ = [
    "Behaviour",
    "BehaviourContext",
    "BehaviourIdConflict",
    "BehaviourNotFound",
    "BehaviourRegistry",
    "BehaviourResult",
    "HandlerFn",
    "TriggerEvent",
]
