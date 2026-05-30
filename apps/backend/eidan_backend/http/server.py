"""``eidan-backend-http`` entry point — runs uvicorn against the app.

The CLI's ``eidan admin server`` subcommand shells into this — no
duplicated argument plumbing. ``EIDAN_HTTP_HOST`` and
``EIDAN_HTTP_PORT`` (see :class:`HttpSettings`) drive the bind address;
CLI flags override the env when present.
"""

from __future__ import annotations

from pathlib import Path

import uvicorn

from ..config import load_http_settings


def _build_log_config(log_file: str, log_level: str) -> dict:
    """Build the dictConfig handed to ``uvicorn.run``.

    Uvicorn applies its own ``dictConfig`` at startup; attaching a
    handler to the root logger before ``uvicorn.run`` gets
    overwritten. Instead, copy uvicorn's default config and weave in
    handlers that also capture the app's own logger tree
    (``eidan_backend``, ``eidan_sentry``, …).

    Always routes the app's logger tree to stderr via uvicorn's
    ``default`` handler so deploy targets that collect logs from
    stdout/stderr (Fly Machines, Docker, journald) see the
    application's records — not just uvicorn's access log. When
    ``log_file`` is set, also writes a copy to the named file.
    """
    from copy import deepcopy

    from uvicorn.config import LOGGING_CONFIG

    cfg = deepcopy(LOGGING_CONFIG)

    # The app's logger tree needs to reach the console regardless of
    # whether file logging is enabled. uvicorn's ``default`` handler
    # is the StreamHandler→stderr it ships with; attaching it to the
    # root logger means every `logging.getLogger("eidan_backend.…")`
    # record propagates to stderr.
    root_handlers: list[str] = ["default"]

    if log_file:
        target = Path(log_file)
        target.parent.mkdir(parents=True, exist_ok=True)
        abs_target = str(target.resolve())

        cfg.setdefault("formatters", {})["file"] = {
            "()": "logging.Formatter",
            "fmt": "%(asctime)s %(levelname)-7s %(name)s: %(message)s",
            "datefmt": "%Y-%m-%dT%H:%M:%S",
        }
        cfg.setdefault("handlers", {})["file"] = {
            "class": "logging.FileHandler",
            "filename": abs_target,
            "formatter": "file",
            "level": log_level.upper(),
            "encoding": "utf-8",
        }

        # Mirror every uvicorn-owned logger to the file too. Uvicorn
        # loggers default to ``propagate=False`` so we can't rely on
        # the root chain to pick them up.
        for _name, logger_cfg in cfg.get("loggers", {}).items():
            handlers = list(logger_cfg.get("handlers") or [])
            if "file" not in handlers:
                handlers.append("file")
            logger_cfg["handlers"] = handlers

        root_handlers.append("file")

    cfg["root"] = {
        "handlers": root_handlers,
        "level": log_level.upper(),
    }
    return cfg


def run(host: str | None = None, port: int | None = None) -> None:
    """Start uvicorn against the production app.

    The settings are looked up at call time so a test process can poke
    ``EIDAN_HTTP_*`` between imports.
    """
    settings = load_http_settings()
    log_config = _build_log_config(settings.log_file, settings.log_level)
    uvicorn.run(
        "eidan_backend.http.app:app",
        host=host if host is not None else settings.host,
        port=port if port is not None else settings.port,
        log_level=settings.log_level,
        log_config=log_config,
    )


def main() -> None:
    """Console-script entry point. No CLI flags — env-driven."""
    run()
