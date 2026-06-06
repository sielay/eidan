# SPDX-License-Identifier: AGPL-3.0-or-later
"""OpenRouter adapter — one key, the whole OpenRouter model catalogue.

OpenRouter speaks the OpenAI Chat Completions wire dialect, so this
adapter is a thin subclass of :class:`~eidan_backend.providers.openai.OpenAIProvider`
pointed at ``https://openrouter.ai/api/v1``. Two things make it more than
a base-URL shorthand (and worth its own ``name`` for telemetry):

- **Native per-call cost.** OpenRouter fronts 200+ models from every
  major vendor; a hand-maintained price table (the static
  ``_DEFAULT_PRICING`` the OpenAI/Anthropic adapters carry) cannot keep
  up. Instead OpenRouter *returns the actual cost of each call* in its
  ``usage`` block when the request opts in with ``usage: {include:
  true}``. This adapter sets that flag and reads ``usage.cost`` (USD)
  straight into ``llm_calls.cost_usd`` (`docs/007 §4`, `docs/010 §2.1`),
  so cost capture works for any model without per-model pricing config.
  When the field is absent (older gateway, a model that doesn't report
  it) it falls back to the parent's static-table estimate.

- **Ranking headers.** OpenRouter uses the optional ``HTTP-Referer`` and
  ``X-Title`` request headers to attribute traffic on its public
  leaderboard. Operators set them via ``OPENROUTER_SITE_URL`` /
  ``OPENROUTER_APP_NAME``; both are optional.

Claude stays the host default (`docs/007 §6.2`); OpenRouter is opt-in
via ``EIDAN_PROVIDER=openrouter``. Model ids carry the vendor prefix
OpenRouter expects, e.g. ``anthropic/claude-3.7-sonnet``,
``openai/gpt-4o-mini``, ``google/gemini-2.5-flash`` — set them via
``EIDAN_DEFAULT_MODEL`` / per-route overrides like any other provider.
"""

from __future__ import annotations

from .openai import OpenAIProvider

#: OpenRouter's OpenAI-compatible endpoint. Overridable via
#: ``OPENROUTER_BASE_URL`` for a self-hosted proxy in front of it.
DEFAULT_BASE_URL = "https://openrouter.ai/api/v1"


def _native_cost(usage: object | None) -> float | None:
    """Pull OpenRouter's reported call cost (USD) off the usage block.

    OpenRouter adds a ``cost`` field to the otherwise-OpenAI-shaped
    ``usage`` object when the request sets ``usage: {include: true}``.
    The openai SDK does not model that field, so it lands either as a
    dynamic attribute or in ``model_extra``; check both. Returns ``None``
    when no usable cost is present so the caller can fall back to the
    static price table.
    """
    if usage is None:
        return None
    cost = getattr(usage, "cost", None)
    if cost is None:
        extra = getattr(usage, "model_extra", None) or {}
        if isinstance(extra, dict):
            cost = extra.get("cost")
    if cost is None:
        return None
    try:
        return round(float(cost), 6)
    except (TypeError, ValueError):
        return None


class OpenRouterProvider(OpenAIProvider):
    """OpenAI-compatible adapter for the OpenRouter gateway."""

    name = "openrouter"

    def __init__(
        self,
        *,
        api_key: str,
        base_url: str | None = None,
        timeout: float | None = None,
        site_url: str | None = None,
        app_name: str | None = None,
    ) -> None:
        headers: dict[str, str] = {}
        if site_url:
            headers["HTTP-Referer"] = site_url
        if app_name:
            headers["X-Title"] = app_name
        super().__init__(
            api_key=api_key,
            base_url=base_url or DEFAULT_BASE_URL,
            timeout=timeout,
            default_headers=headers or None,
        )

    def _extra_create_kwargs(self) -> dict:
        # Opt into OpenRouter's per-call accounting. ``stream_options``
        # (set by the parent) already asks for a usage block on the final
        # chunk; this asks that block to carry the call's actual ``cost``.
        return {"extra_body": {"usage": {"include": True}}}

    def _cost_from_usage(self, model: str, usage: object | None) -> float:
        native = _native_cost(usage)
        if native is not None:
            return native
        # No reported cost — fall back to the static table (mostly a
        # no-op of zeros for uncovered models, which warns once via
        # ``pricing.warn_unpriced_model``).
        return super()._cost_from_usage(model, usage)
