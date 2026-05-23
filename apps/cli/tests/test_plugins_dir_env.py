# SPDX-License-Identifier: AGPL-3.0-or-later
"""``EIDAN_PLUGINS_DIR`` precedence in the CLI admin module.

The CLI's install / list / remove paths must write to the same
directory the runtime host reads from. The runtime side is covered
in ``apps/backend/tests/test_plugins_dir_resolution.py``; this file
covers the CLI's ``_resolve_plugins_dir`` helper.
"""

from __future__ import annotations

from pathlib import Path

import pytest
from eidan_cli import admin


def test_env_overrides_repo_default(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    target = tmp_path / "from-env"
    monkeypatch.setenv("EIDAN_PLUGINS_DIR", str(target))
    assert admin._resolve_plugins_dir() == target


def test_default_when_unset(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("EIDAN_PLUGINS_DIR", raising=False)
    resolved = admin._resolve_plugins_dir()
    assert resolved == admin._REPO_ROOT / "plugins"


def test_blank_env_treated_as_unset(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("EIDAN_PLUGINS_DIR", "   ")
    assert admin._resolve_plugins_dir() == admin._REPO_ROOT / "plugins"


def test_tilde_is_expanded(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("EIDAN_PLUGINS_DIR", "~/eidan-plugins")
    resolved = admin._resolve_plugins_dir()
    assert "~" not in str(resolved)
    assert resolved.is_absolute()
