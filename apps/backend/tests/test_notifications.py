"""Notification surface tests (`ctx.notify` + Telegram adapter).

Two halves:

- :class:`NotificationRouter` unit tests — register / dispatch /
  unknown-channel error / channel-list / re-register conflict.
- :func:`make_telegram_adapter` against a stubbed HTTP transport
  (httpx MockTransport) so the test doesn't hit api.telegram.org —
  verifies the request shape, the per-call ``metadata.chat_id``
  override, the failure-→ NotificationError mapping for each error
  path, and the 4096-character body cap.
"""

from __future__ import annotations

import json

import httpx
import pytest
from eidan_backend.notifications import (
    NotificationError,
    NotificationResult,
    NotificationRouter,
    build_default_router,
    make_telegram_adapter,
)

# ---- router unit tests --------------------------------------------------


@pytest.mark.asyncio
async def test_router_dispatches_to_registered_channel() -> None:
    router = NotificationRouter()

    async def adapter(payload: dict) -> NotificationResult:
        return NotificationResult(
            channel="test",
            message_id="m-1",
            delivered_at="2026-05-20T00:00:00+00:00",
        )

    router.register("test", adapter)
    out = await router.notify(channel="test", text="hello")
    assert out.message_id == "m-1"


@pytest.mark.asyncio
async def test_router_unknown_channel_raises() -> None:
    router = NotificationRouter()
    with pytest.raises(NotificationError) as exc:
        await router.notify(channel="telegram", text="hi")
    assert exc.value.channel == "telegram"
    assert "no adapter" in exc.value.reason


def test_router_register_conflict() -> None:
    router = NotificationRouter()

    async def a(payload: dict) -> NotificationResult:
        return NotificationResult(channel="x", message_id=None, delivered_at="t")

    router.register("x", a)
    with pytest.raises(ValueError, match="already registered"):
        router.register("x", a)


def test_router_lists_channels_sorted() -> None:
    router = NotificationRouter()

    async def adapter(payload: dict) -> NotificationResult:
        return NotificationResult(channel="", message_id=None, delivered_at="")

    router.register("zulu", adapter)
    router.register("alpha", adapter)
    assert router.channels() == ["alpha", "zulu"]


# ---- Telegram adapter ---------------------------------------------------


@pytest.mark.asyncio
async def test_telegram_adapter_posts_send_message(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured: dict = {}

    def transport_handler(request: httpx.Request) -> httpx.Response:
        captured["url"] = str(request.url)
        captured["body"] = json.loads(request.content)
        return httpx.Response(
            200, json={"ok": True, "result": {"message_id": 42}}
        )

    _RealAsyncClient = httpx.AsyncClient  # capture before patching
    monkeypatch.setattr(
        httpx, "AsyncClient",
        lambda **kw: _RealAsyncClient(
            transport=httpx.MockTransport(transport_handler), **kw
        ),
    )
    adapter = make_telegram_adapter(
        bot_token="bot-token-xyz",
        default_chat_id="111222",
    )
    result = await adapter({"text": "hello operator", "metadata": {}})
    assert result.message_id == "42"
    assert "bot-token-xyz/sendMessage" in captured["url"]
    assert captured["body"]["chat_id"] == "111222"
    assert captured["body"]["text"] == "hello operator"


@pytest.mark.asyncio
async def test_telegram_adapter_honours_metadata_chat_id_override(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured: dict = {}

    def transport_handler(request: httpx.Request) -> httpx.Response:
        captured["body"] = json.loads(request.content)
        return httpx.Response(
            200, json={"ok": True, "result": {"message_id": 7}}
        )

    _RealAsyncClient = httpx.AsyncClient  # capture before patching
    monkeypatch.setattr(
        httpx, "AsyncClient",
        lambda **kw: _RealAsyncClient(
            transport=httpx.MockTransport(transport_handler), **kw
        ),
    )
    adapter = make_telegram_adapter(
        bot_token="t", default_chat_id="default-chat"
    )
    await adapter({"text": "hi", "metadata": {"chat_id": "override-chat"}})
    assert captured["body"]["chat_id"] == "override-chat"


@pytest.mark.asyncio
async def test_telegram_adapter_raises_without_chat_id(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    adapter = make_telegram_adapter(bot_token="t", default_chat_id=None)
    with pytest.raises(NotificationError) as exc:
        await adapter({"text": "hi", "metadata": {}})
    assert exc.value.channel == "telegram"
    assert "chat_id" in exc.value.reason


@pytest.mark.asyncio
async def test_telegram_adapter_raises_on_empty_text() -> None:
    adapter = make_telegram_adapter(bot_token="t", default_chat_id="c")
    with pytest.raises(NotificationError, match="empty text"):
        await adapter({"text": "", "metadata": {}})


@pytest.mark.asyncio
async def test_telegram_adapter_raises_on_http_error(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def transport_handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(429, json={"ok": False, "description": "rate limit"})

    _RealAsyncClient = httpx.AsyncClient  # capture before patching
    monkeypatch.setattr(
        httpx, "AsyncClient",
        lambda **kw: _RealAsyncClient(
            transport=httpx.MockTransport(transport_handler), **kw
        ),
    )
    adapter = make_telegram_adapter(bot_token="t", default_chat_id="c")
    with pytest.raises(NotificationError) as exc:
        await adapter({"text": "hi", "metadata": {}})
    assert "429" in exc.value.reason


@pytest.mark.asyncio
async def test_telegram_adapter_truncates_text_at_4096(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured: dict = {}

    def transport_handler(request: httpx.Request) -> httpx.Response:
        captured["body"] = json.loads(request.content)
        return httpx.Response(200, json={"ok": True, "result": {"message_id": 1}})

    _RealAsyncClient = httpx.AsyncClient  # capture before patching
    monkeypatch.setattr(
        httpx, "AsyncClient",
        lambda **kw: _RealAsyncClient(
            transport=httpx.MockTransport(transport_handler), **kw
        ),
    )
    adapter = make_telegram_adapter(bot_token="t", default_chat_id="c")
    long_text = "a" * 5000
    await adapter({"text": long_text, "metadata": {}})
    assert len(captured["body"]["text"]) == 4096


# ---- build_default_router env-var wiring -------------------------------


def test_build_default_router_skips_telegram_when_unconfigured(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("TELEGRAM_BOT_TOKEN", raising=False)
    router = build_default_router()
    assert router.channels() == []


def test_build_default_router_registers_telegram_when_configured(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("TELEGRAM_BOT_TOKEN", "bot-xyz")
    monkeypatch.setenv("TELEGRAM_CHAT_ID", "1234")
    router = build_default_router()
    assert "telegram" in router.channels()
