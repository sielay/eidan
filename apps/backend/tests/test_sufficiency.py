# SPDX-License-Identifier: AGPL-3.0-or-later
"""Sufficiency critic (#186 slice 2 / docs/027 §5).

The loop-level second voice: one provider call that says SUFFICIENT or
CONTINUE. Pure — a minimal fake provider, no DB.
"""

from __future__ import annotations

import pytest
from eidan_backend.providers.base import AssistantChunk
from eidan_backend.sufficiency import _parse, assess_sufficiency


class _FakeProvider:
    """Implements just the `stream_turn` slice assess_sufficiency uses."""

    def __init__(self, reply: str) -> None:
        self._reply = reply

    async def stream_turn(self, *, model, messages, system=None, max_tokens=4096,
                          tools=None):
        yield AssistantChunk(text=self._reply)


def test_parse_sufficient() -> None:
    v = _parse("SUFFICIENT\nthe overdue items are all resolved")
    assert v.sufficient is True
    assert "resolved" in v.reason


def test_parse_continue() -> None:
    assert _parse("CONTINUE\nstill need to check the calendar").sufficient is False


def test_parse_ambiguous_defaults_to_continue() -> None:
    # Conservative: anything that isn't an explicit SUFFICIENT keeps going.
    assert _parse("hard to say, maybe?").sufficient is False
    assert _parse("").sufficient is False


@pytest.mark.asyncio
async def test_assess_sufficiency_reads_sufficient() -> None:
    v = await assess_sufficiency(
        provider=_FakeProvider("SUFFICIENT\nclear conclusion reached"),
        model="phi3",
        goal="resolve the pattern",
        gathered="lots of findings",
    )
    assert v.sufficient is True


@pytest.mark.asyncio
async def test_assess_sufficiency_reads_continue() -> None:
    v = await assess_sufficiency(
        provider=_FakeProvider("CONTINUE\nnot enough yet"),
        model="phi3",
        goal="resolve the pattern",
        gathered="thin",
    )
    assert v.sufficient is False
