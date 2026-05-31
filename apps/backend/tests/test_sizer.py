# SPDX-License-Identifier: AGPL-3.0-or-later
"""Unit tests for the sizer (issue #47).

Three surfaces under test:

- the structured ``MODEL: ... / REASON: ...`` reply shape the
  refreshed prompt asks for,
- backward-compatible parsing of a bare model id (so a stale prompt
  cache or a haiku that ignores the format header still works),
- the opus override path, which short-circuits the parser.
"""

from __future__ import annotations

import pytest
from eidan_backend.classifiers import pick_model
from eidan_backend.classifiers.scope import ScopeResult

from .conftest import FakeProvider, ScriptedTurn


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
