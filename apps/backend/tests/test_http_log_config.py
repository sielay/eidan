# SPDX-License-Identifier: AGPL-3.0-or-later
"""Tests for :func:`eidan_backend.http.server._build_log_config`.

Pin the contract that the app's own logger tree
(``eidan_backend.*``, plugins, …) always reaches stderr regardless
of whether file logging is enabled. Without this, deploy targets
that collect logs from stdout/stderr (Fly Machines, Docker,
journald) see only uvicorn's access lines — see issue #27.
"""

from __future__ import annotations

from pathlib import Path

from eidan_backend.http.server import _build_log_config


def test_root_has_console_handler_when_log_file_empty() -> None:
    cfg = _build_log_config(log_file="", log_level="info")
    assert cfg["root"]["handlers"] == ["default"]


def test_root_has_both_handlers_when_log_file_set(tmp_path: Path) -> None:
    cfg = _build_log_config(log_file=str(tmp_path / "out.log"), log_level="info")
    assert cfg["root"]["handlers"] == ["default", "file"]


def test_file_handler_only_added_when_log_file_set() -> None:
    cfg = _build_log_config(log_file="", log_level="info")
    assert "file" not in cfg.get("handlers", {})


def test_uvicorn_loggers_also_mirror_to_file(tmp_path: Path) -> None:
    cfg = _build_log_config(log_file=str(tmp_path / "out.log"), log_level="info")
    for name in ("uvicorn", "uvicorn.access", "uvicorn.error"):
        handlers = cfg["loggers"].get(name, {}).get("handlers")
        if handlers is None:
            continue
        assert "file" in handlers, (
            f"uvicorn logger {name!r} should mirror to file when log_file is set"
        )
