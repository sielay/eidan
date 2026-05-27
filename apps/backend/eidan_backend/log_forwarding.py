# SPDX-License-Identifier: AGPL-3.0-or-later
"""Optional external log forwarding — env-configured, zero-fork.

When ``EIDAN_LOG_FORWARD_URL`` is set, this module attaches a
non-blocking JSON-over-HTTP handler to the root logger at boot.
Each log record that **reaches the handler** — i.e. passes both
the root logger's effective level AND the forwarder's
``EIDAN_LOG_FORWARD_LEVEL`` filter — POSTs as one JSON object to
the configured URL. The handler is attached to the root logger,
so any logger that propagates to root (the stdlib default,
including the telemetry mirror lines fired by
:mod:`eidan_backend.telemetry`) is in scope; loggers configured
with ``propagate=False`` are not. The forwarder deliberately
does not mutate the root logger's level — to forward INFO when
uvicorn defaults root to WARNING, raise root explicitly via root
logger configuration or, in the standard HTTP deployment, via
``EIDAN_HTTP_LOG_LEVEL`` as described below.

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
- ``EIDAN_LOG_FORWARD_LEVEL`` — optional. Minimum level the
  forwarder's handler accepts, default ``INFO``. The
  **effective** forwarded level is ``max(root_logger_level,
  EIDAN_LOG_FORWARD_LEVEL)`` because the root logger's level
  filters records before they reach any handler. In the
  standard ``eidan-backend-http`` deployment the root logger's
  level comes from ``EIDAN_HTTP_LOG_LEVEL`` (default ``info``)
  via :func:`eidan_backend.http.server._build_log_config`, so
  the env-only operator surface is intact — just bump
  ``EIDAN_HTTP_LOG_LEVEL`` and the forwarder picks it up. This
  module deliberately doesn't mutate root itself, to avoid
  surprising other handlers wired by uvicorn / the operator.
- ``EIDAN_LOG_FORWARD_TIMEOUT`` — optional float seconds for
  the HTTP POST, default ``5.0``. Forwarder swallows on
  timeout (logs to stderr) so a slow intake doesn't drag the
  process.
- ``EIDAN_LOG_FORWARD_QUEUE_SIZE`` — optional bound on the
  in-process buffer, default ``10000``. When the intake stalls
  (network blip, auth rejection) the listener thread can't
  drain; the queue fills up to this cap and further records
  are dropped. A single-line stderr warning fires on the
  **first** drop of a streak and then every 100 drops, with a
  "queue accepted" line when the listener catches up — so brief
  queue fills are immediately visible and sustained outages
  don't flood the log. Operators who'd rather block-then-OOM
  than drop can raise the bound arbitrarily, but the
  back-pressure-to-drop posture matches the "telemetry never
  breaks job execution" doctrine.

JSON envelope per record (telemetry extras are **only included
when non-None** — a node-level event omits ``conversation_id``;
a turn-bound event includes it as a UUID string)::

    {
      "ts":      "2026-05-24T08:30:00.123+00:00",
      "level":   "INFO",
      "logger":  "eidan_backend.telemetry",
      "message": "telemetry: node.boot",
      "event":   "node.boot",           # from extra=
      "node_id": "kasha",               # from extra=
      "node_type": "pi",                # from extra=
      "payload": {...}                  # from extra=
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
import copy
import json
import logging
import logging.handlers
import os
import queue
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import UTC, datetime
from typing import Any

logger = logging.getLogger(__name__)


# Module-level handle on the active forwarder so tests (and
# operators inspecting at runtime) can probe it. Boot writes
# this once; we don't expect a second attach in the same process.
_active_listener: logging.handlers.QueueListener | None = None
_active_handler: logging.Handler | None = None

# atexit's registration list grows unbounded if we re-register every
# attach (tests cycle attach → reset → attach). Register once per
# process; the hook is a no-op when no listener is active anyway.
_atexit_registered = False


def _redact_url(url: str) -> str:
    """Return ``scheme://host[:port]/path`` only — strip userinfo, query,
    and fragment.

    Operators sometimes encode credentials in the intake URL:
    ``https://user:token@in.example/log`` (basic auth-style) or
    ``https://in.example/log?api_key=secret`` (Datadog-on-AWS via
    query string). Both would otherwise leak into stderr ("POST to
    <url> failed") AND into the intake itself (the startup log
    line is itself forwarded). Strip both at every print site so
    secrets stay where the operator put them.

    **Strict** — only returns a redacted form when both scheme is
    http/https AND hostname is present. Anything else falls back
    to ``"<unparseable>"``. Reason: a typo like
    ``"user:token@host"`` (no scheme) parses with
    ``scheme="user"`` and ``path="token@host"`` — reconstructing
    naively would echo the token back to stderr. Better to print
    nothing recognisable than to leak.

    IPv6 literals are bracketed on the way back out
    (``urlparse('https://[::1]:1234/log').hostname`` is the bare
    ``"::1"``, which would otherwise serialise as the invalid
    ``"https://::1:1234/log"``).

    Bad ports (e.g. ``"https://in.example:abc/log"``) parse OK
    but raise ``ValueError`` on the ``parsed.port`` lazy
    attribute. Treated as unparseable rather than crashing the
    caller — :func:`attach_log_forwarder_if_configured` calls
    this from its stderr-warning path, and a crash there would
    bubble out at boot.
    """
    try:
        parsed = urllib.parse.urlparse(url)
    except (ValueError, AttributeError):
        return "<unparseable>"
    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        return "<unparseable>"
    try:
        port = parsed.port
    except ValueError:
        return "<unparseable>"
    host = parsed.hostname
    if ":" in host:
        host = f"[{host}]"
    if port is not None:
        host = f"{host}:{port}"
    return f"{parsed.scheme}://{host}{parsed.path}"


# ---------------------------------------------------------------------------
# JSON envelope
# ---------------------------------------------------------------------------
#
# **Strict allow-list** of top-level keys the forwarder copies from
# the LogRecord's `extra=` kwargs into the outbound JSON envelope.
# Any other `extra=` key the emitter sets (e.g. ad-hoc fields like
# ``interval_seconds``, ``type``, ``raw_value``) is **silently
# dropped** — by design: the wire contract is a small fixed shape so
# operators can write Datadog / BetterStack search rules against
# stable attribute names. Per-event detail belongs in ``payload``
# (a nested dict), not as a sibling top-level key. Telemetry emit
# sites in :mod:`eidan_backend.telemetry` follow this convention.
#
# Each field is pulled off the LogRecord with getattr so records
# that didn't go through the telemetry path (raw stdlib logs from
# uvicorn, asyncpg) still format cleanly — the fields just come
# out None and are then omitted from the envelope.
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
    # Exception traceback. `exc_info` is the raw tuple; some upstream
    # paths (a Formatter that already ran, or a non-forwarding queue
    # handler that pre-formatted) may have already populated
    # `exc_text` and may have cleared `exc_info`. Check both.
    if getattr(record, "exc_text", None):
        envelope["exception"] = record.exc_text
    elif record.exc_info:
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

    Failure noise is rate-limited: the first failure of a streak
    prints (so operators see "the intake just went down"), then
    further failures are quietly counted and one summary line
    prints for every ``_FAILURE_REPORT_INTERVAL`` additional
    failures. On the next successful POST the counter resets, so
    a transient blip-then-recovery surfaces a single line both
    ways instead of one line per dropped record.
    """

    # Print every Nth failure during a sustained outage. Matches
    # the cadence in :class:`_ForwardingQueueHandler` so the two
    # rate-limit surfaces feel consistent in journald.
    _FAILURE_REPORT_INTERVAL = 100

    def __init__(
        self,
        *,
        url: str,
        headers: dict[str, str],
        timeout_seconds: float,
    ) -> None:
        super().__init__()
        self._url = url
        # Redacted form for any user-facing print (stderr, journald).
        # See :func:`_redact_url` for why — credentials in the URL
        # shouldn't leak into logs.
        self._safe_url = _redact_url(url)
        # Force Content-Type to application/json regardless of what
        # the operator-supplied EIDAN_LOG_FORWARD_HEADERS set. Strip
        # case-insensitive variants first so an operator using
        # ``content-type`` (lowercase) doesn't sneak past a naive
        # dict merge. The forwarder's wire format is JSON; an
        # operator who needs a different MIME type for their intake
        # has misconfigured something.
        operator_headers = {
            k: v for k, v in headers.items() if k.lower() != "content-type"
        }
        self._headers = {**operator_headers, "Content-Type": "application/json"}
        self._timeout = timeout_seconds
        self._failure_total = 0
        self._failures_since_last_report = 0

    def emit(self, record: logging.LogRecord) -> None:
        # Swallow every failure mode — logging-handler exceptions
        # propagate to the original logger.error / logger.info call
        # otherwise, and we promised telemetry never breaks the
        # caller. logging's own `handleError` is the documented
        # escape hatch; we just print and move on (rate-limited).
        try:
            envelope = _format_record(record)
            # `default=str` lets the forwarder tolerate user-supplied
            # values inside `payload` that aren't natively
            # JSON-serialisable — UUID, datetime, exception, Decimal,
            # Path, etc. Without it, `json.dumps` raises TypeError on
            # the whole envelope and the record is dropped as an
            # "unexpected error", which is exactly the wrong outcome
            # for the realistic case (telemetry mirror line fires
            # BEFORE the DB-side `json.dumps(payload)` validation in
            # :meth:`TelemetryEmitter.emit_event`, so a bad value
            # surfaces here first and would silently kill the
            # diagnostic the operator needs). Stringifying unknown
            # values is lossy but visible — the operator sees
            # ``"<uuid>"`` in the intake instead of nothing.
            body = json.dumps(envelope, default=str).encode("utf-8")
            req = urllib.request.Request(
                self._url,
                data=body,
                method="POST",
                headers=self._headers,
            )
            with urllib.request.urlopen(req, timeout=self._timeout) as resp:
                # Drain the response so the connection can be reused.
                resp.read()
        except urllib.error.HTTPError as exc:
            # HTTPError is a URLError subclass AND a file-like
            # response object — the 4xx/5xx body is on the
            # exception itself. The `urlopen(...) as resp:` context
            # manager above never runs for the error path, so the
            # underlying socket stays alive until the exception is
            # garbage-collected. Under sustained auth-rejection at
            # high log volume that leaks file descriptors; the
            # urllib3 / requests stacks special-case this for the
            # same reason. Best-effort drain + close before we
            # report.
            try:
                exc.read()
            except Exception:  # noqa: BLE001 — body may already be drained
                pass
            try:
                exc.close()
            except Exception:  # noqa: BLE001
                pass
            self._report_failure(exc)
        except (urllib.error.URLError, OSError, TimeoutError) as exc:
            # Most non-HTTP operational failures land here (DNS,
            # network, timeout). Print rather than log — re-logging
            # via the same root logger would recurse through this
            # very handler.
            self._report_failure(exc)
        except Exception as exc:  # noqa: BLE001 — must not propagate
            # Genuinely unexpected — JSON serialisation crash, a
            # bug in _format_record, etc. Treat as a failure for
            # rate-limiting too so a record that always raises
            # doesn't itself flood stderr.
            self._report_failure(exc, prefix="unexpected error")
        else:
            # POST succeeded. If we were in a failing streak, surface
            # the recovery so operators see both edges of an outage —
            # then reset the counter so the next failure batch starts
            # with a fresh "first failure" print.
            if self._failures_since_last_report:
                print(
                    f"[log_forwarding] POST recovered after "
                    f"{self._failures_since_last_report} failure(s) "
                    f"(total during this process: {self._failure_total})",
                    file=sys.stderr,
                )
            self._failures_since_last_report = 0

    def _report_failure(self, exc: BaseException, *, prefix: str = "") -> None:
        self._failure_total += 1
        self._failures_since_last_report += 1
        # Print on the FIRST failure (so an operator sees the
        # outage start) and then every Nth.
        should_report = (
            self._failures_since_last_report == 1
            or self._failures_since_last_report % self._FAILURE_REPORT_INTERVAL == 0
        )
        if should_report:
            label = f"{prefix}: " if prefix else ""
            count = (
                f" (total during this process: {self._failure_total})"
                if self._failures_since_last_report > 1
                else ""
            )
            print(
                f"[log_forwarding] POST to {self._safe_url} failed{count}: "
                f"{label}{exc}",
                file=sys.stderr,
            )


# ---------------------------------------------------------------------------
# Queue handler — preserves exc_info + bounded with drop-on-full.
# ---------------------------------------------------------------------------


# Default queue size. At ~10/s log volume that's ~17 minutes of buffer
# before back-pressure kicks in — generous for a transient intake
# outage, small enough that an actually-dead intake can't OOM the
# process. Override via EIDAN_LOG_FORWARD_QUEUE_SIZE.
_DEFAULT_QUEUE_SIZE = 10_000


class _ForwardingQueueHandler(logging.handlers.QueueHandler):
    """In-process queue handler tuned for the forwarding pipeline.

    Two deltas from the stdlib :class:`logging.handlers.QueueHandler`:

    1. **Preserves ``exc_info`` / ``exc_text`` / ``stack_info``
       while still dropping ``args`` references.** The base
       ``prepare()`` does two distinct things — it pre-formats
       the message (``record.msg = record.getMessage()``) and
       clears ``args`` (release references to potentially large
       argument objects), AND it strips the exc/stack fields
       for pickleability. We need the former (a bounded 10k
       queue holding 50-kB arg objects per record is a real
       memory pressure during an intake outage) but not the
       latter (we use an in-process queue — picklability is
       irrelevant — and the HTTP handler relies on
       ``exc_info``/``exc_text`` to forward tracebacks).

    2. **Drops on full queue without the noisy stderr traceback
       the base ``handleError`` emits.** A bounded queue +
       drop-on-full is the right back-pressure shape for
       telemetry (lose data before crashing or eating memory),
       but the base behaviour of writing a multi-line traceback
       per dropped record floods stderr the moment the intake
       slows. Replaced with the same first-of-streak +
       every-Nth + recovery cadence :class:`_JsonHttpHandler`
       uses for HTTP failures — operators see brief queue
       fills immediately (not after 99 silent drops) and see
       both edges of a sustained outage without flooding the
       log.
    """

    _DROP_REPORT_INTERVAL = 100

    def __init__(self, log_queue: queue.Queue[logging.LogRecord]) -> None:
        super().__init__(log_queue)
        self._dropped_total = 0
        self._dropped_since_last_report = 0

    def prepare(self, record: logging.LogRecord) -> logging.LogRecord:
        # Shallow copy so other handlers in the chain (stdout,
        # journald) get the unmodified record — same precaution
        # the stdlib impl takes (bpo-35726).
        rec = copy.copy(record)
        # Pre-format the message and drop arg references — matches
        # the stdlib's prepare() optimisation. Without this, a
        # ``logger.info("processed %s", big_payload)`` call holds
        # the original ``big_payload`` alive inside the queue for
        # the lifetime of the backlog. Under a 10k-deep queue
        # during an intake outage that's a real memory hit.
        rec.msg = rec.getMessage()
        rec.args = None
        # exc_info / exc_text / stack_info are NOT cleared here —
        # see the class docstring for why (in-process queue, HTTP
        # handler needs the traceback fields intact).
        return rec

    def emit(self, record: logging.LogRecord) -> None:
        try:
            self.enqueue(self.prepare(record))
        except queue.Full:
            # Drop. Don't propagate; don't hit self.handleError
            # (which would write the full Full traceback per
            # record — flooding stderr is worse than losing logs).
            self._report_drop()
            return
        except Exception:  # noqa: BLE001 — must not propagate
            # Any other exception during enqueue (e.g. malformed
            # record). Fall back to the stdlib escape hatch but
            # don't let it bubble up.
            self.handleError(record)
            return
        # Successful enqueue. If we were in a drop streak, surface
        # the recovery so operators see both edges of a queue-full
        # episode — then reset the counter so the next streak starts
        # with a fresh "first drop" print. Mirrors the HTTP path's
        # success branch.
        if self._dropped_since_last_report:
            print(
                f"[log_forwarding] queue accepted after "
                f"{self._dropped_since_last_report} dropped record(s) "
                f"(total dropped this process: {self._dropped_total})",
                file=sys.stderr,
            )
            self._dropped_since_last_report = 0

    def _report_drop(self) -> None:
        self._dropped_total += 1
        self._dropped_since_last_report += 1
        # Print on the FIRST drop of a streak (so the operator sees
        # the queue fill the moment it happens, not 99 records later)
        # and then every Nth. Matches _JsonHttpHandler._report_failure.
        should_report = (
            self._dropped_since_last_report == 1
            or self._dropped_since_last_report % self._DROP_REPORT_INTERVAL == 0
        )
        if should_report:
            count = (
                f" (total dropped this process: {self._dropped_total})"
                if self._dropped_since_last_report > 1
                else ""
            )
            print(
                f"[log_forwarding] queue full — record dropped{count}",
                file=sys.stderr,
            )


# ---------------------------------------------------------------------------
# Public entry point — called once at boot.
# ---------------------------------------------------------------------------


def attach_log_forwarder_if_configured() -> bool:
    """Inspect env, attach the forwarder if ``EIDAN_LOG_FORWARD_URL`` is set.

    Returns ``True`` when a forwarder was attached. Returns
    ``False`` for either of:

    - ``EIDAN_LOG_FORWARD_URL`` is unset — the no-op path
      operators get by default.
    - ``EIDAN_LOG_FORWARD_URL`` is set but doesn't parse as an
      absolute http(s) URL with a host. The handler stays
      detached and one stderr line surfaces the typo. Other
      malformed knobs (``EIDAN_LOG_FORWARD_TIMEOUT``,
      ``EIDAN_LOG_FORWARD_LEVEL``, ``EIDAN_LOG_FORWARD_HEADERS``,
      ``EIDAN_LOG_FORWARD_QUEUE_SIZE``) **fall back to defaults
      with a stderr warning and still attach** — only the URL
      itself is a hard requirement.

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

    # Validate up front so a typo'd / non-HTTP URL refuses to attach
    # with one stderr line instead of attaching successfully and
    # then failing per-record forever. The redacted form is fine for
    # the warning — it's only invalid in shape, but it may still
    # contain secrets if the operator's mis-formatted URL has them.
    #
    # `parsed.port` is included in the parse-time try: it's a lazy
    # attribute that raises ValueError on shapes like
    # ``https://in.example:abc/log`` — folding the check in here
    # means the same "refuse to attach" path catches the typo
    # instead of letting it crash later inside the handler. Reuses
    # :func:`_redact_url` for the same reason (it also has to
    # tolerate bad ports for its stderr-warning callers).
    try:
        parsed = urllib.parse.urlparse(url)
        _ = parsed.port  # trigger lazy parse so bad ports raise now
    except ValueError as exc:
        print(
            f"[log_forwarding] EIDAN_LOG_FORWARD_URL={_redact_url(url)!r} "
            f"could not be parsed — refusing to attach: {exc}",
            file=sys.stderr,
        )
        return False
    # `parsed.hostname` rather than `parsed.netloc` — the latter
    # is truthy for shapes like `http://:1234` (port-only netloc)
    # where there's no actual host to connect to. urlparse returns
    # hostname=None in that case, which is the real signal.
    # Matches :func:`_redact_url`'s hostname check; the two
    # validators agree on what "has a host" means.
    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        print(
            f"[log_forwarding] EIDAN_LOG_FORWARD_URL={_redact_url(url)!r} "
            f"must be an absolute http(s) URL with a host — refusing "
            f"to attach",
            file=sys.stderr,
        )
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
    # Prefer getLevelNamesMapping() (3.11+, single-purpose name→int)
    # over getLevelName() — the latter's dual int↔str API trips
    # readers, even though it does return an int for known names.
    level = logging.getLevelNamesMapping().get(level_name)
    if level is None:
        print(
            f"[log_forwarding] EIDAN_LOG_FORWARD_LEVEL={level_name!r} "
            f"unrecognised — falling back to INFO",
            file=sys.stderr,
        )
        level = logging.INFO
        # Sync the name too so the startup info line below (and its
        # forwarded payload) reflects the *effective* level rather
        # than the operator's typo.
        level_name = "INFO"

    timeout_raw = os.environ.get("EIDAN_LOG_FORWARD_TIMEOUT", "5.0")
    try:
        timeout_seconds = float(timeout_raw)
        if timeout_seconds <= 0:
            # Mirror the QUEUE_SIZE validation. urlopen(timeout=0)
            # raises immediately, turning a typo into a per-record
            # failure streak.
            raise ValueError("must be > 0")
    except ValueError:
        print(
            f"[log_forwarding] EIDAN_LOG_FORWARD_TIMEOUT={timeout_raw!r} "
            f"not a positive number — falling back to 5.0",
            file=sys.stderr,
        )
        timeout_seconds = 5.0

    queue_size_raw = os.environ.get(
        "EIDAN_LOG_FORWARD_QUEUE_SIZE", str(_DEFAULT_QUEUE_SIZE)
    )
    try:
        queue_size = int(queue_size_raw)
        if queue_size <= 0:
            raise ValueError("must be positive")
    except ValueError:
        print(
            f"[log_forwarding] EIDAN_LOG_FORWARD_QUEUE_SIZE={queue_size_raw!r} "
            f"not a positive integer — falling back to {_DEFAULT_QUEUE_SIZE}",
            file=sys.stderr,
        )
        queue_size = _DEFAULT_QUEUE_SIZE

    http_handler = _JsonHttpHandler(
        url=url,
        headers=headers,
        timeout_seconds=timeout_seconds,
    )
    http_handler.setLevel(level)

    # Bounded queue + custom handler so logger.info() doesn't block
    # on the POST AND a slow/dead intake can't OOM the process.
    # respect_handler_level=True so the http_handler.setLevel above
    # actually filters (otherwise the QueueListener would re-emit
    # everything regardless of the handler's own level).
    log_queue: queue.Queue[logging.LogRecord] = queue.Queue(maxsize=queue_size)
    queue_handler = _ForwardingQueueHandler(log_queue)
    queue_handler.setLevel(level)
    listener = logging.handlers.QueueListener(
        log_queue, http_handler, respect_handler_level=True
    )
    listener.start()

    root = logging.getLogger()
    root.addHandler(queue_handler)
    # Note: we deliberately do **not** mutate the root logger's
    # level. The forwarder is opt-in via env, and silently
    # globally-lowering root from WARNING to INFO would have
    # surprising side effects on every other handler (stdout,
    # journald, anything operators wired up themselves). The
    # effective forwarded level is max(root.level, level): if a
    # caller wants INFO records forwarded but their root is at
    # WARNING, they set root via the normal path (uvicorn's
    # --log-level info, or logging.basicConfig in their own
    # startup) — this module stays out of that decision.

    _active_listener = listener
    _active_handler = queue_handler

    # Stop the listener at process exit so the background thread
    # joins cleanly. Best-effort; if Python is exiting hard there's
    # nothing we can do. Register once per process — tests cycling
    # attach → reset → attach would otherwise accumulate stale
    # callbacks in atexit's list. The hook is a no-op when no
    # listener is active, so leaving it registered after a test
    # reset is harmless.
    global _atexit_registered
    if not _atexit_registered:
        atexit.register(_shutdown_forwarder)
        _atexit_registered = True

    safe_url = http_handler._safe_url
    # `_format_record` only forwards a fixed allow-list of extras
    # (event, node_id, node_type, conversation_id, payload). Stash
    # the structured fields inside `payload` so they actually land
    # in the forwarded JSON; otherwise they'd be set on the
    # LogRecord but silently dropped at format time. Both `url` and
    # `level` use the redacted form for the same reason as the
    # message — this very line is itself forwarded.
    logger.info(
        "log_forwarding: enabled — POSTing to %s at level %s",
        safe_url,
        level_name,
        extra={
            "event": "log_forwarding.enabled",
            "payload": {"url": safe_url, "level": level_name},
        },
    )
    return True


_SHUTDOWN_JOIN_TIMEOUT_S = 2.0


def _shutdown_forwarder(*, join_timeout_s: float = _SHUTDOWN_JOIN_TIMEOUT_S) -> None:
    """Stop the background listener thread + detach the handler.

    Idempotent (returns early when nothing is attached). Used by:

    - the atexit hook registered in
      :func:`attach_log_forwarder_if_configured` (process exit),
    - the HTTP app's lifespan teardown
      (:mod:`eidan_backend.http.app`), so re-lifecycling the app
      in the same interpreter (tests, embedded ASGI servers)
      doesn't leak handler/thread state between runs,
    - :func:`_reset_for_tests`.

    **Bounded.** :meth:`logging.handlers.QueueListener.stop` joins
    the listener thread unconditionally. If the intake is hung or
    the operator configured a large ``EIDAN_LOG_FORWARD_TIMEOUT``,
    that join can stall service shutdown / atexit for minutes.
    Inline a bounded variant: signal the sentinel, join with a
    deadline (default 2s — enough for one in-flight POST under
    normal conditions), and walk away if the thread doesn't
    finish. The listener thread is daemon (see
    :meth:`logging.handlers.QueueListener.start`), so abandoning
    it is safe — interpreter exit reaps it; the cost is one
    in-flight POST gets lost. Losing a record is the right
    trade against blocking service restart under a forwarding
    outage (same "telemetry never breaks job execution" doctrine
    as the rest of the module).
    """
    global _active_listener, _active_handler
    listener = _active_listener
    if listener is None:
        return
    try:
        listener.enqueue_sentinel()
        thread = listener._thread
        if thread is not None:
            thread.join(timeout=join_timeout_s)
            if thread.is_alive():
                print(
                    f"[log_forwarding] shutdown: listener thread did not "
                    f"finish within {join_timeout_s}s — abandoning "
                    f"(in-flight POST will be lost; interpreter exit "
                    f"will reap the daemon thread)",
                    file=sys.stderr,
                )
            # Match what listener.stop() would have set; allows
            # subsequent stop() / start() to be sane on the same
            # listener object even though we don't re-use it.
            listener._thread = None
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
