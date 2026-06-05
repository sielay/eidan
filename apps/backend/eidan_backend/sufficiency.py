# SPDX-License-Identifier: AGPL-3.0-or-later
"""Sufficiency critic — `docs/027 §5` / #186 slice 2.

The independent *second voice* for an autonomous loop: given the GOAL and
what the investigator has GATHERED, decide whether there's enough to
conclude / act, or whether to keep going. It can overrule an investigator
that prematurely (or falsely) declared itself done, and conclude on the
investigator's behalf when it has clearly finished — distinct from the
investigator's own ``[DONE]`` self-declaration.

One lean provider call (the bicameral critic of `005 §5.8`, applied at
the loop level). **Conservative**: anything but a clear ``SUFFICIENT``
reads as ``CONTINUE``, so the loop keeps going — bounded by the
:class:`LoopGovernor` budget — rather than concluding prematurely.
"""

from __future__ import annotations

from dataclasses import dataclass

from .providers.base import AssistantChunk, Provider, UserMessage

_SUFFICIENCY_SYSTEM = (
    "You are a sufficiency critic for an autonomous investigation. Given the "
    "GOAL and what the investigator has GATHERED so far, decide whether there "
    "is enough to conclude or act on the goal, or whether more investigation "
    "is needed. Reply with exactly one word on the first line: SUFFICIENT or "
    "CONTINUE. Then, on the next line, one short sentence of reason. Be "
    "conservative — answer SUFFICIENT only when a clear conclusion or "
    "recommended action is actually supported by what was gathered."
)


@dataclass(frozen=True, slots=True)
class SufficiencyVerdict:
    sufficient: bool
    reason: str = ""


def _parse(text: str) -> SufficiencyVerdict:
    stripped = text.strip()
    if not stripped:
        return SufficiencyVerdict(sufficient=False, reason="empty critic reply")
    lines = stripped.splitlines()
    first = lines[0].strip().upper()
    reason = lines[1].strip() if len(lines) > 1 else ""
    # Conservative: only an explicit, unambiguous SUFFICIENT counts; an
    # ambiguous reply keeps the loop going (the governor budget bounds it).
    return SufficiencyVerdict(sufficient=first.startswith("SUFFICIENT"), reason=reason)


async def assess_sufficiency(
    *,
    provider: Provider,
    model: str,
    goal: str,
    gathered: str,
) -> SufficiencyVerdict:
    """One critic call: is ``gathered`` enough to conclude on ``goal``?

    Returns the parsed verdict; parsing defaults to CONTINUE on anything
    ambiguous. Provider errors propagate — the caller (the loop) decides
    how to treat a critic failure."""
    user_block = f"GOAL:\n{goal}\n\nGATHERED:\n{gathered}"
    chunks: list[str] = []
    async for block in provider.stream_turn(
        model=model,
        messages=[UserMessage(role="user", content=user_block)],
        system=_SUFFICIENCY_SYSTEM,
        max_tokens=128,
    ):
        if isinstance(block, AssistantChunk):
            chunks.append(block.text)
    return _parse("".join(chunks))


__all__ = ["SufficiencyVerdict", "assess_sufficiency"]
