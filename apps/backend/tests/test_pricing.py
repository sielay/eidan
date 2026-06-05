# SPDX-License-Identifier: AGPL-3.0-or-later
"""Host-level price table — `docs/010 §3.4` / pricing.py.

The host-level :func:`compute_cost_usd` is the single source of
truth `docs/010 §2.1` pins. Both the in-loop adapters and the
plugin-emitted writer path (`docs/010 §3.1` row 5, issue #16)
route through it so caps and dashboards see identical pricing
across in-loop and plugin-emitted calls.
"""

from __future__ import annotations

import pytest
from eidan_backend.pricing import (
    compute_cost_usd,
    model_env_key,
    pricing_for,
)


def test_compute_cost_usd_known_anthropic_model() -> None:
    # Opus input rate is $15 per Mtok; 1M input tokens cost $15.
    cost = compute_cost_usd(
        "claude-opus-4-7",
        input_tokens=1_000_000,
    )
    assert cost == pytest.approx(15.0)


def test_compute_cost_usd_known_openai_model() -> None:
    # gpt-4o input rate is $2.50 per Mtok; 1M input tokens cost $2.50.
    cost = compute_cost_usd("gpt-4o", input_tokens=1_000_000)
    assert cost == pytest.approx(2.50)


def test_compute_cost_usd_unknown_model_is_zero() -> None:
    # Unknown model with no env overrides — the row still lands at
    # cost_usd = 0 (`docs/010 §3.3`).
    assert compute_cost_usd("not-a-real-model", input_tokens=1_000_000) == 0.0


def test_compute_cost_usd_opus_4_8_is_priced() -> None:
    # Current flagship must be in the table so it never bills at $0
    # (issue #203). Input rate is $5 per Mtok.
    cost = compute_cost_usd("claude-opus-4-8", input_tokens=1_000_000)
    assert cost == pytest.approx(5.0)


def test_unpriced_model_logs_structured_warning(
    caplog: pytest.LogCaptureFixture,
) -> None:
    # docs/010 §3.3 / issue #203: an unpriced model must surface as a
    # misconfiguration, never bill silently at $0.
    import eidan_backend.pricing as pricing_mod

    pricing_mod._warned_unpriced.discard("ghost-model-a")
    with caplog.at_level("WARNING", logger="eidan_backend.pricing"):
        cost = compute_cost_usd("ghost-model-a", input_tokens=1_000_000)

    assert cost == 0.0
    events = [
        r
        for r in caplog.records
        if getattr(r, "event", None) == "budget.unpriced_model"
        and getattr(r, "model", None) == "ghost-model-a"
    ]
    assert len(events) == 1
    assert events[0].source == "host"


def test_unpriced_warning_is_once_per_model(
    caplog: pytest.LogCaptureFixture,
) -> None:
    import eidan_backend.pricing as pricing_mod

    pricing_mod._warned_unpriced.discard("ghost-model-b")
    with caplog.at_level("WARNING", logger="eidan_backend.pricing"):
        compute_cost_usd("ghost-model-b", input_tokens=1)
        compute_cost_usd("ghost-model-b", input_tokens=1)

    events = [
        r
        for r in caplog.records
        if getattr(r, "event", None) == "budget.unpriced_model"
        and getattr(r, "model", None) == "ghost-model-b"
    ]
    assert len(events) == 1


def test_every_default_model_id_is_priced() -> None:
    # Regression guard (issue #203): every model id the host can emit
    # from its own config / classifier / critic / sizer defaults must
    # resolve to a price-table entry, or it bills at $0.
    from eidan_backend.classifiers.behaviour import _CLASSIFIER_MODEL
    from eidan_backend.classifiers.scope import _DEFAULT_CLASSIFIER_MODEL
    from eidan_backend.classifiers.sizer import _ALLOWED_MODELS, _ESCALATION_MODEL
    from eidan_backend.config import BackendSettings
    from eidan_backend.critic import _CRITIC_MODEL

    default_model = BackendSettings.model_fields["default_model"].default

    referenced = {
        default_model,
        _CRITIC_MODEL,
        _CLASSIFIER_MODEL,
        _DEFAULT_CLASSIFIER_MODEL,
        _ESCALATION_MODEL,
        *_ALLOWED_MODELS,
    }
    unpriced = sorted(m for m in referenced if pricing_for(m) is None)
    assert not unpriced, f"unpriced default model ids: {unpriced}"


def test_compute_cost_usd_env_override_takes_precedence(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("EIDAN_PRICE_CLAUDE_OPUS_4_7_INPUT", "0")
    cost = compute_cost_usd(
        "claude-opus-4-7",
        input_tokens=1_000_000,
    )
    assert cost == 0.0


def test_compute_cost_usd_env_unlocks_unpriced_model(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # A vendor model the host has never heard of can be priced
    # entirely from the operator's env (the plugin-emitted writer
    # path's whole point is to support these).
    monkeypatch.setenv("EIDAN_PRICE_VENDOR_X_INPUT", "1.0")
    monkeypatch.setenv("EIDAN_PRICE_VENDOR_X_OUTPUT", "5.0")
    cost = compute_cost_usd(
        "vendor-x",
        input_tokens=1_000_000,
        output_tokens=2_000_000,
    )
    # 1*1 + 2*5 = 11
    assert cost == pytest.approx(11.0)


def test_compute_cost_usd_sums_all_four_axes(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("EIDAN_PRICE_VENDOR_Y_INPUT", "1.0")
    monkeypatch.setenv("EIDAN_PRICE_VENDOR_Y_OUTPUT", "2.0")
    monkeypatch.setenv("EIDAN_PRICE_VENDOR_Y_CACHE_READ", "3.0")
    monkeypatch.setenv("EIDAN_PRICE_VENDOR_Y_CACHE_CREATION", "4.0")
    cost = compute_cost_usd(
        "vendor-y",
        input_tokens=1_000_000,
        output_tokens=1_000_000,
        cache_read_tokens=1_000_000,
        cache_creation_tokens=1_000_000,
    )
    assert cost == pytest.approx(10.0)


def test_model_env_key_matches_provider_helpers() -> None:
    # Matches the legacy per-provider helpers so an operator's env
    # naming stays the same regardless of which adapter ships the model.
    assert model_env_key("claude-opus-4-7") == "CLAUDE_OPUS_4_7"
    assert model_env_key("gpt-4o") == "GPT_4O"
    assert model_env_key("claude-haiku-4-5-20251001") == "CLAUDE_HAIKU_4_5_20251001"


def test_pricing_for_returns_full_axis_set_on_partial_env(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Setting one axis on an unknown model populates the others at 0
    # so callers never see a missing key on the four axes.
    monkeypatch.setenv("EIDAN_PRICE_VENDOR_Z_INPUT", "0.5")
    rates = pricing_for("vendor-z")
    assert rates is not None
    assert rates["input"] == 0.5
    assert rates["output"] == 0.0
    assert rates["cache_read"] == 0.0
    assert rates["cache_creation"] == 0.0
