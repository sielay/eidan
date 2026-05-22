"""Ollama provider shorthand tests (audit §10 follow-up).

``EIDAN_PROVIDER=ollama`` maps onto :class:`OpenAIProvider` with the
``OLLAMA_BASE_URL`` (default ``http://localhost:11434/v1``) and a
sentinel API key so the OpenAI SDK doesn't refuse to construct.
Local-model pricing defaults to zero for the common Ollama-hosted
models (phi3, mistral, llama3, qwen2.5) so ``llm_calls.cost_usd``
reads as "no marginal $ cost" out of the box.
"""

from __future__ import annotations

import pytest
from eidan_backend.config import BackendSettings
from eidan_backend.http.app import _build_provider_from_settings
from eidan_backend.providers.openai import (
    OpenAIProvider,
    _estimate_cost,
    _pricing_for,
)


def _settings(**overrides) -> BackendSettings:
    """Build a BackendSettings with sensible defaults for the shorthand
    tests. The real loader reads env vars; here we construct directly."""
    base = {
        "database_url": "postgresql+asyncpg://test/test",
        "provider": "anthropic",
        "anthropic_api_key": None,
        "openai_api_key": None,
        "openai_base_url": None,
        "ollama_base_url": "http://localhost:11434/v1",
        "default_model": "claude-opus-4-7",
        "max_turn_cost_usd": 1.00,
        "max_daily_cost_usd": None,
        "log_level": "INFO",
    }
    base.update(overrides)
    return BackendSettings(**base)


def test_ollama_shorthand_builds_openai_adapter_against_ollama_url() -> None:
    settings = _settings(provider="ollama")
    provider = _build_provider_from_settings(settings)
    assert isinstance(provider, OpenAIProvider)
    # The constructed AsyncOpenAI client carries the base_url verbatim
    # — verify the underlying SDK keeps it on the client.
    assert str(provider._client.base_url).startswith("http://localhost:11434")


def test_ollama_shorthand_accepts_custom_base_url() -> None:
    settings = _settings(
        provider="ollama",
        ollama_base_url="http://gpu-host:11434/v1",
    )
    provider = _build_provider_from_settings(settings)
    assert "gpu-host" in str(provider._client.base_url)


def test_ollama_shorthand_passes_through_openai_api_key_for_auth() -> None:
    """Operators who proxy Ollama behind a bearer-auth gateway set
    OPENAI_API_KEY; the shorthand forwards it. When unset we fall
    back to a sentinel (Ollama itself doesn't validate)."""
    settings_with_key = _settings(
        provider="ollama",
        openai_api_key="sk-gateway-auth-token",
    )
    provider = _build_provider_from_settings(settings_with_key)
    # The OpenAI SDK exposes the configured api_key via the client.
    assert provider._client.api_key == "sk-gateway-auth-token"

    settings_no_key = _settings(provider="ollama")
    provider2 = _build_provider_from_settings(settings_no_key)
    assert provider2._client.api_key == "ollama"


def test_local_model_pricing_defaults_to_zero() -> None:
    """Every local-model row in the default pricing table is zero —
    operators running on their own hardware see llm_calls.cost_usd
    as zero by default; override via EIDAN_PRICE_<MODEL>_* if you
    track an effective per-token cost."""
    for model in ("phi3", "phi3:mini", "mistral", "mistral:7b", "llama3", "qwen2.5"):
        rates = _pricing_for(model)
        assert rates is not None, f"{model} missing from default pricing"
        assert rates["input"] == 0.0
        assert rates["output"] == 0.0


def test_local_model_cost_estimate_is_zero() -> None:
    cost = _estimate_cost(
        "phi3", input_tokens=100_000, output_tokens=10_000,
        cache_read=0, cache_creation=0,
    )
    assert cost == 0.0


def test_local_model_pricing_overridable(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Operators with metered local hosting (or compute attribution
    requirements) set the env override to capture real costs."""
    monkeypatch.setenv("EIDAN_PRICE_PHI3_OUTPUT", "0.10")
    cost = _estimate_cost(
        "phi3", input_tokens=0, output_tokens=1_000_000,
        cache_read=0, cache_creation=0,
    )
    assert cost == pytest.approx(0.10)
