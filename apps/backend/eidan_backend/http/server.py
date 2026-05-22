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


def _build_log_config(log_file: str, log_level: str) -> dict | None:
    """Extend uvicorn's default log config with a file handler.

    Uvicorn applies its own ``dictConfig`` at startup; attaching a
    ``FileHandler`` to the root logger before ``uvicorn.run`` gets
    overwritten. Instead, copy uvicorn's default config and weave in
    one extra handler that also captures the app's own logger tree
    (``eidan_backend``, ``eidan_sentry``, …).

    Returns ``None`` when ``log_file`` is empty so uvicorn picks up
    its default config unchanged.
    """
    if not log_file:
        return None
    target = Path(log_file)
    target.parent.mkdir(parents=True, exist_ok=True)
    abs_target = str(target.resolve())

    # Start from uvicorn's stock config so the console output keeps
    # its colour + format, then layer the file handler on top.
    from copy import deepcopy

    from uvicorn.config import LOGGING_CONFIG

    cfg = deepcopy(LOGGING_CONFIG)
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

    # Attach the file handler to every logger that already exists in
    # uvicorn's stock config (uvicorn, uvicorn.access, uvicorn.error)
    # AND set up the root logger to ship records from the rest of the
    # app (``eidan_backend.*``, ``eidan_sentry.*``, ``plugins.*``).
    for _name, logger_cfg in cfg.get("loggers", {}).items():
        handlers = list(logger_cfg.get("handlers") or [])
        if "file" not in handlers:
            handlers.append("file")
        logger_cfg["handlers"] = handlers
        # Uvicorn loggers default to propagate=False; keep it that way
        # so we don't double-log to the console via the root chain.

    cfg["root"] = {
        "handlers": ["file"],
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
