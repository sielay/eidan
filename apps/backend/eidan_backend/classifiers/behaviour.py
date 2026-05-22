"""Behaviour classifier — `docs/006 §5`.

The cheap LLM call that picks which ``intent:`` triggers fire for a
given user message. Sits between the scope/sizer/intent classifiers
and the primary call. Phase 1 lands the classifier itself + the
ActivationMode / extended behaviour dataclasses; the loop-side
integration (system-prompt assembly, tool-surface mutation, AUTO vs
OFFER routing) follows once the behaviour-registry shape extends to
carry ``prompt_stanza`` + ``tools`` at registration time.

The classifier prompt shape matches §5.2 exactly: numbered situation
list, lean recent-context window, JSON output. The runner builds the
``index_to_trigger`` map per turn; this module is the cheapest part
— prompt assembly + parsing + a single Provider call.
"""

from __future__ import annotations

import json
from collections.abc import Sequence
from dataclasses import dataclass
from enum import StrEnum

from ..providers.base import Provider, ProviderCallResult, UserMessage

_CLASSIFIER_MODEL = "claude-haiku-4-5-20251001"


class ActivationMode(StrEnum):
    """Per `docs/006 §1` — AUTO injects the behaviour into the
    primary call as a prompt + tool; OFFER surfaces it as a chip the
    user explicitly accepts. The mode is metadata on the behaviour
    itself, not on the trigger."""

    AUTO = "auto"
    OFFER = "offer"


@dataclass(frozen=True, slots=True)
class IntentSituation:
    """One numbered situation the classifier prompt presents.

    ``trigger_index`` is the position the runner assigns per turn
    (1-based for human readability in the prompt). The runner keeps
    the inverse ``index → (behaviour_id, trigger_position)`` map so
    a returned index resolves cleanly back to a behaviour.
    """

    trigger_index: int
    description: str  # the trigger's natural-language spec


@dataclass(frozen=True, slots=True)
class BehaviourMatchResult:
    """Parsed §5.3 envelope.

    ``matches`` is the classifier-returned list of trigger indices;
    ``reason`` is a short sentence the runner stamps onto the
    llm_calls row's metadata for debugging.
    """

    matches: tuple[int, ...]
    reason: str


_CLASSIFIER_SYSTEM = (
    "You are a routing classifier. The user just sent the message "
    "below. You will see a numbered list of situations. Return the "
    "numbers of the situations that match. Return [] if none match. "
    "Do not invent numbers.\n\n"
    "Respond with ONLY this JSON object — no prose, no code fences:\n"
    '{"matches": [<int>, ...], "reason": "<one short sentence>"}'
)


async def classify_behaviour(
    *,
    provider: Provider,
    user_text: str,
    situations: Sequence[IntentSituation],
    recent_context: Sequence[str] = (),
    system_prefix: str = "",
) -> tuple[BehaviourMatchResult, ProviderCallResult]:
    """Run the §5 classifier against ``situations`` and return
    ``(parsed, telemetry)``.

    A classifier that returns an index outside ``[1..len(situations)]``
    has its row logged and discarded by the runner — but parsing here
    is permissive: we don't raise on out-of-range indices. The runner
    enforces the bound when it walks ``matches`` against the per-turn
    map (`docs/006 §5.3`).
    """
    if not situations:
        # No survivors after filtering → classifier short-circuits.
        # The runner still wants a ProviderCallResult-shaped null;
        # callers can detect ``situations == ()`` themselves and skip
        # the call entirely.
        raise ValueError("classify_behaviour requires at least one situation")

    prompt_blocks: list[str] = []
    prompt_blocks.append(
        f"USER MESSAGE:\n{user_text.strip()[:2048]}"
    )
    prompt_blocks.append("\nSITUATIONS:")
    for situation in situations:
        prompt_blocks.append(
            f"  {situation.trigger_index}. {situation.description}"
        )
    if recent_context:
        prompt_blocks.append("\nRECENT CONTEXT (oldest → newest):")
        for line in recent_context[-4:]:
            cleaned = line.strip().replace("\n", " ")[:240]
            prompt_blocks.append(f"  - {cleaned}")

    prompt = "\n".join(prompt_blocks)

    chunks: list[str] = []
    async for chunk in provider.stream_turn(
        model=_CLASSIFIER_MODEL,
        messages=[UserMessage(role="user", content=prompt)],
        system=system_prefix + _CLASSIFIER_SYSTEM,
        max_tokens=192,
    ):
        chunks.append(chunk.text)
    call = await provider.last_call_result()

    raw = "".join(chunks).strip()
    matches: tuple[int, ...] = ()
    reason = ""
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        parsed = None
    if isinstance(parsed, dict):
        raw_matches = parsed.get("matches")
        if isinstance(raw_matches, list):
            collected: list[int] = []
            for entry in raw_matches:
                if isinstance(entry, bool):
                    continue
                if isinstance(entry, int):
                    collected.append(entry)
            matches = tuple(dict.fromkeys(collected))  # de-dupe, preserve order
        raw_reason = parsed.get("reason", "")
        if isinstance(raw_reason, str):
            reason = raw_reason.strip()[:240]

    return BehaviourMatchResult(matches=matches, reason=reason), call


__all__ = [
    "ActivationMode",
    "BehaviourMatchResult",
    "IntentSituation",
    "classify_behaviour",
]
