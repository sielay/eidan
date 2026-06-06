# SPDX-License-Identifier: AGPL-3.0-or-later
"""Topology-driven notification routing: topic → (channel, target).

Operators configure, per node, which notification *topics* go to which
channel + destination, via the ``EIDAN_NOTIFY_ROUTES`` env (a JSON object
set in the node's topology ``extra_env``). This decouples *what happened*
(a topic like ``node.startup`` / ``sentry`` / ``job.update``) from *where
it goes* (``#eidan-deployments`` / ``#eidan-sentry`` / …) so routing is
operator config, not hardcoded at the emit site (`docs/012`, slack-routing).

Shape (same JSON-in-env precedent as ``EIDAN_LOG_FORWARD_HEADERS``)::

    {"node.startup": {"channel": "slack", "target": "#eidan-deployments"},
     "sentry":       {"channel": "slack", "target": "#eidan-sentry"}}

The resolver maps ``target`` onto the metadata key the destination
adapter reads (slack → ``slack_channel``, telegram → ``chat_id``) and
calls the existing :class:`NotificationRouter`. A topic with no route is
a no-op; a delivery failure is logged, never raised — a missing webhook
must not crash a boot or a tick.
"""

from __future__ import annotations

import json
import logging
import os
from dataclasses import dataclass
from typing import Any
from uuid import UUID

logger = logging.getLogger(__name__)

_ENV = "EIDAN_NOTIFY_ROUTES"

# channel → the metadata key its adapter reads for the destination.
_TARGET_KEY = {"slack": "slack_channel", "telegram": "chat_id"}


@dataclass(frozen=True)
class Route:
    channel: str
    target: str | None = None


def load_routes(raw: str | None = None) -> dict[str, Route]:
    """Parse ``EIDAN_NOTIFY_ROUTES`` into ``{topic: Route}``. Never raises.

    Reads from the env when ``raw`` is None. A malformed blob, a
    non-object value, or a route missing ``channel`` is logged and
    skipped — the rest of the routes still load.
    """
    if raw is None:
        raw = os.environ.get(_ENV)
    if not raw or not raw.strip():
        return {}
    try:
        parsed = json.loads(raw)
        if not isinstance(parsed, dict):
            raise ValueError("must be a JSON object")
    except (ValueError, TypeError) as exc:
        logger.warning("[notify_routes] failed to parse %s: %s", _ENV, exc)
        return {}
    routes: dict[str, Route] = {}
    for topic, spec in parsed.items():
        if not isinstance(spec, dict) or not spec.get("channel"):
            logger.warning(
                "[notify_routes] skipping route %r: needs a 'channel'", topic
            )
            continue
        target = spec.get("target")
        routes[str(topic)] = Route(
            channel=str(spec["channel"]),
            target=str(target) if target is not None else None,
        )
    return routes


class NotificationRouteResolver:
    """Resolve a topic to a route and emit via the :class:`NotificationRouter`.

    Errors are logged, not raised: a notification is a side effect and a
    misconfigured route or a Slack outage must not break the caller (a
    boot, a sentry tick). Returns the ``NotificationResult`` on success,
    ``None`` on no-route or failure.
    """

    def __init__(self, router: Any, routes: dict[str, Route]) -> None:
        self._router = router
        self._routes = routes

    @property
    def routes(self) -> dict[str, Route]:
        return self._routes

    async def emit(
        self,
        topic: str,
        text: str,
        *,
        severity: str = "info",
        user_id: UUID | None = None,
    ) -> Any | None:
        route = self._routes.get(topic)
        if route is None:
            return None  # no route for this topic → intentional no-op
        metadata: dict[str, Any] = {"severity": severity, "topic": topic}
        if route.target is not None:
            key = _TARGET_KEY.get(route.channel, "target")
            metadata[key] = route.target
        try:
            return await self._router.notify(
                channel=route.channel,
                text=text,
                user_id=user_id,
                metadata=metadata,
            )
        except Exception as exc:  # noqa: BLE001 — a notification must not break the caller
            logger.warning(
                "[notify_routes] emit failed topic=%s channel=%s: %s",
                topic,
                route.channel,
                exc,
            )
            return None


def make_route_resolver(router: Any | None) -> NotificationRouteResolver | None:
    """Build a resolver from the env, or ``None`` when no router is wired.

    Mirrors :func:`bootstrap._make_notify_callable` — ``None`` lets a
    caller fall back with ``if ctx.notify_topic is None``.
    """
    if router is None:
        return None
    return NotificationRouteResolver(router, load_routes())
