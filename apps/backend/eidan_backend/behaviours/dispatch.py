"""Trigger dispatch — `docs/001 §5`, `docs/006 §4`.

Phase 1 wires four trigger kinds end to end:

- ``event:<name>`` — an in-process pub/sub bus. Anything inside the
  backend can call :meth:`BehaviourDispatcher.publish_event`; every
  behaviour whose trigger matches the event name fires once.
- ``cron:<expr>`` — backed by APScheduler running inside the backend
  process. `docs/004` calls for leader election so cron fires once
  across a multi-instance deployment; Phase 1 ships without it and
  relies on the handler being idempotent on
  ``trigger.idempotency_key`` (`docs/001 §5.2`).
- ``schedule:<iso-8601-duration>`` — APScheduler ``IntervalTrigger``
  installed on dispatcher start. Supports the day/hour/minute/second
  subset of ISO-8601 (``PT15M``, ``P1D``, ``PT1H30M``). Years/months
  are rejected as ambiguous.
- ``webhook:<slug>`` — registry-driven; the HTTP route
  ``POST /api/webhooks/<plugin>/<slug>`` resolves subscribers via
  :meth:`BehaviourDispatcher.publish_webhook`.

The last kind, ``agent:<tool-name>``, parses cleanly through
:func:`parse_trigger` so plugin manifests do not fail validation, but
asking the dispatcher to wire one up raises :class:`NotImplementedError`
— it lands alongside the behaviour-classifier (`docs/006 §6.2`).
"""

from __future__ import annotations

import re
import uuid
import zlib
from collections.abc import Iterable
from datetime import UTC, datetime
from typing import TYPE_CHECKING

from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.triggers.cron import CronTrigger
from apscheduler.triggers.interval import IntervalTrigger

from ..persistence import record_behaviour_dlq_entry
from .registry import Behaviour, BehaviourRegistry, BehaviourResult

if TYPE_CHECKING:
    import asyncpg

# Top-half of the int8 keyspace reserved for cross-instance lock keys
# from this dispatcher. Mixing app-level locks with the rest of
# Postgres advisory-lock usage in eidan would risk collision; the
# constant prefix keeps the lock namespace isolated. Chosen
# deliberately as a fixed positive 32-bit integer.
_LOCK_KEY_PREFIX = 0x49445350  # 'IDSP' — Issue Dispatch SubPrefix


def _lock_key_for(behaviour_id: str, slot: str) -> tuple[int, int]:
    """Derive a stable ``(key1, key2)`` int4 pair for
    ``pg_try_advisory_xact_lock(int4, int4)``.

    Postgres advisory locks come in two flavours: single-bigint and
    paired-int4. The two-int4 form gives a roomy namespace (prefix
    + per-behaviour hash) without committing to a single global
    keyspace. The slot string lets us key per cron-minute or per
    schedule-uuid so the lock is held *only* during the firing
    moment.
    """
    digest = zlib.crc32(f"{behaviour_id}|{slot}".encode())
    return (_LOCK_KEY_PREFIX, int(digest))

_DEFERRED_KINDS: dict[str, str] = {
    "agent": (
        "agent: triggers are not implemented in Phase 1; the tool-name "
        "registration path lands alongside the behaviour-classifier (see "
        "docs/006 §6.2)"
    ),
}

# Day/hour/minute/second subset of ISO-8601 durations. Years and months
# are deliberately rejected because their length depends on the anchor
# date — APScheduler's IntervalTrigger expects a fixed timedelta.
_ISO8601_DURATION = re.compile(
    r"^P(?:(?P<days>\d+)D)?"
    r"(?:T(?:(?P<hours>\d+)H)?"
    r"(?:(?P<minutes>\d+)M)?"
    r"(?:(?P<seconds>\d+)S)?)?$"
)


def _parse_iso8601_duration(spec: str) -> dict[str, int]:
    """Parse ``PT15M``/``P1D``/``PT1H30M`` into kwargs for
    ``IntervalTrigger``.

    Returns a dict of ``days``/``hours``/``minutes``/``seconds`` with
    only the fields present in the input — the caller can pass them
    straight through. Raises :class:`ValueError` on years/months or on
    any input that does not match the supported subset.
    """
    if "Y" in spec or (spec.startswith("P") and "M" in spec.split("T", 1)[0]):
        raise ValueError(
            f"schedule duration {spec!r} uses years or months, which are "
            "ambiguous without an anchor date; use days/hours/minutes/seconds"
        )
    match = _ISO8601_DURATION.match(spec)
    if match is None:
        raise ValueError(
            f"schedule duration {spec!r} is not an ISO-8601 duration in the "
            "supported subset (e.g. PT15M, P1D, PT1H30M)"
        )
    fields = {k: int(v) for k, v in match.groupdict().items() if v is not None}
    if not fields or all(v == 0 for v in fields.values()):
        raise ValueError(
            f"schedule duration {spec!r} resolves to zero — at least one of "
            "days/hours/minutes/seconds must be non-zero"
        )
    return fields


class BehaviourDispatcher:
    """Bridges triggers to handler invocations.

    Holds a reference to a :class:`BehaviourRegistry` and an
    :class:`AsyncIOScheduler`. The scheduler is injected in tests; in
    production the dispatcher owns its own and shuts it down on
    :meth:`shutdown`.

    Lifecycle:

    1. Construct with a registry (populated already or empty).
    2. Call :meth:`start` once the backend's event loop is running —
       this snapshots the registry's cron behaviours into APScheduler
       jobs and starts the scheduler.
    3. Call :meth:`publish_event` from anywhere in the backend for
       ``event:`` dispatch.
    4. Call :meth:`shutdown` at host shutdown.

    Behaviours registered AFTER :meth:`start` need to be scheduled
    explicitly via :meth:`schedule_behaviour` — cron jobs are not
    auto-added on registration because the registry is process-wide
    and ignorant of the dispatcher.
    """

    def __init__(
        self,
        registry: BehaviourRegistry,
        *,
        scheduler: AsyncIOScheduler | None = None,
        pool: asyncpg.Pool | None = None,
    ) -> None:
        self._registry = registry
        self._scheduler = scheduler if scheduler is not None else AsyncIOScheduler()
        self._owns_scheduler = scheduler is None
        self._cron_job_ids: dict[str, str] = {}
        # Optional asyncpg pool used for cross-instance leader election
        # (`docs/021`). When set, the scheduler wraps each cron /
        # schedule firing in a ``pg_try_advisory_xact_lock`` so only one
        # instance fires the behaviour for a given minute / interval
        # slot. ``None`` keeps the Phase-1 single-instance posture —
        # the registry's in-process dedupe still protects against
        # accidental double-dispatch within one process.
        self._pool = pool

    @property
    def scheduler(self) -> AsyncIOScheduler:
        return self._scheduler

    # ---- start / shutdown -------------------------------------------------

    def start(self) -> None:
        """Schedule cron + schedule behaviours present in the registry
        and start the underlying APScheduler. Idempotent — calling twice
        does not reschedule the same job."""
        for beh in self._registry.by_trigger_kind("cron"):
            self.schedule_behaviour(beh)
        for beh in self._registry.by_trigger_kind("schedule"):
            self.schedule_behaviour(beh)
        if not self._scheduler.running:
            self._scheduler.start()

    def shutdown(self) -> None:
        """Stop the scheduler without waiting for in-flight jobs."""
        if self._owns_scheduler and self._scheduler.running:
            self._scheduler.shutdown(wait=False)

    # ---- per-trigger wiring ----------------------------------------------

    def schedule_behaviour(self, behaviour: Behaviour) -> None:
        """Wire a single behaviour into its trigger path.

        Cron and schedule behaviours become APScheduler jobs. Event
        and webhook behaviours are a no-op here — the dispatcher walks
        the registry per publish/POST. The remaining deferred kinds
        raise :class:`NotImplementedError`.
        """
        kind = behaviour.trigger.kind
        if kind == "cron":
            self._schedule_cron(behaviour)
            return
        if kind == "schedule":
            self._schedule_interval(behaviour)
            return
        if kind == "event":
            # The bus is registry-driven; nothing to install per-behaviour.
            return
        if kind == "webhook":
            # The HTTP router is registry-driven; the route handler
            # looks up subscribers via :meth:`publish_webhook` per POST.
            return
        if kind == "intent":
            # `intent:` is the classifier-matched kind from docs/006 — the
            # primary loop pulls intent behaviours at turn time, not here.
            return
        if kind in _DEFERRED_KINDS:
            raise NotImplementedError(_DEFERRED_KINDS[kind])
        raise ValueError(f"unknown trigger kind: {kind!r}")

    def schedule_all(self, behaviours: Iterable[Behaviour]) -> None:
        for b in behaviours:
            self.schedule_behaviour(b)

    def unschedule_behaviour(self, behaviour_id: str) -> None:
        job_id = self._cron_job_ids.pop(behaviour_id, None)
        if job_id is not None and self._scheduler.get_job(job_id) is not None:
            self._scheduler.remove_job(job_id)

    def _schedule_cron(self, behaviour: Behaviour) -> None:
        trigger = CronTrigger.from_crontab(behaviour.trigger.spec)
        job_id = f"behaviour:{behaviour.id}"
        # `replace_existing=True` keeps :meth:`start` idempotent — a
        # second call rebinds the same job rather than raising.
        self._scheduler.add_job(
            self._fire_cron,
            trigger=trigger,
            args=[behaviour.id],
            id=job_id,
            replace_existing=True,
            misfire_grace_time=30,
            max_instances=1,
            coalesce=True,
        )
        self._cron_job_ids[behaviour.id] = job_id

    async def _fire_cron(self, behaviour_id: str) -> None:
        # One key per scheduled minute. APScheduler's coalesce + the
        # registry's dedupe set work together: even if a misfire
        # produces two firings for the same minute we only run the
        # handler once. When a pool is configured, an advisory-xact
        # lock keyed on (behaviour_id, minute) gates the firing
        # cross-instance — only one instance acquires the lock and
        # actually dispatches.
        now = datetime.now(UTC).strftime("%Y-%m-%dT%H:%M")
        key = f"cron:{behaviour_id}:{now}"
        await self._dispatch_under_lock(
            behaviour_id, key, slot=now, trigger_kind="cron"
        )

    async def _dispatch_under_lock(
        self,
        behaviour_id: str,
        idempotency_key: str,
        *,
        slot: str,
        trigger_kind: str,
    ) -> None:
        """Run :meth:`BehaviourRegistry.dispatch` inside a Postgres
        advisory lock keyed on ``(behaviour_id, slot)``.

        When no pool is configured (single-instance dev) the lock step
        is skipped and we dispatch directly. When the lock is held by
        another instance, the firing is a no-op — the other instance
        is doing the work; double-dispatch would violate the
        idempotency contract from `docs/021 §1`.

        Exceptions raised by the handler are swallowed so the
        scheduler stays alive (`docs/001 §5.3`), and — when a pool
        is configured — one row lands in ``eidan.behaviour_dlq`` so
        the operator can read "what failed when" without scraping
        logs.
        """
        if self._pool is None:
            try:
                await self._registry.dispatch(
                    behaviour_id, idempotency_key=idempotency_key
                )
            except Exception:  # noqa: BLE001 — keep the scheduler alive
                pass
            return

        key1, key2 = _lock_key_for(behaviour_id, slot)
        handler_exc: BaseException | None = None
        try:
            async with self._pool.acquire() as conn:
                async with conn.transaction():
                    acquired = await conn.fetchval(
                        "SELECT pg_try_advisory_xact_lock($1, $2)", key1, key2
                    )
                    if not acquired:
                        # Another instance is firing this slot.
                        return
                    try:
                        await self._registry.dispatch(
                            behaviour_id, idempotency_key=idempotency_key
                        )
                    except Exception as exc:  # noqa: BLE001 — DLQ then swallow
                        handler_exc = exc
        except Exception:  # noqa: BLE001 — keep the scheduler alive
            # Lock acquisition or transaction-boundary error. Nothing
            # to DLQ — we never got to the handler — and re-raising
            # would kill the scheduler.
            return

        if handler_exc is None:
            return

        # Handler failed inside the lock. The advisory-lock
        # transaction has already rolled back; open a fresh
        # connection for the DLQ write so we are not piggybacking on
        # the rolled-back txn.
        try:
            async with self._pool.acquire() as conn:
                await record_behaviour_dlq_entry(
                    conn,
                    behaviour_id=behaviour_id,
                    trigger_kind=trigger_kind,
                    idempotency_key=idempotency_key,
                    error=handler_exc,
                    metadata={"slot": slot},
                )
        except Exception:  # noqa: BLE001 — DLQ write itself failed; do not crash
            pass

    def _schedule_interval(self, behaviour: Behaviour) -> None:
        """Install an APScheduler ``IntervalTrigger`` for a ``schedule:``
        behaviour.

        Parses the ISO-8601 duration once at scheduling time and feeds
        the components into ``IntervalTrigger`` so APScheduler owns the
        next-fire calculation.
        """
        fields = _parse_iso8601_duration(behaviour.trigger.spec)
        trigger = IntervalTrigger(**fields)
        job_id = f"behaviour:{behaviour.id}"
        self._scheduler.add_job(
            self._fire_schedule,
            trigger=trigger,
            args=[behaviour.id],
            id=job_id,
            replace_existing=True,
            misfire_grace_time=30,
            max_instances=1,
            coalesce=True,
        )
        self._cron_job_ids[behaviour.id] = job_id

    async def _fire_schedule(self, behaviour_id: str) -> None:
        # Schedule firings have no calendar slot like cron does. We
        # quantise the wall clock to the nearest second and use that
        # as the lock slot, so two instances firing in the same
        # second collapse to one dispatch. The idempotency key still
        # carries a uuid so the registry's dedupe set sees a unique
        # entry within the instance that won the lock.
        now = datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%S")
        key = f"schedule:{behaviour_id}:{uuid.uuid4().hex}"
        await self._dispatch_under_lock(
            behaviour_id, key, slot=now, trigger_kind="schedule"
        )

    # ---- event publish ---------------------------------------------------

    async def publish_webhook(
        self,
        plugin: str,
        slug: str,
        payload: dict | None = None,
    ) -> list[BehaviourResult]:
        """Dispatch ``webhook:<slug>`` for the named plugin.

        The HTTP route ``POST /api/webhooks/<plugin>/<slug>`` calls
        this. Subscribers are filtered by trigger spec (``slug``) and
        by the plugin prefix on ``behaviour.id`` so a slug shared by
        two plugins still routes the body to the right handler.

        Returns the handler results in registration order; behaviours
        whose idempotency key has already fired do not appear in the
        list.
        """
        body = dict(payload) if payload else {}
        key = body.pop("__idempotency_key__", None) or uuid.uuid4().hex
        results: list[BehaviourResult] = []
        prefix = f"{plugin}:"
        for beh in self._registry.subscribers("webhook", slug):
            if not beh.id.startswith(prefix):
                continue
            sub_key = f"webhook:{plugin}:{slug}:{key}:{beh.id}"
            result = await self._registry.dispatch(
                beh.id, idempotency_key=sub_key, payload=body
            )
            if result is not None:
                results.append(result)
        return results

    async def publish_event(
        self,
        name: str,
        payload: dict | None = None,
    ) -> list[BehaviourResult]:
        """Dispatch ``event:<name>`` to every subscribed behaviour.

        One fresh ``idempotency_key`` per publish call: the host
        generates it (`docs/001 §5.2`) so handlers can de-dupe
        across retries. Returns the non-skipped handler results in
        registration order; a behaviour whose key has already fired
        does not appear in the list.
        """
        body = dict(payload) if payload else {}
        key = body.pop("__idempotency_key__", None) or uuid.uuid4().hex
        results: list[BehaviourResult] = []
        subscribers = self._registry.subscribers("event", name)
        for beh in subscribers:
            # Per-subscriber key: two subscribers to the same event
            # need distinct rows in the dedupe set, otherwise the
            # second subscriber would be silently skipped.
            sub_key = f"event:{name}:{key}:{beh.id}"
            result = await self._registry.dispatch(
                beh.id, idempotency_key=sub_key, payload=body
            )
            if result is not None:
                results.append(result)
        return results


def make_idempotency_key(prefix: str = "dispatch") -> str:
    """Helper for callers that fire a dispatch outside of the bus.

    The host owns key generation (`docs/001 §5.2`); this is the
    canonical way to produce one. The prefix is recorded in the key
    so a glance at logs reveals which dispatch path it came from.
    """
    return f"{prefix}:{uuid.uuid4().hex}"


__all__ = [
    "BehaviourDispatcher",
    "make_idempotency_key",
]
