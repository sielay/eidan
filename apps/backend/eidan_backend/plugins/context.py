"""Plugin runtime context — `docs/001 §2.2`.

The :class:`PluginContext` is the *only* sanctioned interface a
plugin uses to interact with the host. Phase 4 lands the shape; the
loader (separate issue) will construct one per plugin at activation
time and pass it into ``on_activate`` / ``on_deactivate`` / etc.

Phase 4 intentionally types ``db`` and ``secret`` against narrow
``Protocol``\\s rather than wiring them to the concrete asyncpg pool
and the (still-future) Vault client. That keeps the contract
exercised by :class:`PluginBase` subclasses stable while the loader
and the secrets backend (``docs/012``) take shape behind it.
"""

from __future__ import annotations

from collections.abc import Iterable
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, Protocol, runtime_checkable

if TYPE_CHECKING:
    from fastapi import APIRouter

    from eidan_backend.behaviours import Behaviour, BehaviourResult
    from eidan_backend.capabilities import JobCapability
    from eidan_backend.identity import Identity
    from eidan_backend.tools import Tool


@runtime_checkable
class SecretAccessor(Protocol):
    """Vault accessor handed to a plugin via ``ctx.secret``.

    Phase 4 stubs the surface; the full Vault wiring lands in
    ``docs/012``. Calls to keys the manifest did not declare will
    raise :class:`UndeclaredAccessError` once the loader enforces
    that — for now an implementation MAY return ``None`` for
    unknown keys.
    """

    async def __call__(self, key: str) -> str | None: ...


@runtime_checkable
class DbAccessor(Protocol):
    """Connection accessor scoped to ``plugin_<name_underscored>``.

    Calling :meth:`acquire` borrows a connection from the host pool
    with ``search_path`` set so the plugin's private schema is
    resolved by default. The concrete object is whatever the loader
    wires in; tests substitute a fake.
    """

    def acquire(self, *args: Any, **kwargs: Any) -> Any: ...


@runtime_checkable
class RouterRegistrar(Protocol):
    """Callable that mounts a FastAPI router under the manifest's
    ``backend.routes_prefix``."""

    def __call__(self, router: APIRouter) -> None: ...


@runtime_checkable
class BehaviourRegistrar(Protocol):
    """Callable that registers an iterable of :class:`Behaviour` with
    the host's behaviour registry."""

    def __call__(self, behaviours: Iterable[Behaviour]) -> None: ...


@runtime_checkable
class ToolRegistrar(Protocol):
    """Callable that registers an iterable of :class:`Tool` with the
    host's tool registry — the same one the agent loop's primary call
    sees as ``tools=`` (`docs/001 §3` agent tools).

    Plugins call this from ``on_activate`` to contribute tool surface.
    The host's bootstrap wires this to the live
    :class:`eidan_backend.tools.ToolRegistry`. Tests substitute a
    in-memory recorder.
    """

    def __call__(self, tools: Iterable[Tool]) -> None: ...


@runtime_checkable
class CapabilityRegistrar(Protocol):
    """Callable that registers the job **kinds** this node serves with the
    host's :class:`eidan_backend.capabilities.CapabilityRegistry`.

    Plugins call this from ``on_activate`` to advertise ``{kind, capacity}``
    — what work this node can claim from ``eidan.jobs`` (#247). The host
    snapshots the registry after activation and the heartbeat loop writes it
    into ``eidan.node_heartbeats.served_kinds`` (#249). ``None`` on a context
    wired without the registry (older host / unit-test path); plugins guard
    with ``if ctx.register_capabilities is not None``.
    """

    def __call__(self, capabilities: Iterable[JobCapability]) -> None: ...


@runtime_checkable
class TurnInitiator(Protocol):
    """Spawn a fresh agentic turn from a plugin context.

    The host pre-binds the pool, provider, model, and tool registry
    at bootstrap time; plugins supply only the user, the prompt the
    synthetic agent should think about, and an optional conversation
    id to land the turn under (defaults to a fresh
    ``"[<agent_name>] tick"`` conversation).

    Returns an async iterator over the same ``AssistantChunk`` /
    ``TurnComplete`` events the user-facing loop emits, so callers
    that want to inspect the model's reply can iterate it; callers
    that don't can drain it with ``async for _ in spawn_turn(...): pass``.

    ``None`` when the bootstrap was wired without a provider (the
    unit-test path, or a degraded "no LLM credentials" boot). Plugins
    that want to fall back gracefully check ``if ctx.spawn_turn is
    None`` and write an escalation instead.
    """

    def __call__(
        self,
        *,
        user_id: Any,
        agent_name: str,
        prompt_text: str,
        conversation_id: Any | None = None,
        conversation_title: str | None = None,
    ) -> Any: ...


@runtime_checkable
class SufficiencyAssessor(Protocol):
    """The loop-level second-voice critic (#186 / `docs/027 §5`).

    Given a goal and what an autonomous loop has gathered, returns a
    ``SufficiencyVerdict`` (``await``) — whether there's enough to
    conclude. The host pre-binds the provider + model; plugins supply
    only ``goal`` + ``gathered``. ``None`` when no provider is wired, so
    a consumer falls back to the investigator's own ``[DONE]`` signal via
    ``if ctx.assess_sufficiency is None``.
    """

    def __call__(self, *, goal: str, gathered: str) -> Any: ...


@runtime_checkable
class EventPublisher(Protocol):
    """In-process event-bus publish accessor handed to a plugin via
    ``ctx.publish_event``.

    Plugins call ``await ctx.publish_event(name, payload)`` to emit on
    the same event bus they already subscribe to via the manifest's
    ``behaviours[]`` (`docs/006 §4`). The host generates the
    idempotency key, fans out to every behaviour whose trigger matches
    ``event:<name>``, and returns the per-subscriber
    :class:`BehaviourResult`s in registration order. A subscriber
    whose key has already fired (host-side dedupe) does not appear in
    the list.

    ``__idempotency_key__`` on ``payload`` is a reserved field: when
    present it overrides the host-generated key and is stripped from
    the payload before subscribers see it. Use it deliberately when
    re-publishing on retry should collapse to the original dispatch;
    otherwise avoid the field name so an accidental collision doesn't
    silently drop data.

    ``None`` when the host wires a context without a behaviour
    dispatcher (e.g. during deactivate or in unit tests); plugins that want to
    fall back gracefully check ``if ctx.publish_event is None``.
    """

    async def __call__(
        self,
        name: str,
        payload: dict | None = None,
    ) -> list[BehaviourResult]: ...


@runtime_checkable
class NotificationSender(Protocol):
    """Out-of-band nudge accessor handed to a plugin via
    ``ctx.notify``.

    Plugins call ``await ctx.notify(channel, text)`` to push a
    message to the operator over a configured channel (Telegram
    first, email / Slack to follow). Channel adapters are registered
    host-side at bootstrap; plugins consume them by name. A channel
    that isn't configured raises ``NotificationError`` so the caller
    can route a follow-up escalation rather than silently swallowing
    the nudge.
    """

    async def __call__(
        self,
        channel: str,
        text: str,
        *,
        user_id: Any | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> Any: ...


@runtime_checkable
class TopicNotifier(Protocol):
    """Topic-routed notification accessor handed to a plugin via
    ``ctx.notify_topic``.

    Plugins call ``await ctx.notify_topic(topic, text, severity=...)`` to
    emit a *topic* (``"sentry"``, ``"job.update"``, …); the operator's
    per-node routes (``EIDAN_NOTIFY_ROUTES``) decide which channel +
    destination it lands on. A topic with no route is a silent no-op, and
    a delivery failure is logged rather than raised — so the caller never
    has to branch on routing. ``None`` when no notification router is
    wired (the unit-test / degraded path).
    """

    async def __call__(
        self,
        topic: str,
        text: str,
        *,
        severity: str = "info",
        user_id: Any | None = None,
    ) -> Any: ...


@runtime_checkable
class ArtifactCreator(Protocol):
    """Create a downloadable artifact from a plugin tool (#252).

    A tool that produces *bytes* (a rendered deck, a PDF, an export) calls
    ``await ctx.artifacts.create(...)``; the host writes a user-scoped
    ``eidan.artifacts`` row, stores the bytes in the configured backend
    (Postgres bytea / S3 / R2 / MinIO), and returns a ref carrying a
    ``download_url`` to surface as a download chip. The host resolves the
    calling :class:`Identity` from the ambient turn context, so plugins
    never pass it — and ``create()`` raises if invoked with no active
    identity (i.e. outside a turn), rather than returning ``None``.

    The bootstrap context factory **always** wires this accessor, so plugin
    tool code does not need an ``if ctx.artifacts is not None`` guard. The
    field is typed ``| None`` only for the degraded path where a
    :class:`PluginContext` is constructed directly without an artifact
    service (some unit tests); real installs always have it.
    """

    async def create(
        self,
        *,
        kind: str,
        filename: str,
        data: bytes,
        mime_type: str,
        message_id: Any | None = None,
        conversation_id: Any | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> Any: ...


@dataclass(frozen=True, slots=True)
class PluginContext:
    """The host surface a :class:`PluginBase` subclass receives.

    Fields:

    - ``name``                — the manifest ``name``.
    - ``db``                  — connection accessor scoped to
      ``plugin_<name_underscored>``.
    - ``secret``              — vault accessor.
    - ``notify``              — out-of-band notification surface
      (Telegram first, more to follow). ``None`` when no channel
      adapter is registered; in that case plugins fall back to
      writing escalations.
    - ``notify_topic``        — topic-routed notification: emit a topic
      (``"sentry"``, ``"job.update"``, …) and the operator's per-node
      ``EIDAN_NOTIFY_ROUTES`` decides the channel + destination. Unrouted
      topic → silent no-op. ``None`` when no router is wired.
    - ``spawn_turn``          — agent-initiated turn primitive: a
      plugin (Sentry tick, cron behaviour) calls it to ask the
      configured provider "here's a prompt, think about it" without
      an inbound user JWT. ``None`` when no provider is wired
      (test boots, degraded starts); plugins fall back to writing
      escalations.
    - ``publish_event``       — emit on the in-process event bus so
      every subscribed behaviour fires (`docs/006 §4`). The host
      generates the idempotency key and runs the standard
      per-subscriber dedupe / audit path. ``None`` when the bootstrap
      ran without a behaviour dispatcher (the unit-test path).
    - ``register_router``     — mounts a FastAPI router under the
      manifest's ``routes_prefix``.
    - ``register_behaviours`` — registers the plugin's
      :class:`Behaviour` instances with the host.
    - ``register_tools``      — registers the plugin's :class:`Tool`
      instances with the host's tool registry, so the agent loop's
      primary call sees them in its ``tools=`` surface.
    - ``register_capabilities`` — advertises the job ``kind``\\s this node
      serves (``{kind, capacity}``) so the heartbeat publishes them into
      ``node_heartbeats.served_kinds`` (#249). ``None`` on an older host /
      the unit-test path; plugins guard before calling.
    - ``identity``            — ``None`` during ``on_install`` /
      ``on_uninstall``; the calling :class:`Identity` during
      ``on_activate`` and runtime invocations.
    """

    name: str
    db: DbAccessor
    secret: SecretAccessor
    register_router: RouterRegistrar
    register_behaviours: BehaviourRegistrar
    register_tools: ToolRegistrar
    notify: NotificationSender | None = None
    notify_topic: TopicNotifier | None = None
    spawn_turn: TurnInitiator | None = None
    assess_sufficiency: SufficiencyAssessor | None = None
    publish_event: EventPublisher | None = None
    register_capabilities: CapabilityRegistrar | None = None
    artifacts: ArtifactCreator | None = None
    identity: Identity | None = None


__all__ = [
    "ArtifactCreator",
    "BehaviourRegistrar",
    "CapabilityRegistrar",
    "DbAccessor",
    "EventPublisher",
    "NotificationSender",
    "TopicNotifier",
    "SufficiencyAssessor",
    "PluginContext",
    "RouterRegistrar",
    "SecretAccessor",
    "ToolRegistrar",
    "TurnInitiator",
]
