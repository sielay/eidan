"""Tests for Anthropic rate-table env-var overrides (issue #34).

The adapter ships baked-in pricing for the canonical Claude models so
``cost_usd`` lands on every ``eidan.llm_calls`` row even with no
configuration. Operators with negotiated rates — or anyone routing
through a proxy that charges differently — override those rates via
``EIDAN_PRICE_<MODEL>_*`` env vars.
"""

from __future__ import annotations

import pytest
from eidan_backend.providers.anthropic import (
    _DEFAULT_PRICING,
    _estimate_cost,
    _model_env_key,
    _pricing_for,
)


def test_baseline_pricing_matches_default_table() -> None:
    rates = _DEFAULT_PRICING["claude-opus-4-7"]
    cost = _estimate_cost(
        "claude-opus-4-7",
        input_tokens=1_000_000,
        output_tokens=0,
        cache_read=0,
        cache_creation=0,
    )
    assert cost == pytest.approx(rates["input"])


def test_unknown_model_costs_zero() -> None:
    assert (
        _estimate_cost(
            "claude-not-a-real-model",
            input_tokens=1_000_000,
            output_tokens=1_000_000,
            cache_read=0,
            cache_creation=0,
        )
        == 0.0
    )


def test_model_env_key_normalisation() -> None:
    assert _model_env_key("claude-opus-4-7") == "CLAUDE_OPUS_4_7"
    assert _model_env_key("claude-haiku-4-5-20251001") == "CLAUDE_HAIKU_4_5_20251001"


def test_env_override_zeroes_opus_input(monkeypatch: pytest.MonkeyPatch) -> None:
    """Issue #34 acceptance check: setting the input override to 0
    forces the input portion of an Opus call to cost nothing.
    """
    monkeypatch.setenv("EIDAN_PRICE_CLAUDE_OPUS_4_7_INPUT", "0")
    cost = _estimate_cost(
        "claude-opus-4-7",
        input_tokens=1_000_000,
        output_tokens=0,
        cache_read=0,
        cache_creation=0,
    )
    assert cost == 0.0


def test_env_override_zeroes_every_axis(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("EIDAN_PRICE_CLAUDE_OPUS_4_7_INPUT", "0")
    monkeypatch.setenv("EIDAN_PRICE_CLAUDE_OPUS_4_7_OUTPUT", "0")
    monkeypatch.setenv("EIDAN_PRICE_CLAUDE_OPUS_4_7_CACHE_READ", "0")
    monkeypatch.setenv("EIDAN_PRICE_CLAUDE_OPUS_4_7_CACHE_CREATION", "0")
    cost = _estimate_cost(
        "claude-opus-4-7",
        input_tokens=1_000_000,
        output_tokens=1_000_000,
        cache_read=1_000_000,
        cache_creation=1_000_000,
    )
    assert cost == 0.0


def test_env_override_arbitrary_rate(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("EIDAN_PRICE_CLAUDE_SONNET_4_6_OUTPUT", "7.5")
    cost = _estimate_cost(
        "claude-sonnet-4-6",
        input_tokens=0,
        output_tokens=2_000_000,
        cache_read=0,
        cache_creation=0,
    )
    assert cost == pytest.approx(15.0)


def test_env_override_for_unpriced_model(monkeypatch: pytest.MonkeyPatch) -> None:
    """A model with no default entry can be priced entirely from env."""
    monkeypatch.setenv("EIDAN_PRICE_CLAUDE_FUTURE_X_INPUT", "2.0")
    monkeypatch.setenv("EIDAN_PRICE_CLAUDE_FUTURE_X_OUTPUT", "10.0")
    cost = _estimate_cost(
        "claude-future-x",
        input_tokens=500_000,
        output_tokens=1_000_000,
        cache_read=0,
        cache_creation=0,
    )
    # 500_000 * 2.0 / 1e6 + 1_000_000 * 10.0 / 1e6 = 1.0 + 10.0 = 11.0
    assert cost == pytest.approx(11.0)


def test_malformed_override_falls_back_to_default(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("EIDAN_PRICE_CLAUDE_OPUS_4_7_INPUT", "not-a-float")
    rates = _pricing_for("claude-opus-4-7")
    assert rates is not None
    assert rates["input"] == _DEFAULT_PRICING["claude-opus-4-7"]["input"]
