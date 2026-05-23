# SPDX-License-Identifier: AGPL-3.0-or-later
"""``_resolve_plugins_dir`` precedence — app.state > env > default.

The runtime lifespan handler reads from this helper; an operator
setting ``EIDAN_PLUGINS_DIR`` (e.g. to point at a Fly volume) must
win over the in-image default, and an explicit ``app.state.plugins_dir``
must win over the env so tests are never surprised by a stray
operator env.
"""

from __future__ import annotations

from pathlib import Path

import pytest
from eidan_backend.http.app import _DEFAULT_PLUGINS_DIR, _resolve_plugins_dir


def test_app_state_overrides_env(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setenv("EIDAN_PLUGINS_DIR", str(tmp_path / "from-env"))
    explicit = tmp_path / "from-state"
    assert _resolve_plugins_dir(explicit) == Path(str(explicit))


def test_env_overrides_default(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    target = tmp_path / "from-env"
    monkeypatch.setenv("EIDAN_PLUGINS_DIR", str(target))
    assert _resolve_plugins_dir(None) == target


def test_default_used_when_neither_set(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("EIDAN_PLUGINS_DIR", raising=False)
    assert _resolve_plugins_dir(None) == _DEFAULT_PLUGINS_DIR


def test_empty_env_falls_through_to_default(monkeypatch: pytest.MonkeyPatch) -> None:
    """An operator who unset the var by setting it to ``""`` should
    not get an empty-path discovery root."""
    monkeypatch.setenv("EIDAN_PLUGINS_DIR", "   ")
    assert _resolve_plugins_dir(None) == _DEFAULT_PLUGINS_DIR
