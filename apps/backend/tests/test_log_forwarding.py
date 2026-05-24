# SPDX-License-Identifier: AGPL-3.0-or-later
"""Tests for :mod:`eidan_backend.log_forwarding`.

Pure-Python — no DB, no real HTTP. ``urllib.request.urlopen`` is
patched so we capture every POST the handler would send and
assert on its envelope shape.

The forwarder mutates root-logger state (adds a QueueHandler),
so every test resets via ``_reset_for_tests()`` to avoid bleed.
"""

from __future__ import annotations

import json
import logging
import threading
import time
from unittest.mock import MagicMock, patch

import pytest
from eidan_backend.log_forwarding import (
    _format_record,
    _reset_for_tests,
    attach_log_forwarder_if_configured,
)

# All env vars the module reads. Cleared per-test so the laptop's
# env doesn't leak in.
_FORWARDER_ENV = (
    "EIDAN_LOG_FORWARD_URL",
    "EIDAN_LOG_FORWARD_TOKEN",
    "EIDAN_LOG_FORWARD_HEADERS",
    "EIDAN_LOG_FORWARD_LEVEL",
    "EIDAN_LOG_FORWARD_TIMEOUT",
    "EIDAN_LOG_FORWARD_QUEUE_SIZE",
)


@pytest.fixture(autouse=True)
def _clean_env_and_state(monkeypatch: pytest.MonkeyPatch) -> None:
    for key in _FORWARDER_ENV:
        monkeypatch.delenv(key, raising=False)
    _reset_for_tests()
    # The forwarder no longer mutates root logger level (that was a
    # surprising side effect — see attach_log_forwarder_if_configured
    # docstring). For tests that emit INFO records, set root to INFO
    # here so records actually reach the QueueHandler instead of
    # being filtered out at the root. Restored on teardown to avoid
    # bleed into adjacent test modules.
    root = logging.getLogger()
    previous_level = root.level
    root.setLevel(logging.INFO)
    yield
    _reset_for_tests()
    root.setLevel(previous_level)


def _make_record(
    name: str = "eidan_backend.telemetry",
    level: int = logging.INFO,
    msg: str = "hello",
    extra: dict | None = None,
) -> logging.LogRecord:
    record = logging.LogRecord(
        name=name,
        level=level,
        pathname=__file__,
        lineno=1,
        msg=msg,
        args=(),
        exc_info=None,
    )
    for key, value in (extra or {}).items():
        setattr(record, key, value)
    return record


# ---------------------------------------------------------------------------
# Envelope shape
# ---------------------------------------------------------------------------


def test_envelope_contains_stdlib_fields() -> None:
    record = _make_record(msg="boot complete")
    env = _format_record(record)
    assert env["level"] == "INFO"
    assert env["logger"] == "eidan_backend.telemetry"
    assert env["message"] == "boot complete"
    # ts is an isoformat string with a UTC offset
    assert "+00:00" in env["ts"]
    # No telemetry extras on a bare record → keys absent (not None).
    assert "event" not in env
    assert "node_id" not in env


def test_envelope_picks_up_telemetry_extras() -> None:
    """Verifies the contract with eidan_backend.telemetry — every
    `emit_event` fires a logger.info(..., extra={event, node_id,
    node_type, conversation_id, payload}) and the forwarder
    forwards each of those as top-level JSON keys."""
    record = _make_record(
        extra={
            "event": "node.boot",
            "node_id": "kasha",
            "node_type": "pi",
            "conversation_id": None,  # falsy but legit — should NOT appear
            "payload": {"plugins": ["sentry"]},
        }
    )
    env = _format_record(record)
    assert env["event"] == "node.boot"
    assert env["node_id"] == "kasha"
    assert env["node_type"] == "pi"
    # conversation_id was None — skipped to keep the envelope terse
    assert "conversation_id" not in env
    assert env["payload"] == {"plugins": ["sentry"]}


def test_envelope_includes_traceback_when_exc_info_set() -> None:
    try:
        raise RuntimeError("boom")
    except RuntimeError:
        import sys
        record = _make_record(
            level=logging.ERROR,
            msg="something blew up",
            extra={"event": "telemetry.heartbeat_failed"},
        )
        record.exc_info = sys.exc_info()
    env = _format_record(record)
    assert "exception" in env
    assert "RuntimeError: boom" in env["exception"]
    assert "Traceback" in env["exception"]


# ---------------------------------------------------------------------------
# Attach gating
# ---------------------------------------------------------------------------


def test_attach_no_op_when_url_unset() -> None:
    """Default operator state — no env var, no handler added."""
    root = logging.getLogger()
    handlers_before = list(root.handlers)
    attached = attach_log_forwarder_if_configured()
    assert attached is False
    assert root.handlers == handlers_before


def test_attach_is_idempotent(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("EIDAN_LOG_FORWARD_URL", "https://intake.example/log")
    assert attach_log_forwarder_if_configured() is True
    handlers_after_first = list(logging.getLogger().handlers)
    # Second call must NOT double-attach.
    assert attach_log_forwarder_if_configured() is True
    assert logging.getLogger().handlers == handlers_after_first


# ---------------------------------------------------------------------------
# End-to-end: env → handler → captured POST
# ---------------------------------------------------------------------------


def _patch_urlopen(captured: list) -> MagicMock:
    mock = MagicMock()
    mock.return_value.__enter__.return_value.read.return_value = b""

    def side_effect(req, timeout):  # noqa: ARG001 — match urlopen signature
        captured.append(
            {
                "url": req.full_url,
                "headers": dict(req.headers),
                "body": json.loads(req.data.decode("utf-8")),
                "timeout": timeout,
            }
        )
        return mock.return_value

    mock.side_effect = side_effect
    return mock


def _wait_for_drain(timeout: float = 2.0) -> None:
    """Block until the QueueListener has drained the queue.

    The listener runs a background thread; tests need to wait for
    it before asserting on what got POSTed."""
    from eidan_backend import log_forwarding

    listener = log_forwarding._active_listener
    assert listener is not None, "no active listener — did attach succeed?"
    # QueueListener exposes the internal queue; poll until empty.
    deadline = time.monotonic() + timeout
    while not listener.queue.empty() and time.monotonic() < deadline:
        time.sleep(0.01)
    # Tiny extra wait so the listener's last emit() finishes after
    # the queue empties.
    time.sleep(0.05)


def test_telemetry_log_lands_as_json_post(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("EIDAN_LOG_FORWARD_URL", "https://in.example/log")
    monkeypatch.setenv("EIDAN_LOG_FORWARD_TOKEN", "secret-source-token")

    captured: list = []
    with patch(
        "eidan_backend.log_forwarding.urllib.request.urlopen",
        _patch_urlopen(captured),
    ):
        attach_log_forwarder_if_configured()
        # Mimic exactly what TelemetryEmitter.emit_event does.
        logger = logging.getLogger("eidan_backend.telemetry")
        logger.info(
            "telemetry: %s",
            "node.boot",
            extra={
                "event": "node.boot",
                "node_id": "kasha",
                "node_type": "pi",
                "payload": {"plugins": ["sentry"], "tool_count": 4},
            },
        )
        _wait_for_drain()

    assert len(captured) >= 1
    # Find the boot event among the POSTs (the attach itself logs
    # an "log_forwarding: enabled" line that also lands here).
    bodies = [c["body"] for c in captured]
    boot = next((b for b in bodies if b.get("event") == "node.boot"), None)
    assert boot is not None, f"node.boot not in {bodies}"
    assert boot["node_id"] == "kasha"
    assert boot["node_type"] == "pi"
    assert boot["payload"]["plugins"] == ["sentry"]
    assert boot["message"] == "telemetry: node.boot"
    # Auth header derived from EIDAN_LOG_FORWARD_TOKEN.
    headers = captured[0]["headers"]
    assert headers["Authorization"] == "Bearer secret-source-token"
    assert headers["Content-type"] == "application/json"
    assert captured[0]["url"] == "https://in.example/log"


def test_explicit_headers_override_bearer_token(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Datadog uses DD-API-KEY, not Authorization. Operators with
    a Datadog intake set EIDAN_LOG_FORWARD_HEADERS={"DD-API-KEY":...}
    and the forwarder uses that header. The merge logic puts
    EIDAN_LOG_FORWARD_HEADERS on top of the Bearer token so
    operators can override Authorization too."""
    monkeypatch.setenv("EIDAN_LOG_FORWARD_URL", "https://http-intake.example/api/v2/logs")
    monkeypatch.setenv("EIDAN_LOG_FORWARD_TOKEN", "ignored-because-override")
    monkeypatch.setenv(
        "EIDAN_LOG_FORWARD_HEADERS",
        '{"DD-API-KEY": "dd-secret", "Authorization": "Basic override"}',
    )

    captured: list = []
    with patch(
        "eidan_backend.log_forwarding.urllib.request.urlopen",
        _patch_urlopen(captured),
    ):
        attach_log_forwarder_if_configured()
        logging.getLogger().warning("test")
        _wait_for_drain()

    headers = captured[0]["headers"]
    assert headers["Dd-api-key"] == "dd-secret"
    assert headers["Authorization"] == "Basic override"


def test_exception_traceback_lands_in_post_through_queue_path(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Regression: stdlib :class:`logging.handlers.QueueHandler.prepare`
    clears ``record.exc_info`` / ``exc_text`` to make records
    pickleable for cross-process queues. We use an in-process
    queue, so :class:`_ForwardingQueueHandler` overrides
    :meth:`prepare` to keep both. Without that override, exceptions
    silently never reach the HTTP handler.

    This test calls :func:`logger.exception` (the realistic
    operator path: an error site catches + logs the traceback) and
    asserts the captured POST body's ``exception`` field carries
    the traceback string."""
    monkeypatch.setenv("EIDAN_LOG_FORWARD_URL", "https://in.example/log")

    captured: list = []
    with patch(
        "eidan_backend.log_forwarding.urllib.request.urlopen",
        _patch_urlopen(captured),
    ):
        attach_log_forwarder_if_configured()
        log = logging.getLogger("eidan_backend.telemetry")
        try:
            raise RuntimeError("simulated provider error")
        except RuntimeError:
            log.exception(
                "telemetry: %s",
                "provider.failure",
                extra={
                    "event": "provider.failure",
                    "node_id": "kasha",
                    "node_type": "pi",
                },
            )
        _wait_for_drain()

    # Find the body for our event — attach itself logs a line too.
    failure = next(
        (c["body"] for c in captured if c["body"].get("event") == "provider.failure"),
        None,
    )
    assert failure is not None, f"provider.failure missing from {captured}"
    assert "exception" in failure, (
        "exception field missing — QueueHandler.prepare() likely "
        "stripped exc_info before the listener saw it"
    )
    assert "RuntimeError: simulated provider error" in failure["exception"]
    assert "Traceback" in failure["exception"]


def test_sustained_post_failures_are_rate_limited(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture,
) -> None:
    """A down intake must not flood stderr at one line per record.
    The handler prints the FIRST failure of a streak (so the
    outage is visible) and then suppresses noise until it hits
    the rate-limit interval, then prints a summary line. Pin the
    contract so a future change doesn't restore the per-record
    spam Copilot called out."""
    monkeypatch.setenv("EIDAN_LOG_FORWARD_URL", "https://nowhere.invalid/log")

    import urllib.error

    def always_fails(req, timeout):  # noqa: ARG001
        raise urllib.error.URLError("simulated outage")

    with patch(
        "eidan_backend.log_forwarding.urllib.request.urlopen",
        side_effect=always_fails,
    ):
        attach_log_forwarder_if_configured()
        log = logging.getLogger("eidan_backend.test_failure_flood")
        # 50 failed POSTs — should produce ONE stderr line, not 50,
        # because the rate-limit interval is 100.
        for i in range(50):
            log.warning("burst %d", i)
        _wait_for_drain(timeout=5.0)

    stderr_lines = [
        line for line in capsys.readouterr().err.splitlines()
        if "POST" in line and "failed" in line
    ]
    # First-failure line. NOT 50 lines.
    assert 1 <= len(stderr_lines) <= 2, (
        f"expected 1–2 failure lines (first + maybe boundary), "
        f"got {len(stderr_lines)}:\n" + "\n".join(stderr_lines)
    )


def test_post_recovery_reports_after_failures(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture,
) -> None:
    """When the intake comes back after a failure streak, the
    next successful POST prints a recovery line — operators see
    both the start of the outage and the end."""
    monkeypatch.setenv("EIDAN_LOG_FORWARD_URL", "https://flaky.example/log")

    import urllib.error

    state = {"healthy": False}

    captured: list = []
    mock = MagicMock()
    mock.__enter__.return_value.read.return_value = b""

    def conditional(req, timeout):  # noqa: ARG001
        if not state["healthy"]:
            raise urllib.error.URLError("intake down")
        captured.append({"url": req.full_url})
        return mock

    with patch(
        "eidan_backend.log_forwarding.urllib.request.urlopen",
        side_effect=conditional,
    ):
        attach_log_forwarder_if_configured()
        log = logging.getLogger("eidan_backend.test_recovery")
        # Failing streak.
        for i in range(5):
            log.warning("down %d", i)
        _wait_for_drain(timeout=5.0)
        # Intake comes back.
        state["healthy"] = True
        log.warning("up again")
        _wait_for_drain(timeout=5.0)

    stderr = capsys.readouterr().err
    assert "POST recovered" in stderr, (
        f"expected recovery line in stderr, got:\n{stderr}"
    )


def test_bounded_queue_drops_when_full(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture,
) -> None:
    """When the intake is hanging and the queue fills, records are
    dropped (not OOM'd) and a rate-limited stderr line surfaces
    the loss. This pins the back-pressure contract Copilot asked
    for."""
    monkeypatch.setenv("EIDAN_LOG_FORWARD_URL", "https://in.example/log")
    monkeypatch.setenv("EIDAN_LOG_FORWARD_QUEUE_SIZE", "5")

    # Block the HTTP sender so the queue can't drain. Use a slow
    # urlopen that the listener thread will sit on, letting us
    # overflow the queue from the test thread.
    drain_block = threading.Event()

    def slow_urlopen(req, timeout):  # noqa: ARG001
        drain_block.wait(timeout=5.0)
        m = MagicMock()
        m.__enter__.return_value.read.return_value = b""
        return m

    with patch(
        "eidan_backend.log_forwarding.urllib.request.urlopen",
        side_effect=slow_urlopen,
    ):
        attach_log_forwarder_if_configured()
        # Push 200 records — way past the queue cap of 5 — so the
        # drop counter must fire and the stderr line must surface.
        log = logging.getLogger("eidan_backend.test_overflow")
        for i in range(200):
            log.warning("flood %d", i)
        drain_block.set()  # let the listener drain whatever it has
        _wait_for_drain(timeout=5.0)

    stderr = capsys.readouterr().err
    assert "queue full" in stderr, (
        f"expected drop-warning in stderr, got: {stderr!r}"
    )


def test_post_failure_is_swallowed(monkeypatch: pytest.MonkeyPatch) -> None:
    """A dead intake URL must not raise to the caller. Each log
    call still returns normally; the failure is printed to stderr."""
    monkeypatch.setenv("EIDAN_LOG_FORWARD_URL", "https://nowhere.invalid/log")

    import urllib.error

    def boom(req, timeout):  # noqa: ARG001
        raise urllib.error.URLError("DNS failure")

    with patch(
        "eidan_backend.log_forwarding.urllib.request.urlopen",
        side_effect=boom,
    ):
        attach_log_forwarder_if_configured()
        # Should not raise. Returns normally.
        logging.getLogger().info("test message")
        _wait_for_drain()


def test_level_filter_keeps_intake_quieter(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("EIDAN_LOG_FORWARD_URL", "https://in.example/log")
    monkeypatch.setenv("EIDAN_LOG_FORWARD_LEVEL", "WARNING")

    captured: list = []
    with patch(
        "eidan_backend.log_forwarding.urllib.request.urlopen",
        _patch_urlopen(captured),
    ):
        attach_log_forwarder_if_configured()
        logging.getLogger().info("should be dropped")
        logging.getLogger().warning("should be forwarded")
        _wait_for_drain()

    messages = [c["body"]["message"] for c in captured]
    assert "should be forwarded" in messages
    assert "should be dropped" not in messages


def test_malformed_headers_env_falls_back_to_token_only(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture,
) -> None:
    """A typo in EIDAN_LOG_FORWARD_HEADERS shouldn't take the
    forwarder down — log a warning, ignore the bad value, keep the
    Bearer token from EIDAN_LOG_FORWARD_TOKEN."""
    monkeypatch.setenv("EIDAN_LOG_FORWARD_URL", "https://in.example/log")
    monkeypatch.setenv("EIDAN_LOG_FORWARD_TOKEN", "good-token")
    monkeypatch.setenv("EIDAN_LOG_FORWARD_HEADERS", "this is not json")

    captured: list = []
    with patch(
        "eidan_backend.log_forwarding.urllib.request.urlopen",
        _patch_urlopen(captured),
    ):
        attach_log_forwarder_if_configured()
        logging.getLogger().warning("hello")
        _wait_for_drain()

    headers = captured[0]["headers"]
    assert headers["Authorization"] == "Bearer good-token"

    stderr = capsys.readouterr().err
    assert "EIDAN_LOG_FORWARD_HEADERS" in stderr
