# SPDX-License-Identifier: AGPL-3.0-or-later
"""OpenRouter provider tests (eidan#219).

``EIDAN_PROVIDER=openrouter`` builds :class:`OpenRouterProvider` — a
subclass of :class:`OpenAIProvider` pointed at OpenRouter's
OpenAI-compatible endpoint. Two behaviours beyond a base-URL shorthand
are exercised here:

- it reports ``name == "openrouter"`` so ``llm_calls`` attributes the
  call to the right provider, and opts into per-call cost reporting; and
- it prefers OpenRouter's native ``usage.cost`` (USD) over the static
  price table, so cost is captured for models the table has never heard
  of — falling back to the table only when no cost is reported.
"""

from __future__ import annotations

from types import SimpleNamespace

from eidan_backend.config import BackendSettings
from eidan_backend.http.app import _build_provider_from_settings
from eidan_backend.providers.openrouter import (
    DEFAULT_BASE_URL,
    OpenRouterProvider,
    _native_cost,
)


def _settings(**overrides) -> BackendSettings:
    base = {
        "database_url": "postgresql+asyncpg://test/test",
        "provider": "openrouter",
        "anthropic_api_key": None,
        "openai_api_key": None,
        "openrouter_api_key": "sk-or-v1-test",
        "default_model": "anthropic/claude-3.7-sonnet",
        "max_turn_cost_usd": 1.00,
        "max_daily_cost_usd": None,
        "log_level": "INFO",
    }
    base.update(overrides)
    return BackendSettings(**base)


def test_openrouter_builds_against_openrouter_url() -> None:
    provider = _build_provider_from_settings(_settings())
    assert isinstance(provider, OpenRouterProvider)
    assert provider.name == "openrouter"
    assert str(provider._client.base_url).startswith(DEFAULT_BASE_URL)
    assert provider._client.api_key == "sk-or-v1-test"


def test_openrouter_accepts_custom_base_url() -> None:
    provider = _build_provider_from_settings(
        _settings(openrouter_base_url="https://proxy.internal/api/v1")
    )
    assert "proxy.internal" in str(provider._client.base_url)


def test_openrouter_requires_its_own_key() -> None:
    import pytest

    with pytest.raises(RuntimeError, match="OPENROUTER_API_KEY"):
        _build_provider_from_settings(_settings(openrouter_api_key=None))


def test_ranking_headers_set_only_when_configured() -> None:
    bare = _build_provider_from_settings(_settings())
    # default_headers absent → the SDK still has its own; ours aren't there
    assert "X-Title" not in bare._client.default_headers

    tagged = _build_provider_from_settings(
        _settings(
            openrouter_site_url="https://eidan.example",
            openrouter_app_name="eidan",
        )
    )
    assert tagged._client.default_headers["HTTP-Referer"] == "https://eidan.example"
    assert tagged._client.default_headers["X-Title"] == "eidan"


def test_opts_into_per_call_cost_reporting() -> None:
    provider = _build_provider_from_settings(_settings())
    assert provider._extra_create_kwargs() == {
        "extra_body": {"usage": {"include": True}}
    }


def test_native_cost_read_from_usage_attribute() -> None:
    usage = SimpleNamespace(prompt_tokens=100, completion_tokens=50, cost=0.0123)
    assert _native_cost(usage) == 0.0123


def test_native_cost_read_from_model_extra() -> None:
    # The openai SDK doesn't model OpenRouter's `cost`; it can land in
    # model_extra instead of as a plain attribute.
    usage = SimpleNamespace(prompt_tokens=100, model_extra={"cost": 0.5})
    assert _native_cost(usage) == 0.5


def test_native_cost_absent_returns_none() -> None:
    assert _native_cost(SimpleNamespace(prompt_tokens=1)) is None
    assert _native_cost(None) is None


def test_native_cost_ignores_garbage() -> None:
    assert _native_cost(SimpleNamespace(cost="not-a-number")) is None


def test_cost_prefers_native_over_static_table() -> None:
    provider = OpenRouterProvider(api_key="sk-or-v1-test")
    # A model the static table has never heard of still gets a real cost.
    usage = SimpleNamespace(cost=0.0042)
    assert provider._cost_from_usage("some/exotic-model", usage) == 0.0042


def test_cost_falls_back_to_static_table_when_no_native_cost() -> None:
    provider = OpenRouterProvider(api_key="sk-or-v1-test")
    # No reported cost + an uncovered model → 0.0 (and a one-shot
    # unpriced-model warning from the shared table), never a crash.
    assert provider._cost_from_usage("some/exotic-model", None) == 0.0
