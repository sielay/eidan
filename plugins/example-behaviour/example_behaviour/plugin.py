"""Plugin entry point — mirrors the shape pinned in `docs/001 §2.2`.

The :class:`Plugin` class is the host's :class:`PluginBase` subclass
the loader (`docs/001 §8`) instantiates after manifest validation.
:func:`make_behaviours` is retained as a module-level helper so the
Phase 1.5 dispatch tests (which exercise the behaviour subsystem in
isolation, without the loader) can keep importing it directly.

``on_activate`` calls ``ctx.register_behaviours`` so the bootstrap's
behaviour registry receives the cron-triggered ``tick`` handler. The
dispatcher's ``start()`` then schedules it against APScheduler.
"""

from __future__ import annotations

import logging

from eidan_backend.behaviours import Behaviour, parse_trigger
from eidan_backend.plugins import PluginBase, PluginContext

from .behaviours import tick

logger = logging.getLogger(__name__)


def make_behaviours() -> list[Behaviour]:
    """Return the plugin's behaviours, mirroring the manifest stanza.

    Keep this in lock-step with ``plugin.yaml``'s ``behaviours[]``:
    the manifest loader (Phase 4) will refuse to activate a plugin
    whose runtime dataclass set diverges from the declared one
    (`docs/006 §2.3` ``BehaviourManifestMismatch``).
    """
    return [
        Behaviour(
            id="example-behaviour:tick",
            trigger=parse_trigger("cron:* * * * *"),
            handler=tick,
        ),
    ]


class Plugin(PluginBase):
    name = "example-behaviour"

    async def on_activate(self, ctx: PluginContext) -> None:
        logger.info("[example-behaviour] on_activate (name=%s)", ctx.name)
        ctx.register_behaviours(make_behaviours())


__all__ = ["Plugin", "make_behaviours"]
