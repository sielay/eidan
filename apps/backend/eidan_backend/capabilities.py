# SPDX-License-Identifier: AGPL-3.0-or-later
"""Host registry of the job **kinds** this node is built to serve.

The universal delegation queue (``eidan.jobs``, #247) routes work by
capability *kind*: a node serving that kind with spare capacity claims a
job and runs it end-to-end. A plugin declares what its node serves by
calling ``ctx.register_capabilities([...])`` during ``on_activate``
(mirroring ``register_tools`` / ``register_behaviours``); the host
collects a snapshot after activation and the heartbeat loop advertises it
into ``eidan.node_heartbeats.served_kinds`` (#249), so an operator — and a
future router — can see where live capacity for a kind exists.

This is the *advertisement* surface ("what I'm built to serve"), distinct
from the runtime ``node_capability_overrides`` opt-out ("stood down right
now"). Capabilities are registered once at activation and don't churn, so
a static snapshot is sufficient — no per-tick callback.
"""

from __future__ import annotations

from collections.abc import Iterable
from dataclasses import dataclass


@dataclass(frozen=True, slots=True)
class JobCapability:
    """A job ``kind`` this node serves and how many it can run at once."""

    kind: str
    capacity: int


class CapabilityRegistry:
    """An ordered, kind-keyed map of the job capabilities a node serves.

    Insertion order is preserved so the advertised snapshot is
    deterministic between runs. One kind is served by one plugin; a second
    registration of the same kind is a wiring error and raises, mirroring
    :class:`~eidan_backend.tools.ToolRegistry`.
    """

    def __init__(self) -> None:
        self._caps: dict[str, JobCapability] = {}

    def register(self, capabilities: Iterable[JobCapability]) -> None:
        for cap in capabilities:
            if cap.kind in self._caps:
                raise ValueError(f"capability already registered for kind: {cap.kind}")
            self._caps[cap.kind] = cap

    def is_empty(self) -> bool:
        return not self._caps

    def snapshot(self) -> list[dict]:
        """The advertised ``[{"kind", "capacity"}, ...]`` list (JSONB-shaped)."""
        return [
            {"kind": c.kind, "capacity": c.capacity}
            for c in self._caps.values()
        ]


__all__ = ["JobCapability", "CapabilityRegistry"]
