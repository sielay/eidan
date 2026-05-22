"""Outbound notification surface — `docs/024_NOTIFY_SURFACE.md` (TBD).

The host primitive an agent / plugin / sentry-tick uses to nudge
the operator out-of-band. Three concerns:

1. **Channel abstraction.** A notification has a ``channel``
   ('telegram', 'email', 'slack', 'webhook', …) and a ``text``.
   Each channel is a separate adapter plugged into a registry.
   Plugins call ``ctx.notify(channel, text, **kwargs)`` and the
   host routes to the right adapter.
2. **No silent failures.** When the configured adapter doesn't
   resolve (channel unknown, missing credentials, network failure),
   the call raises a typed :class:`NotificationError` so the caller
   sees the failure rather than the nudge disappearing.
3. **Operator-facing fallback.** When delivery to the chosen
   channel fails, the host writes an :class:`Escalation` so the
   operator's inbox surfaces the *attempted* nudge along with the
   failure reason. This is the "Sentry tried to tell you something
   on Telegram and Telegram was down" path.

Phase 1 ships the registry, the abstract `NotificationAdapter`
protocol, and the Telegram adapter. Email / Slack / SMS adapters
land alongside their respective bundle plugins.
"""

from __future__ import annotations

import asyncio
import logging
import os
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any
from uuid import UUID

import httpx

logger = logging.getLogger(__name__)


class NotificationError(Exception):
    """Raised when notification delivery fails.

    ``channel`` and ``reason`` are populated so the caller can route
    a follow-up escalation into the operator's inbox without a
    second classifier call.
    """

    def __init__(self, *, channel: str, reason: str) -> None:
        super().__init__(f"notification via {channel!r} failed: {reason}")
        self.channel = channel
        self.reason = reason


@dataclass(frozen=True, slots=True)
class NotificationResult:
    """What :func:`notify` returns on success.

    ``message_id`` is the channel-side id (Telegram message id,
    email Message-Id, Slack ts, …) so the caller can correlate. The
    ``delivered_at`` timestamp is captured by the adapter so the
    operator's inbox can show "delivered" vs "pending".
    """

    channel: str
    message_id: str | None
    delivered_at: str  # ISO-8601


# A channel adapter is a coroutine: takes a payload dict, returns a
# NotificationResult, raises NotificationError on failure. Adapters
# are registered into the host's NotificationRouter at bootstrap.
NotificationAdapter = Callable[[dict[str, Any]], Awaitable[NotificationResult]]


class NotificationRouter:
    """Process-local router from ``channel`` → adapter.

    The bootstrap registers the Telegram adapter (when configured)
    and any plugin-provided adapters. A plugin's
    ``on_activate(ctx)`` can call ``ctx.notify`` but cannot register
    new channels itself — that's a host-only API per `docs/024 §1`
    (the seam is "many surfaces, one verb"; adding new surfaces is
    a config-time decision, not a runtime one).
    """

    def __init__(self) -> None:
        self._adapters: dict[str, NotificationAdapter] = {}

    def register(self, channel: str, adapter: NotificationAdapter) -> None:
        if channel in self._adapters:
            raise ValueError(
                f"channel {channel!r} already registered; the host "
                "wires each channel exactly once at bootstrap"
            )
        self._adapters[channel] = adapter

    def channels(self) -> list[str]:
        return sorted(self._adapters)

    async def notify(
        self,
        *,
        channel: str,
        text: str,
        user_id: UUID | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> NotificationResult:
        adapter = self._adapters.get(channel)
        if adapter is None:
            raise NotificationError(
                channel=channel,
                reason=(
                    f"no adapter registered; available channels: "
                    f"{self.channels() or '(none)'}"
                ),
            )
        payload: dict[str, Any] = {"text": text, "metadata": metadata or {}}
        if user_id is not None:
            payload["user_id"] = str(user_id)
        return await adapter(payload)


# ---------------------------------------------------------------------------
# Telegram adapter
# ---------------------------------------------------------------------------


# Operators configure the Telegram adapter via three env vars:
#
#   TELEGRAM_BOT_TOKEN     — the bot's API token (BotFather output).
#   TELEGRAM_CHAT_ID       — the operator's chat with the bot. When
#                            multi-user is on, plugins look up the
#                            per-user chat_id via the secret accessor:
#                            ctx.secret("telegram.chat_id") returns
#                            the per-agent override.
#   TELEGRAM_API_BASE      — defaults to https://api.telegram.org.
#                            Useful when an operator runs an
#                            on-premise Bot API server.
#
# The adapter is opt-in: the bootstrap registers it only when
# TELEGRAM_BOT_TOKEN is set. Without the env, ctx.notify("telegram",
# ...) raises NotificationError("telegram", "no adapter registered")
# and the caller can fall back to writing an escalation.


def _telegram_configured() -> bool:
    return bool(os.environ.get("TELEGRAM_BOT_TOKEN", "").strip())


def make_telegram_adapter(
    *,
    bot_token: str,
    default_chat_id: str | None = None,
    api_base: str = "https://api.telegram.org",
    timeout_s: float = 5.0,
) -> NotificationAdapter:
    """Build a Telegram :type:`NotificationAdapter`.

    The closure captures the bot token + default chat id so the
    handler signature stays opaque to the caller. Per-call
    ``metadata.chat_id`` overrides the default — used by the secret
    accessor's per-agent override path so each user can receive
    nudges on their own chat.
    """
    if not bot_token:
        raise ValueError("telegram bot_token is required")

    async def _adapter(payload: dict[str, Any]) -> NotificationResult:
        text = payload.get("text", "")
        if not isinstance(text, str) or not text.strip():
            raise NotificationError(
                channel="telegram",
                reason="empty text",
            )
        metadata = payload.get("metadata") or {}
        chat_id = (
            str(metadata.get("chat_id"))
            if metadata.get("chat_id") is not None
            else default_chat_id
        )
        if not chat_id:
            raise NotificationError(
                channel="telegram",
                reason=(
                    "no chat_id: set TELEGRAM_CHAT_ID for the default "
                    "operator chat, or pass metadata.chat_id per call "
                    "(typically resolved via ctx.secret('telegram.chat_id'))"
                ),
            )
        url = f"{api_base.rstrip('/')}/bot{bot_token}/sendMessage"
        try:
            async with httpx.AsyncClient(timeout=timeout_s) as client:
                resp = await client.post(
                    url,
                    json={
                        "chat_id": chat_id,
                        "text": text[:4096],  # Telegram caps at 4096
                        "disable_web_page_preview": True,
                    },
                )
        except httpx.HTTPError as exc:
            raise NotificationError(
                channel="telegram", reason=f"http error: {exc}"
            ) from exc

        if resp.status_code != 200:
            raise NotificationError(
                channel="telegram",
                reason=(
                    f"telegram api returned {resp.status_code}: "
                    f"{resp.text[:200]}"
                ),
            )
        try:
            body = resp.json()
        except ValueError as exc:
            raise NotificationError(
                channel="telegram",
                reason=f"telegram api returned non-JSON: {exc}",
            ) from exc
        if not body.get("ok"):
            raise NotificationError(
                channel="telegram",
                reason=f"telegram api ok=false: {body.get('description', '')}",
            )
        result = body.get("result", {})
        return NotificationResult(
            channel="telegram",
            message_id=str(result.get("message_id"))
            if result.get("message_id") is not None
            else None,
            delivered_at=_iso_now(),
        )

    return _adapter


def _iso_now() -> str:
    from datetime import UTC, datetime

    return datetime.now(tz=UTC).isoformat()


# ---------------------------------------------------------------------------
# Bootstrap helper
# ---------------------------------------------------------------------------


def build_default_router() -> NotificationRouter:
    """Build a :class:`NotificationRouter` populated with whichever
    channel adapters the operator's env vars enable.

    Phase 1 wires Telegram only. Email / Slack adapters land
    alongside their respective bundle plugins.
    """
    router = NotificationRouter()
    if _telegram_configured():
        try:
            adapter = make_telegram_adapter(
                bot_token=os.environ["TELEGRAM_BOT_TOKEN"].strip(),
                default_chat_id=os.environ.get(
                    "TELEGRAM_CHAT_ID", ""
                ).strip()
                or None,
                api_base=os.environ.get(
                    "TELEGRAM_API_BASE", "https://api.telegram.org"
                ).strip()
                or "https://api.telegram.org",
            )
        except ValueError as exc:
            logger.warning("[notifications] telegram adapter not built: %s", exc)
        else:
            router.register("telegram", adapter)
    return router


__all__ = [
    "NotificationAdapter",
    "NotificationError",
    "NotificationResult",
    "NotificationRouter",
    "build_default_router",
    "make_telegram_adapter",
]


# Silence the unused-import linter for `asyncio` — kept for readers
# expecting it in a module that exposes async functions.
_ = asyncio
