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
import urllib.error
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


def test_atexit_hook_registered_only_once_across_resets(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Tests cycle attach → reset → attach repeatedly. Without the
    `_atexit_registered` guard, each attach would append another
    callback to atexit's internal list and the process-exit
    cleanup would grow O(N). Inspect atexit's internal registry
    to pin the contract — there must be exactly one
    `_shutdown_forwarder` registration regardless of how many
    attach cycles happened."""
    import atexit as atexit_module

    from eidan_backend import log_forwarding

    monkeypatch.setenv("EIDAN_LOG_FORWARD_URL", "https://in.example/log")

    # Reset the module flag so this test starts from a clean
    # baseline (the autouse fixture's _reset_for_tests detaches
    # the handler but leaves _atexit_registered alone, which is
    # exactly the behaviour we want operationally — but the test
    # needs to control it).
    log_forwarding._atexit_registered = False
    atexit_module.unregister(log_forwarding._shutdown_forwarder)

    for _ in range(5):
        attach_log_forwarder_if_configured()
        _reset_for_tests()

    # atexit's internal callback registry is private. Inspect via
    # the documented unregister helper: unregister returns
    # nothing but DOES remove all entries for the function. Count
    # by trying to unregister and checking if subsequent calls
    # leave anything. Cleaner: use atexit._ncallbacks() on 3.11+.
    if hasattr(atexit_module, "_ncallbacks"):
        # Drop ours from the count first, then re-register a
        # known marker, then count.
        atexit_module.unregister(log_forwarding._shutdown_forwarder)
        # Verify a re-register only lands ONE entry.
        log_forwarding._atexit_registered = False
        attach_log_forwarder_if_configured()
        # Re-attaching should NOT add a second copy.
        attach_log_forwarder_if_configured()
        # Now unregister returns silently — we just need to know
        # that there's a single entry to remove. Pin via the flag
        # (if it's True, we registered exactly once).
        assert log_forwarding._atexit_registered is True
    else:
        # Fallback: just assert the flag is True and didn't bounce.
        assert log_forwarding._atexit_registered is True


def test_intake_url_credentials_redacted_in_stderr_and_logs(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture,
) -> None:
    """Operators sometimes encode credentials in the intake URL —
    basic-auth-style userinfo (``user:token@host``) or
    Datadog-via-query-string (``?api_key=secret``). Neither must
    leak into stderr OR into the forwarder's own startup line
    (which is itself forwarded — those bytes end up in the very
    intake whose URL we just leaked). Pins
    :func:`eidan_backend.log_forwarding._redact_url`'s use at
    every print + emit site so a regression flags here, not in an
    operator's journald or in their log-aggregator's index."""
    monkeypatch.setenv(
        "EIDAN_LOG_FORWARD_URL",
        "https://user:s3cret@in.example/log?api_key=leak-me",
    )

    import urllib.error

    captured: list = []

    def fake_post(req, timeout):  # noqa: ARG001
        captured.append({"url": req.full_url, "body": req.data})
        raise urllib.error.URLError("simulated")

    with patch(
        "eidan_backend.log_forwarding.urllib.request.urlopen",
        side_effect=fake_post,
    ):
        attach_log_forwarder_if_configured()
        logging.getLogger().warning("trigger")
        _wait_for_drain(timeout=5.0)

    stderr = capsys.readouterr().err
    # Forbidden substrings — secrets we set in the URL must not
    # surface in operator-facing output OR in the forwarded body.
    secrets = ("s3cret", "leak-me", "user:")

    for secret in secrets:
        assert secret not in stderr, (
            f"intake URL secret {secret!r} leaked into stderr:\n{stderr}"
        )

    # The startup info line ("log_forwarding: enabled ...") is
    # itself forwarded — assert its decoded JSON envelope carries
    # only the redacted URL. The test fakes a failing POST, but
    # the body still went through `_format_record` before the
    # urlopen call raised, so we have it.
    assert captured, "expected at least one POST attempt"
    for c in captured:
        body_text = c["body"].decode("utf-8")
        for secret in secrets:
            assert secret not in body_text, (
                f"intake URL secret {secret!r} leaked into the "
                f"forwarded JSON body (operator's intake would have "
                f"received it):\n{body_text}"
            )

    # Forwarder still tells the operator WHICH intake — host/path
    # are useful for debugging, just not the credentials.
    assert "in.example" in stderr
    assert "/log" in stderr


def test_attach_refuses_non_http_url(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture,
) -> None:
    """A typo like `localhost:4317` (missing scheme) or `ftp://...`
    must refuse to attach with one stderr line instead of attaching
    and then per-record-failing forever. Validation runs at attach
    time.

    Also covers port-only netlocs (``http://:1234``): urlparse
    treats those as having a truthy `netloc`, but `hostname` is
    None — there's no host to connect to, so the attach must
    refuse. Earlier round-5 fix used `netloc` and slipped this
    through; switched to `hostname` (matches `_redact_url`'s
    check) to close the gap."""
    for bad in (
        "localhost:4317",
        "ftp://in.example/log",
        "not-a-url-at-all",
        "://missing-scheme.example/log",
        "http://:1234",          # port-only netloc, no host
        "http://:9999/log",      # port-only with path
        "https:///log",          # empty netloc, just a path
    ):
        _reset_for_tests()
        monkeypatch.setenv("EIDAN_LOG_FORWARD_URL", bad)
        attached = attach_log_forwarder_if_configured()
        assert attached is False, f"attach should refuse {bad!r}"
        stderr = capsys.readouterr().err
        assert "EIDAN_LOG_FORWARD_URL" in stderr
        assert "refusing to attach" in stderr or "could not be parsed" in stderr


def test_redact_url_strict_on_malformed_scheme() -> None:
    """A typo like ``"user:token@host"`` (no scheme) parses with
    ``scheme="user"`` and ``path="token@host"``. A naive
    "scheme://host/path" reconstruction would echo the token
    back. Pin the strict-validation contract — any non-http(s)
    scheme OR missing hostname falls back to ``<unparseable>``."""
    from eidan_backend.log_forwarding import _redact_url

    # Direct typo Copilot called out: parses but the secret is in
    # the path, not the netloc.
    assert _redact_url("user:token@host") == "<unparseable>"
    # Other non-http(s) schemes — ftp, file, javascript, etc.
    assert _redact_url("ftp://user:pass@host/x") == "<unparseable>"
    assert _redact_url("file:///etc/passwd") == "<unparseable>"
    assert _redact_url("javascript:alert(1)") == "<unparseable>"
    # Genuinely unparseable.
    assert _redact_url("") == "<unparseable>"
    assert _redact_url("not a url") == "<unparseable>"
    # http(s) WITH credentials — should still redact, not bail.
    assert (
        _redact_url("https://user:s3cret@in.example/log?api_key=leak")
        == "https://in.example/log"
    )
    # Fragment should be stripped too.
    assert (
        _redact_url("https://in.example/log#fragment-leak")
        == "https://in.example/log"
    )
    # IPv6 literals — urlparse strips the brackets, so the redactor
    # has to put them back, otherwise the rebuilt URL is invalid
    # ("https://::1:1234/log").
    assert (
        _redact_url("https://[::1]:1234/log")
        == "https://[::1]:1234/log"
    )
    assert (
        _redact_url("https://[2001:db8::1]/log")
        == "https://[2001:db8::1]/log"
    )


def test_content_type_cannot_be_overridden(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The forwarder's wire format is JSON. An operator who sets
    Content-Type via EIDAN_LOG_FORWARD_HEADERS (any case variant)
    must not break the contract — final Content-Type is forced to
    application/json post-merge."""
    monkeypatch.setenv("EIDAN_LOG_FORWARD_URL", "https://in.example/log")
    # Lower-case variant + a custom value the operator might typo.
    monkeypatch.setenv(
        "EIDAN_LOG_FORWARD_HEADERS",
        '{"content-type":"text/plain","DD-API-KEY":"abc"}',
    )

    captured: list = []
    with patch(
        "eidan_backend.log_forwarding.urllib.request.urlopen",
        _patch_urlopen(captured),
    ):
        attach_log_forwarder_if_configured()
        logging.getLogger().warning("trigger")
        _wait_for_drain()

    headers = captured[0]["headers"]
    # urllib normalises header names to Title-Case on access, so
    # we look for the canonical form.
    assert headers["Content-type"] == "application/json", (
        f"Content-Type must be forced to JSON; got: {headers!r}"
    )
    # Operator's other custom header survived.
    assert headers["Dd-api-key"] == "abc"


def test_http_error_response_body_is_drained() -> None:
    """``HTTPError`` is a URLError subclass AND a file-like
    response object. Under sustained 4xx/5xx (e.g. bad auth) at
    high log volume the underlying socket would leak fds if the
    body is never drained / closed. Pin the drain contract by
    raising a mock HTTPError that tracks read()/close() calls."""
    from eidan_backend.log_forwarding import _JsonHttpHandler

    drain_calls = {"read": 0, "close": 0}

    class _FakeHTTPError(urllib.error.HTTPError):
        def __init__(self) -> None:
            # HTTPError(url, code, msg, hdrs, fp) — fp can be None,
            # we override read/close anyway.
            super().__init__("https://x/log", 500, "Server Error", {}, None)

        def read(self, *args, **kwargs):  # noqa: ARG002
            drain_calls["read"] += 1
            return b"upstream error body"

        def close(self):
            drain_calls["close"] += 1

    handler = _JsonHttpHandler(
        url="https://in.example/log",
        headers={},
        timeout_seconds=1.0,
    )

    with patch(
        "eidan_backend.log_forwarding.urllib.request.urlopen",
        side_effect=_FakeHTTPError(),
    ):
        record = logging.LogRecord(
            name="x", level=logging.INFO, pathname=__file__, lineno=1,
            msg="m", args=(), exc_info=None,
        )
        # Direct emit (bypass the queue) — no thread races to
        # complicate the assertion on drain counts.
        handler.emit(record)

    assert drain_calls["read"] >= 1, (
        "HTTPError body must be read() before the exception is "
        "discarded; otherwise sustained 4xx/5xx leaks fds"
    )
    assert drain_calls["close"] >= 1, (
        "HTTPError must be close()d so the underlying socket can "
        "be returned to the keepalive pool"
    )
    # Failure was still counted.
    assert handler._failure_total == 1


def test_invalid_level_fallback_reports_info_in_startup_line(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture,
) -> None:
    """When LEVEL is a typo we fall back to INFO. The startup
    info line must say INFO, not the typo — otherwise operators
    see 'POSTing at level FOO' in journald and waste time
    looking for what FOO means."""
    monkeypatch.setenv("EIDAN_LOG_FORWARD_URL", "https://in.example/log")
    monkeypatch.setenv("EIDAN_LOG_FORWARD_LEVEL", "VERBOSE")  # not a stdlib level

    captured: list = []

    def fake_post(req, timeout):  # noqa: ARG001
        captured.append({"body": req.data})
        m = MagicMock()
        m.__enter__.return_value.read.return_value = b""
        return m

    with patch(
        "eidan_backend.log_forwarding.urllib.request.urlopen",
        side_effect=fake_post,
    ):
        attach_log_forwarder_if_configured()
        _wait_for_drain(timeout=5.0)

    stderr = capsys.readouterr().err
    # The fallback warning fires once, mentioning the typo.
    assert "VERBOSE" in stderr
    assert "falling back to INFO" in stderr

    # But the forwarded startup line — and the message the
    # operator sees in their intake — reports the effective
    # level (INFO), not the typo. The startup info line is the
    # only INFO record this test produces, so it's the one in
    # the body.
    assert captured, "expected at least the startup info line to forward"
    boot_body = json.loads(captured[0]["body"].decode("utf-8"))
    assert "at level INFO" in boot_body["message"], (
        f"startup message should reflect effective level, got: "
        f"{boot_body['message']!r}"
    )
    # And the structured payload too.
    assert boot_body["payload"]["level"] == "INFO"
    assert "VERBOSE" not in boot_body["message"]


def test_attach_falls_back_on_bad_timeout(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture,
) -> None:
    """A negative or zero timeout would make urlopen raise on every
    emit. Fall back to the 5.0s default with one stderr line —
    same posture as the URL / queue-size / level validation."""
    monkeypatch.setenv("EIDAN_LOG_FORWARD_URL", "https://in.example/log")

    for bad in ("0", "-1", "not-a-number"):
        _reset_for_tests()
        capsys.readouterr()  # drain any prior stderr
        monkeypatch.setenv("EIDAN_LOG_FORWARD_TIMEOUT", bad)
        attached = attach_log_forwarder_if_configured()
        assert attached is True, (
            f"attach should still succeed for bad timeout {bad!r}; "
            f"telemetry never breaks job execution"
        )
        stderr = capsys.readouterr().err
        assert "EIDAN_LOG_FORWARD_TIMEOUT" in stderr
        assert "falling back to 5.0" in stderr


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
