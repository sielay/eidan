"""Host-level price table — `docs/010 §3.4`.

`docs/010 §2.1` makes the host the SINGLE source of truth for cost.
Provider adapters keep their own default tables (the per-vendor
calibration is the thing that drifts) but every cost computation
that the budget aggregator and the analytics plugin will read
eventually routes through :func:`compute_cost_usd` here, so a
plugin emitting an `llm_calls` row outside the in-process
Provider abstraction (`docs/010 §3.1` row 5) sees the same price
table — including ``EIDAN_PRICE_<MODEL>_*`` env overrides — that
the in-loop adapters do.

The unified table is composed at import time from the per-provider
defaults so adding a new model in `providers/anthropic.py` or
`providers/openai.py` lights it up here automatically. Anthropic
wins on key collision because the host's primary loop is
Anthropic-first today; an operator can flip the price for either
vendor's id via the env-var overlay regardless.
"""

from __future__ import annotations

import os

from .providers.anthropic import _DEFAULT_PRICING as _ANTHROPIC_PRICING
from .providers.openai import _DEFAULT_PRICING as _OPENAI_PRICING

_RATE_KEYS = ("input", "output", "cache_read", "cache_creation")

_HOST_PRICING: dict[str, dict[str, float]] = {
    **_OPENAI_PRICING,
    **_ANTHROPIC_PRICING,
}


def model_env_key(model: str) -> str:
    """Normalise a model id to its ``EIDAN_PRICE_<KEY>_*`` env suffix.

    ``claude-opus-4-7`` → ``CLAUDE_OPUS_4_7``. Mirrors the per-provider
    helpers so an operator's env-var naming is the same regardless of
    which adapter ships the model.
    """
    upper = model.upper()
    return "".join(c if c.isalnum() else "_" for c in upper)


def pricing_for(model: str) -> dict[str, float] | None:
    """USD-per-Mtok rates for ``model`` with env overrides applied.

    Returns ``None`` for an unknown model with no env overrides —
    callers treat that as "cannot price" and write ``cost_usd = 0``
    rather than fail the call.
    """
    base = _HOST_PRICING.get(model)
    rates = dict(base) if base is not None else {}
    env_prefix = f"EIDAN_PRICE_{model_env_key(model)}_"
    for key in _RATE_KEYS:
        raw = os.environ.get(env_prefix + key.upper())
        if raw is None:
            continue
        try:
            rates[key] = float(raw)
        except ValueError:
            continue
    if not rates:
        return None
    for key in _RATE_KEYS:
        rates.setdefault(key, 0.0)
    return rates


def compute_cost_usd(
    model: str,
    *,
    input_tokens: int = 0,
    output_tokens: int = 0,
    cache_read_tokens: int = 0,
    cache_creation_tokens: int = 0,
) -> float:
    """Compose ``cost_usd`` for a single call against the host table.

    The four token axes (`docs/003 §9`) map onto the same four
    rate axes the env-var overlay covers. A model that's missing
    from every source returns ``0.0`` — the row still lands so
    the operator can spot the misconfiguration in dashboards
    (`docs/010 §3.3`).
    """
    rates = pricing_for(model)
    if rates is None:
        return 0.0
    return round(
        (
            input_tokens * rates["input"]
            + output_tokens * rates["output"]
            + cache_read_tokens * rates["cache_read"]
            + cache_creation_tokens * rates["cache_creation"]
        )
        / 1_000_000,
        6,
    )


__all__ = [
    "compute_cost_usd",
    "model_env_key",
    "pricing_for",
]
