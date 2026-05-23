# SPDX-License-Identifier: AGPL-3.0-or-later
"""Env-var binding tests for :class:`BackendSettings`.

Most existing tests construct `BackendSettings(**kwargs)` directly to
bypass the env loader. These tests pin the *env-var aliases* on the
fields that operators set in deployment env files (`eidan.env`,
`fly secrets`, `flyctl secrets`) — i.e. the public deploy surface.
"""

from __future__ import annotations

import pytest
from eidan_backend.config import BackendSettings


def _set_minimum_env(monkeypatch: pytest.MonkeyPatch) -> None:
    """Set the required env vars so `BackendSettings()` can construct
    without raising. Tests that exercise *optional* env vars layer
    their own setenv calls on top of this.

    Callers should also pass ``_env_file=None`` to ``BackendSettings``
    so a developer's local ``.env`` doesn't shadow the monkeypatched
    values and make these tests flaky."""
    monkeypatch.setenv(
        "DATABASE_URL", "postgresql+asyncpg://test:test@localhost:5432/test"
    )


def test_default_model_defaults_to_haiku_when_env_unset(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Haiku is the safe default: cheapest Anthropic tier, so an
    operator who boots without configuring EIDAN_DEFAULT_MODEL
    doesn't get billed at Opus rates by accident."""
    _set_minimum_env(monkeypatch)
    monkeypatch.delenv("EIDAN_DEFAULT_MODEL", raising=False)
    settings = BackendSettings(_env_file=None)
    assert settings.default_model == "claude-haiku-4-5-20251001"


def test_default_model_reads_eidan_default_model_env(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Self-hosted nodes (Pi with Ollama, vLLM gateways, …) set
    EIDAN_DEFAULT_MODEL to whatever the configured provider can
    actually serve (e.g. `phi3` for Ollama). Regression test for the
    `validation_alias` on the field."""
    _set_minimum_env(monkeypatch)
    monkeypatch.setenv("EIDAN_DEFAULT_MODEL", "phi3")
    settings = BackendSettings(_env_file=None)
    assert settings.default_model == "phi3"


def test_default_model_env_works_alongside_provider_env(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The Pi deploy recipe pairs EIDAN_PROVIDER=ollama with
    EIDAN_DEFAULT_MODEL=phi3 — verify both bind without colliding."""
    _set_minimum_env(monkeypatch)
    monkeypatch.setenv("EIDAN_PROVIDER", "ollama")
    monkeypatch.setenv("EIDAN_DEFAULT_MODEL", "phi3")
    settings = BackendSettings(_env_file=None)
    assert settings.provider == "ollama"
    assert settings.default_model == "phi3"
