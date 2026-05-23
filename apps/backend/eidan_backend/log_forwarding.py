# SPDX-License-Identifier: AGPL-3.0-or-later
"""Optional external log forwarding — env-configured, zero-fork.

When ``EIDAN_LOG_FORWARD_URL`` is set, this module attaches a
non-blocking JSON-over-HTTP handler to the root logger at boot.
Every ``logging.info()`` (including the telemetry mirror lines
fired by :mod:`eidan_backend.telemetry`) POSTs as one JSON
object to the configured URL.

Designed to land BetterStack (Logtail), Datadog, Axiom,
Honeycomb, and any custom HTTP intake without the operator
having to drop a Python file anywhere on disk — per the no-fork
distribution model (``docs/018``), the operator's only surface
is ``/etc/eidan/eidan.env``.

Env vars:

- ``EIDAN_LOG_FORWARD_URL`` — required. The HTTP intake URL.
  Setting this enables the forwarder; unset leaves the root
  logger untouched.
- ``EIDAN_LOG_FORWARD_TOKEN`` — optional. When set, sent as
  ``Authorization: Bearer <token>`` (the common BetterStack
  /Axiom /Honeycomb shape).
- ``EIDAN_LOG_FORWARD_HEADERS`` — optional JSON-encoded dict
  of extra headers. Escape hatch for non-Bearer auth (e.g.
  Datadog: ``{"DD-API-KEY": "..."}``) or custom routing
  headers. Merged on top of any ``Authorization`` from
  ``EIDAN_LOG_FORWARD_TOKEN``.
- ``EIDAN_LOG_FORWARD_LEVEL`` — optional. Minimum level to
  forward, default ``INFO``. Set to ``WARNING`` to keep the
  intake quieter.
- ``EIDAN_LOG_FORWARD_TIMEOUT`` — optional float seconds for
  the HTTP POST, default ``5.0``. Forwarder swallows on
  timeout (logs to stderr) so a slow intake doesn't drag the
  process.

JSON envelope per record::

    {
      "ts":              "2026-05-24T08:30:00.123+00:00",
      "level":           "INFO",
      "logger":          "eidan_backend.telemetry",
      "message":         "telemetry: node.boot",
      "event":           "node.boot",         # from extra=
      "node_id":         "kasha",             # from extra=
      "node_type":       "pi",                # from extra=
      "conversation_id": null,                # from extra=
      "payload":         {...}                # from extra=
    }

Vendor-specific shape transformations (Loki's ``streams[]``
envelope, e.g.) are the operator's concern — point eidan at a
Vector / Fluent Bit relay if your intake wants a different
shape. The flat object above is what BetterStack and Datadog
natively accept.

Non-blocking by design: a :class:`logging.handlers.QueueHandler`
sits in front of the HTTP sender, so ``logger.info(...)``
returns immediately even when the intake is slow or down. A
background thread (the queue listener) drains the queue and
POSTs. Failures inside the sender print to stderr and the
record is dropped — telemetry must never break job execution
(same posture as :mod:`eidan_backend.telemetry`).
"""

from __future__ import annotations

import atexit
import json
import logging
import logging.handlers
import os
import queue
import sys
import urllib.error
import urllib.request
from datetime import UTC, datetime
from typing import Any

logger = logging.getLogger(__name__)


# Module-level handle on the active forwarder so tests (and
# operators inspecting at runtime) can probe it. Boot writes
# this once; we don't expect a second attach in the same process.
_active_listener: logging.handlers.QueueListener | None = None
_active_handler: logging.Handler | None = None


# ---------------------------------------------------------------------------
# JSON envelope
# ---------------------------------------------------------------------------
#
# Fields the telemetry emitter sets via extra=. We pull each one off
# the LogRecord with getattr so records that didn't go through the
# telemetry path (e.g. raw stdlib logs from uvicorn, asyncpg) still
# format cleanly — those fields just come out None.
_TELEMETRY_EXTRAS: tuple[str, ...] = (
    "event",
    "node_id",
    "node_type",
    "conversation_id",
    "payload",
)


def _format_record(record: logging.LogRecord) -> dict[str, Any]:
    envelope: dict[str, Any] = {
        "ts": datetime.fromtimestamp(record.created, tz=UTC).isoformat(),
        "level": record.levelname,
        "logger": record.name,
        "message": record.getMessage(),
    }
    for key in _TELEMETRY_EXTRAS:
        value = getattr(record, key, None)
        if value is not None:
            envelope[key] = value
    if record.exc_info:
        # logging.Formatter().formatException returns a multi-line
        # traceback string; ship it as one field rather than try to
        # restructure into a list — most intakes display it cleanly.
        envelope["exception"] = logging.Formatter().formatException(record.exc_info)
    return envelope


# ---------------------------------------------------------------------------
# HTTP sender — does the actual urlopen.
# ---------------------------------------------------------------------------


class _JsonHttpHandler(logging.Handler):
    """Direct HTTP/JSON POST handler. Synchronous emit().

    Wrap with :class:`logging.handlers.QueueListener` so the
    sync POST runs on a background thread, not the caller's
    thread.
    """

    def __init__(
        self,
        *,
        url: str,
        headers: dict[str, str],
        timeout_seconds: float,
    ) -> None:
        super().__init__()
        self._url = url
        self._headers = {"Content-Type": "application/json", **headers}
        self._timeout = timeout_seconds

    def emit(self, record: logging.LogRecord) -> None:
        # Swallow every failure mode — logging-handler exceptions
        # propagate to the original logger.error / logger.info call
        # otherwise, and we promised telemetry never breaks the
        # caller. logging's own `handleError` is the documented
        # escape hatch; we just print and move on.
        try:
            envelope = _format_record(record)
            body = json.dumps(envelope).encode("utf-8")
            req = urllib.request.Request(
                self._url,
                data=body,
                method="POST",
                headers=self._headers,
            )
            with urllib.request.urlopen(req, timeout=self._timeout) as resp:
                # Drain the response so the connection can be reused.
                resp.read()
        except (urllib.error.URLError, OSError, TimeoutError) as exc:
            # Most operational failures land here (DNS, network,
            # auth-rejection 4xx via HTTPError which subclasses
            # URLError). Print rather than log — re-logging via
            # the same root logger would recurse through this
            # very handler.
            print(
                f"[log_forwarding] POST to {self._url} failed: {exc}",
                file=sys.stderr,
            )
        except Exception as exc:  # noqa: BLE001 — must not propagate
            print(
                f"[log_forwarding] unexpected error: {exc!r}",
                file=sys.stderr,
            )


# ---------------------------------------------------------------------------
# Public entry point — called once at boot.
# ---------------------------------------------------------------------------


def attach_log_forwarder_if_configured() -> bool:
    """Inspect env, attach the forwarder if ``EIDAN_LOG_FORWARD_URL`` is set.

    Returns ``True`` when a forwarder was attached, ``False`` when
    no URL was configured (the no-op path operators get by default).
    Idempotent: calling twice is a no-op (the first attach wins);
    callers shouldn't need to worry about boot ordering.

    The handler attaches to the **root logger** so it picks up
    every module's output, not just :mod:`eidan_backend.telemetry`.
    Operators who want it quieter set
    ``EIDAN_LOG_FORWARD_LEVEL=WARNING`` to filter at the handler.
    """
    global _active_listener, _active_handler

    if _active_listener is not None:
        # Already attached. Silent no-op — re-attach loops would be
        # subtle to debug.
        return True

    url = os.environ.get("EIDAN_LOG_FORWARD_URL")
    if not url:
        return False

    headers: dict[str, str] = {}
    token = os.environ.get("EIDAN_LOG_FORWARD_TOKEN")
    if token:
        headers["Authorization"] = f"Bearer {token}"

    extra_headers_raw = os.environ.get("EIDAN_LOG_FORWARD_HEADERS")
    if extra_headers_raw:
        try:
            extra = json.loads(extra_headers_raw)
            if not isinstance(extra, dict):
                raise ValueError("must be a JSON object")
            # Merge extras on top so an Authorization key in the
            # JSON overrides the Bearer token (escape hatch
            # the docstring promises).
            headers.update({str(k): str(v) for k, v in extra.items()})
        except (ValueError, TypeError) as exc:
            print(
                f"[log_forwarding] EIDAN_LOG_FORWARD_HEADERS is not "
                f"valid JSON object — ignored: {exc}",
                file=sys.stderr,
            )

    level_name = os.environ.get("EIDAN_LOG_FORWARD_LEVEL", "INFO").upper()
    level = logging.getLevelName(level_name)
    if not isinstance(level, int):
        print(
            f"[log_forwarding] EIDAN_LOG_FORWARD_LEVEL={level_name!r} "
            f"unrecognised — falling back to INFO",
            file=sys.stderr,
        )
        level = logging.INFO

    timeout_raw = os.environ.get("EIDAN_LOG_FORWARD_TIMEOUT", "5.0")
    try:
        timeout_seconds = float(timeout_raw)
    except ValueError:
        print(
            f"[log_forwarding] EIDAN_LOG_FORWARD_TIMEOUT={timeout_raw!r} "
            f"not a number — falling back to 5.0",
            file=sys.stderr,
        )
        timeout_seconds = 5.0

    http_handler = _JsonHttpHandler(
        url=url,
        headers=headers,
        timeout_seconds=timeout_seconds,
    )
    http_handler.setLevel(level)

    # Queue + listener so logger.info() doesn't block on the POST.
    # respect_handler_level=True so the http_handler.setLevel above
    # actually filters (otherwise the QueueListener would re-emit
    # everything regardless of the handler's own level).
    log_queue: queue.SimpleQueue[Any] = queue.SimpleQueue()
    queue_handler = logging.handlers.QueueHandler(log_queue)
    queue_handler.setLevel(level)
    listener = logging.handlers.QueueListener(
        log_queue, http_handler, respect_handler_level=True
    )
    listener.start()

    root = logging.getLogger()
    root.addHandler(queue_handler)
    # Don't lower the root logger level — operators set their root
    # level via uvicorn's --log-level / standard logging config.
    # This just ensures the forwarder receives at least INFO from
    # the root pipeline.
    if root.level == logging.NOTSET or root.level > level:
        root.setLevel(level)

    _active_listener = listener
    _active_handler = queue_handler

    # Stop the listener at process exit so the background thread
    # joins cleanly. Best-effort; if Python is exiting hard there's
    # nothing we can do.
    atexit.register(_shutdown_forwarder)

    logger.info(
        "log_forwarding: enabled — POSTing to %s at level %s",
        url,
        level_name,
        extra={"event": "log_forwarding.enabled", "url": url, "level": level_name},
    )
    return True


def _shutdown_forwarder() -> None:
    """Cleanly stop the background listener thread. Idempotent."""
    global _active_listener, _active_handler
    if _active_listener is None:
        return
    try:
        _active_listener.stop()
    except Exception:  # noqa: BLE001 — best-effort teardown
        pass
    if _active_handler is not None:
        try:
            logging.getLogger().removeHandler(_active_handler)
        except Exception:  # noqa: BLE001
            pass
    _active_listener = None
    _active_handler = None


# Exposed for tests that need to reset state between cases.
def _reset_for_tests() -> None:
    _shutdown_forwarder()
