"""Behaviour loader + trigger dispatch tests (issue #32).

Covers the acceptance criteria from the issue:

- A test plugin (``plugins/example-behaviour/``) registers a
  ``cron: '* * * * *'`` behaviour and its handler fires within a
  minute of activation.
- Firing the same handler twice with the same ``idempotency_key`` is
  a no-op the second time.

Also covers the trigger-grammar coverage from `docs/001 §5.1`: the
five non-classifier kinds parse; the dispatcher wires up ``event:``
and ``cron:`` and raises :class:`NotImplementedError` for
``webhook:`` / ``schedule:`` / ``agent:``.
"""

from __future__ import annotations

import asyncio
import importlib.util
import sys
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from apscheduler.schedulers.asyncio import AsyncIOScheduler
from eidan_backend.behaviours import (
    BEHAVIOUR_KINDS,
    Behaviour,
    BehaviourDispatcher,
    BehaviourIdConflict,
    BehaviourRegistry,
    BehaviourResult,
    TriggerEvent,
    make_idempotency_key,
    parse_trigger,
)

# ---- helpers --------------------------------------------------------------

_REPO_ROOT = Path(__file__).resolve().parents[3]
_PLUGIN_DIR = _REPO_ROOT / "plugins" / "example-behaviour"


def _load_example_plugin():
    """Import the plugin from ``plugins/example-behaviour/`` as a
    top-level package without polluting the installed packages.

    Phase 1.5 has no manifest loader (`docs/001 §8`) so the smoke
    test bootstraps the plugin's Python package by hand. Once the
    loader lands the test will move to ``eidan plugins install``.
    """
    package = "example_behaviour"
    if package in sys.modules:
        return sys.modules[package]
    pkg_path = _PLUGIN_DIR / "example_behaviour"
    spec = importlib.util.spec_from_file_location(
        package,
        pkg_path / "__init__.py",
        submodule_search_locations=[str(pkg_path)],
    )
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[package] = module
    spec.loader.exec_module(module)
    # Eagerly populate the submodules the smoke test pokes at.
    from importlib import import_module

    import_module("example_behaviour.behaviours")
    import_module("example_behaviour.plugin")
    return module


# ---- trigger grammar ------------------------------------------------------


def test_parse_trigger_grammar() -> None:
    """Each kind from `docs/001 §5.1` parses, plus `intent:` from
    `docs/006 §3`."""
    cases = {
        "event:notes.created": ("event", "notes.created"),
        "cron:0 7 * * *": ("cron", "0 7 * * *"),
        "webhook:stripe": ("webhook", "stripe"),
        "schedule:PT15M": ("schedule", "PT15M"),
        "agent:notes.search": ("agent", "notes.search"),
        "intent:user asks about today's notes": (
            "intent",
            "user asks about today's notes",
        ),
    }
    for raw, (kind, spec) in cases.items():
        t = parse_trigger(raw)
        assert t.kind == kind
        assert t.spec == spec
        # Round-trips through __str__.
        assert str(t) == raw


def test_parse_trigger_rejects_unknown_kind() -> None:
    with pytest.raises(ValueError, match="unknown trigger kind"):
        parse_trigger("smoke:0 * * * *")


def test_parse_trigger_rejects_missing_colon() -> None:
    with pytest.raises(ValueError, match="missing kind prefix"):
        parse_trigger("just-a-string")


def test_parse_trigger_rejects_empty_spec() -> None:
    with pytest.raises(ValueError, match="empty"):
        parse_trigger("event:")


# ---- registry ------------------------------------------------------------


async def _noop_handler(event: TriggerEvent) -> BehaviourResult:
    return BehaviourResult(ok=True)


def test_registry_register_and_lookup() -> None:
    registry = BehaviourRegistry()
    beh = Behaviour(
        id="example-behaviour:tick",
        trigger=parse_trigger("cron:* * * * *"),
        handler=_noop_handler,
    )
    registry.register(beh)
    assert registry.get("example-behaviour:tick") is beh
    assert registry.all() == (beh,)
    assert registry.by_trigger_kind("cron") == (beh,)
    assert registry.by_trigger_kind("event") == ()
    assert registry.subscribers("cron", "* * * * *") == (beh,)


# ---- kind --------------------------------------------------------------


def test_behaviour_kind_defaults_to_llm_turn() -> None:
    """Existing plugins that build :class:`Behaviour` without
    passing ``kind`` keep today's behaviour: the host runs the
    handler and the handler may call ``spawn_turn`` itself. The
    default is `docs/026`'s ``llm_turn``."""
    beh = Behaviour(
        id="example:tick",
        trigger=parse_trigger("cron:* * * * *"),
        handler=_noop_handler,
    )
    assert beh.kind == "llm_turn"


@pytest.mark.parametrize("kind", BEHAVIOUR_KINDS)
def test_behaviour_kind_accepts_every_declared_value(kind: str) -> None:
    """Round-trip each declared kind through the dataclass to
    confirm it survives ``__post_init__`` validation. Keeps the
    Python contract aligned with the manifest enum in
    ``PluginManifest.schema.json``."""
    beh = Behaviour(
        id=f"example:{kind}",
        trigger=parse_trigger("event:x"),
        handler=_noop_handler,
        kind=kind,  # type: ignore[arg-type]
    )
    assert beh.kind == kind


def test_behaviour_kind_rejects_unknown_value() -> None:
    """A typo at construction time fails fast rather than
    propagating into the dispatcher, where the wrong ctx shape
    would be a confusing AttributeError later."""
    with pytest.raises(ValueError, match="unknown kind"):
        Behaviour(
            id="example:tick",
            trigger=parse_trigger("cron:* * * * *"),
            handler=_noop_handler,
            kind="garbage",  # type: ignore[arg-type]
        )


def test_registry_round_trips_kind_through_register_all() -> None:
    """Mixed-kind batch survives ``register_all`` and lookup —
    the registry doesn't drop the field on its way through."""
    registry = BehaviourRegistry()
    behaviours = [
        Behaviour(
            id="a",
            trigger=parse_trigger("event:x"),
            handler=_noop_handler,
            kind="tool_chain",
        ),
        Behaviour(
            id="b",
            trigger=parse_trigger("event:y"),
            handler=_noop_handler,
            kind="notify",
        ),
        Behaviour(
            id="c",
            trigger=parse_trigger("event:z"),
            handler=_noop_handler,
            # default kind — make sure it sticks
        ),
    ]
    registry.register_all(behaviours)
    assert registry.get("a").kind == "tool_chain"  # type: ignore[union-attr]
    assert registry.get("b").kind == "notify"  # type: ignore[union-attr]
    assert registry.get("c").kind == "llm_turn"  # type: ignore[union-attr]


def test_registry_id_conflict() -> None:
    registry = BehaviourRegistry()
    beh = Behaviour(
        id="dup",
        trigger=parse_trigger("event:x"),
        handler=_noop_handler,
    )
    registry.register(beh)
    with pytest.raises(BehaviourIdConflict):
        registry.register(beh)


def test_registry_register_all_is_atomic_on_conflict() -> None:
    """A conflict mid-batch leaves the registry unchanged (`docs/001
    §3.3` 'rejected, not partially loaded')."""
    registry = BehaviourRegistry()
    registry.register(
        Behaviour(id="a", trigger=parse_trigger("event:x"), handler=_noop_handler)
    )
    new_batch = [
        Behaviour(id="b", trigger=parse_trigger("event:y"), handler=_noop_handler),
        Behaviour(id="a", trigger=parse_trigger("event:z"), handler=_noop_handler),
    ]
    with pytest.raises(BehaviourIdConflict):
        registry.register_all(new_batch)
    # 'b' should NOT have been admitted.
    assert registry.get("b") is None
    assert {b.id for b in registry.all()} == {"a"}


@pytest.mark.asyncio
async def test_registry_dispatch_is_idempotent_on_key() -> None:
    """Acceptance criterion #2: the same key fires the handler once."""
    calls: list[TriggerEvent] = []

    async def handler(event: TriggerEvent) -> BehaviourResult:
        calls.append(event)
        return BehaviourResult(ok=True)

    registry = BehaviourRegistry()
    registry.register(
        Behaviour(
            id="idempotency-probe",
            trigger=parse_trigger("event:probe"),
            handler=handler,
        )
    )

    first = await registry.dispatch(
        "idempotency-probe", idempotency_key="k1", payload={"a": 1}
    )
    second = await registry.dispatch(
        "idempotency-probe", idempotency_key="k1", payload={"a": 1}
    )
    third = await registry.dispatch(
        "idempotency-probe", idempotency_key="k2", payload={"a": 1}
    )

    assert first is not None and first.ok
    assert second is None
    assert third is not None and third.ok
    assert len(calls) == 2
    assert [c.idempotency_key for c in calls] == ["k1", "k2"]


# ---- dispatcher: deferred kinds ------------------------------------------


def test_dispatcher_raises_for_deferred_kinds() -> None:
    """Phase 1 wires cron/event/schedule/webhook end to end; only the
    classifier-bound ``agent:`` kind remains deferred."""
    registry = BehaviourRegistry()
    scheduler = AsyncIOScheduler()
    dispatcher = BehaviourDispatcher(registry, scheduler=scheduler)
    beh = Behaviour(
        id="deferred:agent",
        trigger=parse_trigger("agent:notes.search"),
        handler=_noop_handler,
    )
    with pytest.raises(NotImplementedError):
        dispatcher.schedule_behaviour(beh)


# ---- dispatcher: schedule via APScheduler IntervalTrigger ----------------


@pytest.mark.asyncio
async def test_schedule_behaviour_schedules_interval_job() -> None:
    """A ``schedule:PT15M`` behaviour becomes an IntervalTrigger job.

    The test is async-marked because ``dispatcher.start()`` hands the
    scheduler a running event loop — same shape as the existing cron
    scheduling test.
    """
    from apscheduler.triggers.interval import IntervalTrigger

    registry = BehaviourRegistry()
    registry.register(
        Behaviour(
            id="example:every-15m",
            trigger=parse_trigger("schedule:PT15M"),
            handler=_noop_handler,
        )
    )
    scheduler = AsyncIOScheduler()
    dispatcher = BehaviourDispatcher(registry, scheduler=scheduler)
    try:
        dispatcher.start()
        job = scheduler.get_job("behaviour:example:every-15m")
        assert job is not None
        assert isinstance(job.trigger, IntervalTrigger)
        # IntervalTrigger stores the interval as a timedelta.
        assert job.trigger.interval == timedelta(minutes=15)
    finally:
        dispatcher.shutdown()


@pytest.mark.asyncio
async def test_schedule_behaviour_fires_handler_when_due() -> None:
    """Nudge the interval job to ~now and confirm the handler runs."""
    calls: list[TriggerEvent] = []

    async def handler(event: TriggerEvent) -> BehaviourResult:
        calls.append(event)
        return BehaviourResult(ok=True)

    registry = BehaviourRegistry()
    registry.register(
        Behaviour(
            id="example:every-hour",
            trigger=parse_trigger("schedule:PT1H"),
            handler=handler,
        )
    )
    scheduler = AsyncIOScheduler()
    dispatcher = BehaviourDispatcher(registry, scheduler=scheduler)
    try:
        dispatcher.start()
        scheduler.modify_job(
            "behaviour:example:every-hour",
            next_run_time=datetime.now(UTC) + timedelta(milliseconds=50),
        )
        for _ in range(50):
            if calls:
                break
            await asyncio.sleep(0.1)
        assert calls, "schedule handler did not fire after interval nudged to ~now"
        fired = calls[0]
        assert fired.trigger.kind == "schedule"
        assert fired.idempotency_key.startswith("schedule:example:every-hour:")
    finally:
        dispatcher.shutdown()


def test_schedule_rejects_unsupported_iso8601_units() -> None:
    """Years/months and malformed inputs are rejected at scheduling time."""
    registry = BehaviourRegistry()
    scheduler = AsyncIOScheduler()
    dispatcher = BehaviourDispatcher(registry, scheduler=scheduler)
    for bad in ("P1Y", "P1M", "P1Y2M", "not-a-duration", "P", "PT", "P0D"):
        registry = BehaviourRegistry()
        registry.register(
            Behaviour(
                id=f"bad:{bad}",
                trigger=parse_trigger(f"schedule:{bad}"),
                handler=_noop_handler,
            )
        )
        dispatcher = BehaviourDispatcher(registry, scheduler=AsyncIOScheduler())
        with pytest.raises(ValueError):
            dispatcher.schedule_behaviour(registry.get(f"bad:{bad}"))


# ---- dispatcher: webhook publish -----------------------------------------


@pytest.mark.asyncio
async def test_webhook_publish_routes_to_matching_plugin() -> None:
    """``publish_webhook(plugin, slug)`` filters by both the slug and
    the plugin prefix on the behaviour id, so two plugins can declare
    the same slug without colliding."""
    calls: list[tuple[str, TriggerEvent]] = []

    def make_handler(tag: str):
        async def handler(event: TriggerEvent) -> BehaviourResult:
            calls.append((tag, event))
            return BehaviourResult(ok=True)

        return handler

    registry = BehaviourRegistry()
    registry.register(
        Behaviour(
            id="plugin-a:on-incoming",
            trigger=parse_trigger("webhook:incoming"),
            handler=make_handler("a"),
        )
    )
    registry.register(
        Behaviour(
            id="plugin-b:on-incoming",
            trigger=parse_trigger("webhook:incoming"),
            handler=make_handler("b"),
        )
    )

    scheduler = AsyncIOScheduler()
    dispatcher = BehaviourDispatcher(registry, scheduler=scheduler)
    results = await dispatcher.publish_webhook(
        "plugin-a", "incoming", {"event": "hello"}
    )
    assert len(results) == 1
    assert [tag for tag, _ in calls] == ["a"]
    assert calls[0][1].payload == {"event": "hello"}


@pytest.mark.asyncio
async def test_webhook_route_dispatches_to_subscribers() -> None:
    """End-to-end: POST /api/webhooks/<plugin>/<slug> bypasses auth,
    decodes JSON, and calls the matching behaviour.

    Uses a hand-built FastAPI app so the test does not depend on the
    Postgres fixture — the webhook route itself reads only
    ``app.state.behaviour_dispatcher``.
    """
    import httpx
    from eidan_backend.http.auth import AuthMiddleware
    from eidan_backend.http.routes import router
    from fastapi import FastAPI

    calls: list[TriggerEvent] = []

    async def handler(event: TriggerEvent) -> BehaviourResult:
        calls.append(event)
        return BehaviourResult(ok=True)

    registry = BehaviourRegistry()
    registry.register(
        Behaviour(
            id="example:on-incoming",
            trigger=parse_trigger("webhook:incoming"),
            handler=handler,
        )
    )
    dispatcher = BehaviourDispatcher(registry, scheduler=AsyncIOScheduler())

    app = FastAPI()
    app.state.behaviour_dispatcher = dispatcher
    app.state.auth_public_pem = None  # not used on bypassed paths
    app.add_middleware(AuthMiddleware)
    app.include_router(router)

    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(
        transport=transport, base_url="http://testserver"
    ) as client:
        # No Authorization header — the path bypasses auth.
        resp = await client.post(
            "/api/webhooks/example/incoming",
            json={"event": "ping", "id": 7},
        )
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body == {"ok": True, "fired": 1}
        assert len(calls) == 1
        assert calls[0].payload == {"event": "ping", "id": 7}

        # Unknown slug → 404, not 401.
        resp = await client.post(
            "/api/webhooks/example/no-such-slug", json={}
        )
        assert resp.status_code == 404


@pytest.mark.asyncio
async def test_cross_instance_lock_skips_dispatch_when_held() -> None:
    """`docs/021`: when a pool is configured and ``pg_try_advisory_xact_lock``
    returns False (another instance has the lock), the dispatcher
    drops the firing without invoking the handler. The other
    instance's matching dispatch is what actually runs the work.
    """
    calls: list[TriggerEvent] = []

    async def handler(event: TriggerEvent) -> BehaviourResult:
        calls.append(event)
        return BehaviourResult(ok=True)

    registry = BehaviourRegistry()
    registry.register(
        Behaviour(
            id="example-behaviour:tick",
            trigger=parse_trigger("cron:* * * * *"),
            handler=handler,
        )
    )

    # Hand-rolled pool that always reports the advisory lock as held.
    class _LockedConn:
        async def fetchval(self, *args, **kwargs):
            return False

        def transaction(self):
            class _Ctx:
                async def __aenter__(self_inner):
                    return None

                async def __aexit__(self_inner, *exc):
                    return None

            return _Ctx()

    class _LockedAcquireCtx:
        async def __aenter__(self_inner):
            return _LockedConn()

        async def __aexit__(self_inner, *exc):
            return None

    class _LockedPool:
        def acquire(self_inner):
            return _LockedAcquireCtx()

    dispatcher = BehaviourDispatcher(
        registry,
        scheduler=AsyncIOScheduler(),
        pool=_LockedPool(),  # type: ignore[arg-type]
    )
    await dispatcher._dispatch_under_lock(
        "example-behaviour:tick",
        idempotency_key="cron:example-behaviour:tick:2026-05-19T00:00",
        slot="2026-05-19T00:00",
        trigger_kind="cron",
    )
    assert calls == []


@pytest.mark.asyncio
async def test_cross_instance_lock_dispatches_when_acquired() -> None:
    """Mirror of the previous test: the lock is granted, so the
    handler runs exactly once."""
    calls: list[TriggerEvent] = []

    async def handler(event: TriggerEvent) -> BehaviourResult:
        calls.append(event)
        return BehaviourResult(ok=True)

    registry = BehaviourRegistry()
    registry.register(
        Behaviour(
            id="example-behaviour:tick",
            trigger=parse_trigger("cron:* * * * *"),
            handler=handler,
        )
    )

    class _OpenConn:
        async def fetchval(self, *args, **kwargs):
            return True

        def transaction(self):
            class _Ctx:
                async def __aenter__(self_inner):
                    return None

                async def __aexit__(self_inner, *exc):
                    return None

            return _Ctx()

    class _OpenAcquireCtx:
        async def __aenter__(self_inner):
            return _OpenConn()

        async def __aexit__(self_inner, *exc):
            return None

    class _OpenPool:
        def acquire(self_inner):
            return _OpenAcquireCtx()

    dispatcher = BehaviourDispatcher(
        registry,
        scheduler=AsyncIOScheduler(),
        pool=_OpenPool(),  # type: ignore[arg-type]
    )
    await dispatcher._dispatch_under_lock(
        "example-behaviour:tick",
        idempotency_key="cron:example-behaviour:tick:slot-a",
        slot="slot-a",
        trigger_kind="cron",
    )
    assert len(calls) == 1


@pytest.mark.asyncio
async def test_handler_exception_writes_behaviour_dlq_row() -> None:
    """`docs/001 §5.3`: when a handler raises, the dispatcher
    swallows the exception (so the scheduler keeps ticking) and
    writes one row in ``eidan.behaviour_dlq`` so the operator can
    see what failed.
    """

    async def failing_handler(event: TriggerEvent) -> BehaviourResult:
        raise RuntimeError("boom from the handler")

    registry = BehaviourRegistry()
    registry.register(
        Behaviour(
            id="example-behaviour:tick",
            trigger=parse_trigger("cron:* * * * *"),
            handler=failing_handler,
        )
    )

    inserts: list[tuple[str, tuple]] = []

    class _Conn:
        async def fetchval(self, *args, **kwargs):
            # Pretend we always win the advisory lock so the handler
            # runs and raises.
            return True

        async def execute(self, sql: str, *params) -> None:
            inserts.append((sql, params))

        def transaction(self):
            class _Ctx:
                async def __aenter__(self_inner):
                    return None

                async def __aexit__(self_inner, *exc):
                    return None

            return _Ctx()

    class _AcquireCtx:
        async def __aenter__(self_inner):
            return _Conn()

        async def __aexit__(self_inner, *exc):
            return None

    class _Pool:
        def acquire(self_inner):
            return _AcquireCtx()

    dispatcher = BehaviourDispatcher(
        registry,
        scheduler=AsyncIOScheduler(),
        pool=_Pool(),  # type: ignore[arg-type]
    )

    # The call itself must not raise — the scheduler depends on this.
    await dispatcher._dispatch_under_lock(
        "example-behaviour:tick",
        idempotency_key="cron:example-behaviour:tick:dlq-slot",
        slot="dlq-slot",
        trigger_kind="cron",
    )

    # Exactly one DLQ write happened (no advisory-lock SELECT shows
    # up via execute; fetchval covered that). The INSERT carries the
    # behaviour id, trigger kind, idempotency key, error class, and
    # the handler's exception string.
    dlq_writes = [s for s in inserts if "behaviour_dlq" in s[0]]
    assert len(dlq_writes) == 1
    sql, params = dlq_writes[0]
    assert "INSERT INTO eidan.behaviour_dlq" in sql
    # params: (uuid, behaviour_id, trigger_kind, idempotency_key,
    #          error_class, error_message, metadata_json)
    assert params[1] == "example-behaviour:tick"
    assert params[2] == "cron"
    assert params[3] == "cron:example-behaviour:tick:dlq-slot"
    assert params[4] == "RuntimeError"
    assert "boom from the handler" in params[5]


@pytest.mark.asyncio
async def test_webhook_publish_is_idempotent_on_caller_key() -> None:
    """Re-publishing with the same caller-supplied idempotency key
    fires the handler exactly once, matching the event-bus contract."""
    calls: list[TriggerEvent] = []

    async def handler(event: TriggerEvent) -> BehaviourResult:
        calls.append(event)
        return BehaviourResult(ok=True)

    registry = BehaviourRegistry()
    registry.register(
        Behaviour(
            id="plugin-a:dedupe",
            trigger=parse_trigger("webhook:dedupe"),
            handler=handler,
        )
    )
    scheduler = AsyncIOScheduler()
    dispatcher = BehaviourDispatcher(registry, scheduler=scheduler)
    first = await dispatcher.publish_webhook(
        "plugin-a", "dedupe", {"__idempotency_key__": "k1"}
    )
    second = await dispatcher.publish_webhook(
        "plugin-a", "dedupe", {"__idempotency_key__": "k1"}
    )
    assert len(first) == 1
    assert second == []
    assert len(calls) == 1


# ---- dispatcher: event bus -----------------------------------------------


@pytest.mark.asyncio
async def test_event_publish_fans_out_to_subscribers() -> None:
    calls: list[TriggerEvent] = []

    async def handler(event: TriggerEvent) -> BehaviourResult:
        calls.append(event)
        return BehaviourResult(ok=True, notes_for_model=event.idempotency_key)

    registry = BehaviourRegistry()
    registry.register(
        Behaviour(
            id="sub-a",
            trigger=parse_trigger("event:notes.created"),
            handler=handler,
        )
    )
    registry.register(
        Behaviour(
            id="sub-b",
            trigger=parse_trigger("event:notes.created"),
            handler=handler,
        )
    )
    # An unrelated subscriber that should NOT fire.
    registry.register(
        Behaviour(
            id="sub-other",
            trigger=parse_trigger("event:notes.deleted"),
            handler=handler,
        )
    )

    scheduler = AsyncIOScheduler()
    dispatcher = BehaviourDispatcher(registry, scheduler=scheduler)
    results = await dispatcher.publish_event("notes.created", {"id": 1})
    assert len(results) == 2
    assert {c.payload["id"] for c in calls} == {1}
    # Both fired, neither was the unrelated subscriber.
    assert {c.trigger.spec for c in calls} == {"notes.created"}


@pytest.mark.asyncio
async def test_event_publish_dedupes_on_caller_supplied_key() -> None:
    """A caller can pin the key via the ``__idempotency_key__``
    convention on the payload; re-publishing with the same key is a
    no-op."""
    calls: list[TriggerEvent] = []

    async def handler(event: TriggerEvent) -> BehaviourResult:
        calls.append(event)
        return BehaviourResult(ok=True)

    registry = BehaviourRegistry()
    registry.register(
        Behaviour(
            id="dedupe-probe",
            trigger=parse_trigger("event:probe"),
            handler=handler,
        )
    )

    scheduler = AsyncIOScheduler()
    dispatcher = BehaviourDispatcher(registry, scheduler=scheduler)
    first = await dispatcher.publish_event("probe", {"__idempotency_key__": "k1"})
    second = await dispatcher.publish_event("probe", {"__idempotency_key__": "k1"})
    assert len(first) == 1
    assert second == []
    assert len(calls) == 1


def test_make_idempotency_key_is_unique() -> None:
    a = make_idempotency_key()
    b = make_idempotency_key()
    assert a != b
    assert a.startswith("dispatch:")


# ---- dispatcher: cron via APScheduler ------------------------------------


@pytest.mark.asyncio
async def test_cron_behaviour_schedules_apscheduler_job() -> None:
    """Acceptance criterion #1 (structural half): a cron-triggered
    behaviour becomes an APScheduler job on ``start()``."""
    plugin = _load_example_plugin()
    from example_behaviour import behaviours as example_behaviours
    from example_behaviour.plugin import make_behaviours

    example_behaviours.reset()

    registry = BehaviourRegistry()
    registry.register_all(make_behaviours())

    scheduler = AsyncIOScheduler()
    dispatcher = BehaviourDispatcher(registry, scheduler=scheduler)
    try:
        dispatcher.start()
        job = scheduler.get_job("behaviour:example-behaviour:tick")
        assert job is not None
        # CronTrigger.from_crontab('* * * * *') schedules the next
        # firing for the next minute mark — at most 60s after now.
        next_run = job.next_run_time
        assert next_run is not None
        delta = next_run - datetime.now(next_run.tzinfo)
        assert delta <= timedelta(seconds=61)
    finally:
        dispatcher.shutdown()

    assert plugin is not None  # silence "unused" linters


@pytest.mark.asyncio
async def test_cron_behaviour_fires_within_a_minute() -> None:
    """Acceptance criterion #1 (timing half): the handler actually runs.

    Rather than waiting up to a real minute we nudge the scheduled
    job's ``next_run_time`` to "now-ish" so the test completes in
    well under a second. The wiring under test (CronTrigger → job →
    ``_fire_cron`` → registry.dispatch → handler) is exercised
    end-to-end; only the literal wait is shortened.
    """
    _load_example_plugin()
    from example_behaviour import behaviours as example_behaviours
    from example_behaviour.plugin import make_behaviours

    example_behaviours.reset()

    registry = BehaviourRegistry()
    registry.register_all(make_behaviours())

    scheduler = AsyncIOScheduler()
    dispatcher = BehaviourDispatcher(registry, scheduler=scheduler)
    try:
        dispatcher.start()
        scheduler.modify_job(
            "behaviour:example-behaviour:tick",
            next_run_time=datetime.now(UTC) + timedelta(milliseconds=50),
        )
        # Poll for the handler to run. 5s is generously above the
        # 50 ms nudge; on a healthy machine we see ≤100 ms.
        for _ in range(50):
            if example_behaviours.state.invocations:
                break
            await asyncio.sleep(0.1)
        assert example_behaviours.state.invocations, (
            "tick handler did not fire after cron job nudged to ~now"
        )
        fired = example_behaviours.state.invocations[0]
        assert fired.trigger.kind == "cron"
        assert fired.trigger.spec == "* * * * *"
        assert fired.idempotency_key.startswith("cron:example-behaviour:tick:")
    finally:
        dispatcher.shutdown()


@pytest.mark.asyncio
async def test_cron_handler_is_idempotent_on_repeat_key() -> None:
    """Acceptance criterion #2 against the cron path: firing the
    plugin's handler twice with the same minute-keyed idempotency_key
    runs it exactly once."""
    _load_example_plugin()
    from example_behaviour import behaviours as example_behaviours
    from example_behaviour.plugin import make_behaviours

    example_behaviours.reset()

    registry = BehaviourRegistry()
    registry.register_all(make_behaviours())

    key = "cron:example-behaviour:tick:2026-05-14T00:00"
    first = await registry.dispatch(
        "example-behaviour:tick", idempotency_key=key
    )
    second = await registry.dispatch(
        "example-behaviour:tick", idempotency_key=key
    )

    assert first is not None and first.ok
    assert second is None
    assert len(example_behaviours.state.invocations) == 1
