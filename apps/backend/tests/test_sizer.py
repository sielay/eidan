# SPDX-License-Identifier: AGPL-3.0-or-later
"""Unit tests for the sizer (issues #47 + #59).

Four surfaces under test:

- the structured ``MODEL: ... / REASON: ...`` reply shape the
  refreshed prompt asks for,
- backward-compatible parsing of a bare model id (so a stale prompt
  cache or a haiku that ignores the format header still works),
- the opus override path, which short-circuits the parser,
- the per-node :class:`SizerConfig` slot map: a Pi-with-ollama
  operator points ``cheap_model`` at ``phi3`` and the sizer's reply
  resolves to that id; the runtime model passed to the provider also
  comes from the slot map.
"""

from __future__ import annotations

import pytest
from eidan_backend.classifiers import SizerConfig, pick_model
from eidan_backend.classifiers.scope import ScopeResult

from .conftest import FakeProvider, ScriptedTurn

_PI_CONFIG = SizerConfig(
    runtime_model="phi3",
    cheap_model="phi3",
    deep_model="claude-sonnet-4-6",
    opus_model="claude-opus-4-7",
)


@pytest.mark.asyncio
async def test_parses_structured_reply() -> None:
    provider = FakeProvider(
        [
            ScriptedTurn(
                text=(
                    "MODEL: claude-haiku-4-5-20251001\n"
                    "REASON: factual lookup"
                )
            )
        ]
    )

    result, _call = await pick_model(
        provider=provider,
        user_text="what's the timezone in São Paulo right now?",
        scope=ScopeResult(skills=[]),
    )

    assert result.model == "claude-haiku-4-5-20251001"
    assert result.escalation_reason == "factual lookup"


@pytest.mark.asyncio
async def test_parses_sonnet_with_reason() -> None:
    provider = FakeProvider(
        [
            ScriptedTurn(
                text=(
                    "MODEL: claude-sonnet-4-6\n"
                    "REASON: multi-step plan, multi-entity"
                )
            )
        ]
    )

    result, _call = await pick_model(
        provider=provider,
        user_text="draft a 3-week plan to migrate auth across 4 services",
        scope=ScopeResult(skills=["planning"]),
    )

    assert result.model == "claude-sonnet-4-6"
    assert result.escalation_reason == "multi-step plan, multi-entity"


@pytest.mark.asyncio
async def test_falls_back_on_bare_model_id() -> None:
    """A reply that ignores the MODEL/REASON format but names an
    allowed id still resolves — reason is None."""
    provider = FakeProvider([ScriptedTurn(text="claude-haiku-4-5-20251001")])

    result, _call = await pick_model(
        provider=provider,
        user_text="hi",
        scope=ScopeResult(skills=["chitchat"]),
    )

    assert result.model == "claude-haiku-4-5-20251001"
    assert result.escalation_reason is None


@pytest.mark.asyncio
async def test_unparseable_reply_falls_back_to_none() -> None:
    """An off-vocabulary reply collapses to None so the loop falls
    back to the operator-configured default."""
    provider = FakeProvider([ScriptedTurn(text="not a model id at all")])

    result, _call = await pick_model(
        provider=provider,
        user_text="whatever",
        scope=ScopeResult(skills=[]),
    )

    assert result.model is None
    assert result.escalation_reason is None


@pytest.mark.asyncio
async def test_opus_override_short_circuits_parser() -> None:
    """The explicit-opus user phrase wins over whatever the sizer says,
    and the reason field records the override."""
    provider = FakeProvider(
        [
            ScriptedTurn(
                text=(
                    "MODEL: claude-haiku-4-5-20251001\n"
                    "REASON: factual lookup"
                )
            )
        ]
    )

    result, _call = await pick_model(
        provider=provider,
        user_text="please use opus for this — explain transformers",
        scope=ScopeResult(skills=[]),
    )

    assert result.model == "claude-opus-4-7"
    assert result.escalation_reason == "user-requested opus"


@pytest.mark.asyncio
async def test_unknown_model_id_in_structured_reply_is_rejected() -> None:
    """A MODEL: line naming an id outside the allowed set collapses to
    None so we never silently route to an unmapped model."""
    provider = FakeProvider(
        [
            ScriptedTurn(
                text=(
                    "MODEL: claude-opus-4-7\n"
                    "REASON: aspirational"
                )
            )
        ]
    )

    result, _call = await pick_model(
        provider=provider,
        user_text="some neutral question",
        scope=ScopeResult(skills=[]),
    )

    assert result.model is None
    assert result.escalation_reason == "aspirational"


# ---------------------------------------------------------------------------
# Issue #59 — per-node slot map
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_pi_node_cheap_slot_routes_to_phi3() -> None:
    """On a Pi-with-ollama node, an ordinary turn resolves to the
    operator's local cheap_model id (``phi3``) — *not* to a hard-coded
    Anthropic haiku."""
    provider = FakeProvider(
        [ScriptedTurn(text="MODEL: phi3\nREASON: factual lookup")]
    )

    result, _call = await pick_model(
        provider=provider,
        user_text="what's the timezone in São Paulo right now?",
        scope=ScopeResult(skills=[]),
        config=_PI_CONFIG,
    )

    assert result.model == "phi3"
    assert result.escalation_reason == "factual lookup"


@pytest.mark.asyncio
async def test_pi_node_deep_slot_still_escalates_to_sonnet() -> None:
    """Even on the Pi config, the deep slot is reachable for turns
    that hit the escalation criteria — the cheap/deep split is what
    varies per node, not the criteria."""
    provider = FakeProvider(
        [
            ScriptedTurn(
                text=(
                    "MODEL: claude-sonnet-4-6\n"
                    "REASON: multi-step plan, multi-entity"
                )
            )
        ]
    )

    result, _call = await pick_model(
        provider=provider,
        user_text="draft a 3-week plan to migrate auth across 4 services",
        scope=ScopeResult(skills=["planning"]),
        config=_PI_CONFIG,
    )

    assert result.model == "claude-sonnet-4-6"
    assert result.escalation_reason == "multi-step plan, multi-entity"


@pytest.mark.asyncio
async def test_runtime_model_comes_from_config() -> None:
    """The sizer call itself runs on the operator's configured
    runtime_model — so a Pi-with-ollama node never reaches for an
    Anthropic endpoint to make the sizer decision."""
    provider = FakeProvider(
        [ScriptedTurn(text="MODEL: phi3\nREASON: factual lookup")]
    )

    await pick_model(
        provider=provider,
        user_text="hi",
        scope=ScopeResult(skills=[]),
        config=_PI_CONFIG,
    )

    assert len(provider.calls) == 1
    assert provider.calls[0]["model"] == "phi3"


@pytest.mark.asyncio
async def test_default_runtime_model_is_haiku() -> None:
    """When config is omitted, the historic haiku runtime is used —
    so call sites that haven't been updated keep working."""
    provider = FakeProvider(
        [
            ScriptedTurn(
                text=(
                    "MODEL: claude-haiku-4-5-20251001\n"
                    "REASON: factual lookup"
                )
            )
        ]
    )

    await pick_model(
        provider=provider,
        user_text="hi",
        scope=ScopeResult(skills=[]),
    )

    assert provider.calls[0]["model"] == "claude-haiku-4-5-20251001"


@pytest.mark.asyncio
async def test_opus_override_resolves_via_config() -> None:
    """The opus user-phrase override resolves to the operator's
    ``opus_model`` slot. Operators who don't want opus can point that
    slot at ``deep_model`` to flatten the override to deep."""
    config = SizerConfig(
        runtime_model="phi3",
        cheap_model="phi3",
        deep_model="claude-sonnet-4-6",
        opus_model="claude-sonnet-4-6",  # no opus available on this node
    )
    provider = FakeProvider(
        [ScriptedTurn(text="MODEL: phi3\nREASON: factual lookup")]
    )

    result, _call = await pick_model(
        provider=provider,
        user_text="please use opus for this — explain transformers",
        scope=ScopeResult(skills=[]),
        config=config,
    )

    assert result.model == "claude-sonnet-4-6"
    assert result.escalation_reason == "user-requested opus"


@pytest.mark.asyncio
async def test_prompt_names_configured_model_ids() -> None:
    """The system prompt the sizer sees mentions the node's actual
    cheap/deep ids — otherwise a phi3-on-Pi sizer would be told to
    answer with ``claude-haiku-4-5-20251001`` and never emit ``phi3``."""
    provider = FakeProvider(
        [ScriptedTurn(text="MODEL: phi3\nREASON: factual lookup")]
    )

    await pick_model(
        provider=provider,
        user_text="hi",
        scope=ScopeResult(skills=[]),
        config=_PI_CONFIG,
    )

    system_prompt = provider.calls[0]["system"]
    assert "phi3" in system_prompt
    assert "claude-sonnet-4-6" in system_prompt
    # The hard-coded haiku of the old prompt must not leak in.
    assert "claude-haiku-4-5-20251001" not in system_prompt
