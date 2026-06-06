"""Sentry plugin entry point.

Registers one behaviour at activation time — ``sentry:tick`` —
that fires on the configured schedule (default ``PT5M``). The
handler closes over the plugin context's DB accessor so the tick
can read core ``eidan.*`` tables (for state) and write to the
plugin-private ``plugin_sentry.*`` tables (for tick logs and
nudge dedupe).

Phase 1 stops here. The Phi-3 / Ollama local-inference path from
``docs/SENTRY_FEATURE_SPEC.md §"Core Loop"`` lands once core has a
local-model provider adapter; until then the tick body runs
deterministic detectors only (:mod:`eidan_sentry.patterns`).
"""

from __future__ import annotations

import logging
import os

from eidan_backend.behaviours import (
    Behaviour,
    BehaviourResult,
    TriggerEvent,
    parse_trigger,
)
from eidan_backend.plugins import PluginBase, PluginContext

from .loop import run_sentry_tick

logger = logging.getLogger(__name__)


# The schedule trigger string — defaults to every 5 minutes but the
# operator can override at install time via the env var. The schedule
# is captured at activation; changing the env var mid-run requires
# `eidan plugins reload` (Phase 2 lifecycle hook).
def _tick_trigger_spec() -> str:
    return os.environ.get("EIDAN_SENTRY_TICK_INTERVAL", "PT5M").strip() or "PT5M"


class Plugin(PluginBase):
    name = "sentry"

    def __init__(self) -> None:
        # The plugin captures ctx.db, ctx.notify, and ctx.spawn_turn
        # at activation so the handler closure has stable accessors
        # for the lifetime of the registered behaviour. ctx.db points
        # at the plugin's private schema; ctx.notify is the host's
        # out-of-band nudge surface (None when no channel is
        # configured); ctx.spawn_turn lets a high-severity pattern
        # escalate from "write an inbox row" to "kick off an
        # agent-initiated turn" (None when no provider is wired,
        # e.g. unit-test boots).
        self._db: object | None = None
        self._notify: object | None = None
        self._notify_topic: object | None = None
        self._spawn_turn: object | None = None
        # ctx.assess_sufficiency is the loop-level second-voice critic the
        # research loop uses to decide a turn-sequence is "enough" (#186);
        # None when no provider is wired, in which case the loop falls back
        # to the investigator's own [DONE] self-declaration.
        self._assess_sufficiency: object | None = None

    async def on_install(self, ctx: PluginContext) -> None:
        logger.info("[sentry] on_install (name=%s)", ctx.name)

    async def on_activate(self, ctx: PluginContext) -> None:
        logger.info(
            "[sentry] on_activate (name=%s, notify=%s, spawn_turn=%s)",
            ctx.name,
            "configured" if ctx.notify is not None else "unavailable",
            "configured" if ctx.spawn_turn is not None else "unavailable",
        )
        self._db = ctx.db
        self._notify = ctx.notify
        self._notify_topic = ctx.notify_topic
        self._spawn_turn = ctx.spawn_turn
        self._assess_sufficiency = ctx.assess_sufficiency
        ctx.register_behaviours(
            [
                Behaviour(
                    id="sentry:tick",
                    trigger=parse_trigger(f"schedule:{_tick_trigger_spec()}"),
                    handler=self._handle_tick,
                ),
            ]
        )

    async def on_deactivate(self, ctx: PluginContext) -> None:
        logger.info("[sentry] on_deactivate (name=%s)", ctx.name)
        self._db = None
        self._notify = None
        self._notify_topic = None
        self._spawn_turn = None
        self._assess_sufficiency = None

    async def on_uninstall(self, ctx: PluginContext) -> None:
        logger.info("[sentry] on_uninstall (name=%s)", ctx.name)

    async def _handle_tick(self, event: TriggerEvent) -> BehaviourResult:
        """One tick — run the detectors, persist findings, escalate.

        The tick is wrapped in a try/except so a misbehaving query
        doesn't crash the scheduler. Failures land as a
        ``BehaviourResult(ok=False, error=...)`` which the dispatcher
        swallows at the edge (per ``docs/001 §5.3`` Phase-1 posture).
        """
        if self._db is None:
            return BehaviourResult(
                ok=False, error="sentry tick fired before on_activate completed"
            )

        # The plugin's ctx.db is a `_PluginDb`; we need the underlying
        # asyncpg pool to drive the tick. The `_PluginDb` exposes the
        # pool through its private attribute — there is no public API
        # today, so we read the attribute defensively and fall back to
        # an error if the shape changes. A cleaner abstraction lives
        # behind `docs/001` revision once more plugins need this.
        pool = getattr(self._db, "_pool", None)
        if pool is None:
            return BehaviourResult(
                ok=False,
                error=(
                    "sentry tick could not access the host pool from "
                    "ctx.db — plugin contract changed?"
                ),
            )

        try:
            summary = await run_sentry_tick(
                pool,
                tick_id=event.idempotency_key,
                notify=self._notify,
                notify_topic=self._notify_topic,
                spawn_turn=self._spawn_turn,
                assess_sufficiency=self._assess_sufficiency,
            )
        except Exception as exc:  # noqa: BLE001 — surface in BehaviourResult
            logger.exception("[sentry] tick failed")
            return BehaviourResult(ok=False, error=str(exc))

        return BehaviourResult(
            ok=True,
            notes_for_model=(
                f"sentry tick: {len(summary)} user(s), "
                f"{sum(len(v) for v in summary.values())} pattern(s) detected"
                if summary
                else None
            ),
        )


__all__ = ["Plugin"]
