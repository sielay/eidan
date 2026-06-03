"""Failure-classifier fallback — step ②.6 of the agentic loop.

Runs when the cross-turn deterministic detector's aggregate weight
exceeds ``host.config.failure.classifier_threshold`` (default 0.8).
The classifier reads the same conversation tail the detector saw plus
the names of the matched signals, and returns a structured verdict
the loop uses to decide whether to:

- proceed with the primary as normal,
- escalate to the critic immediately after the primary, or
- surrender (refuse the turn with a short explanation, no provider
  call beyond this one).

The point is to avoid spending a large-model budget on a turn the
loop already strongly suspects will fail. The classifier is small
(Haiku-class) and cheap; its single ``llm_calls`` row carries
``role='failure_classifier'``.

Even when the classifier returns garbage the surrounding loop must
make progress, so parse failures collapse to ``proceed`` rather than
raising.
"""

from __future__ import annotations

import json
from collections.abc import Sequence
from dataclasses import dataclass

from ..failure_detector import HistoryMessage
from ..providers.base import Provider, ProviderCallResult, UserMessage
from .scope import _classifier_model

_VALID_VERDICTS: frozenset[str] = frozenset({"proceed", "escalate", "surrender"})

_FALLBACK_SYSTEM = (
    "You are a routing classifier. The user just sent the message at "
    "the end of the transcript below. A deterministic detector has "
    "flagged the named signals on this turn, suggesting the previous "
    "answer(s) may have failed.\n\n"
    "Return a JSON object with two fields:\n"
    '  - "verdict": one of "proceed", "escalate", "surrender".\n'
    '  - "reason": one short sentence explaining your call.\n\n'
    "Pick `escalate` when the conversation history shows a real "
    "miss the next answer needs help with; pick `proceed` when the "
    "signals look like noise (sarcasm, idiomatic phrasing, a "
    "follow-up that genuinely is new). Reserve `surrender` for "
    "cases where the user has explicitly given up or asked to stop. "
    "Respond with ONLY the JSON object — no prose, no code fences."
)


@dataclass(frozen=True, slots=True)
class FallbackResult:
    """Parsed classifier output.

    ``verdict`` is always one of ``proceed``/``escalate``/``surrender``;
    a malformed or unknown verdict collapses to ``proceed`` per the
    module-level "never block the loop" rule.
    """

    verdict: str
    reason: str

    @property
    def should_escalate(self) -> bool:
        return self.verdict == "escalate"

    @property
    def should_surrender(self) -> bool:
        return self.verdict == "surrender"


async def classify_failure(
    *,
    provider: Provider,
    user_text: str,
    history: Sequence[HistoryMessage],
    matched_signals: Sequence[str],
    system_prefix: str = "",
) -> tuple[FallbackResult, ProviderCallResult]:
    """Run the classifier-fallback and return ``(parsed, call_telemetry)``.

    The caller persists the telemetry as one ``llm_calls`` row with
    ``role='failure_classifier'`` so the cost rolls up alongside the
    other classifier calls of the turn.
    """
    transcript = _render_transcript(history, user_text=user_text)
    signal_line = (
        ", ".join(sorted(matched_signals))
        if matched_signals
        else "(none)"
    )
    prompt = (
        f"Matched signals: {signal_line}\n\n"
        f"Transcript:\n{transcript}"
    )

    chunks: list[str] = []
    async for chunk in provider.stream_turn(
        model=_classifier_model(),
        messages=[UserMessage(role="user", content=prompt)],
        system=system_prefix + _FALLBACK_SYSTEM,
        max_tokens=128,
    ):
        chunks.append(chunk.text)
    call = await provider.last_call_result()

    raw = "".join(chunks).strip()
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        parsed = None

    verdict = "proceed"
    reason = ""
    if isinstance(parsed, dict):
        candidate = parsed.get("verdict")
        if isinstance(candidate, str) and candidate in _VALID_VERDICTS:
            verdict = candidate
        raw_reason = parsed.get("reason", "")
        if isinstance(raw_reason, str):
            reason = raw_reason.strip()[:280]

    return FallbackResult(verdict=verdict, reason=reason), call


def _render_transcript(
    history: Sequence[HistoryMessage],
    *,
    user_text: str,
    cap: int = 8,
) -> str:
    """Format the trailing ``cap`` history rows + the current user
    message into a compact text transcript the classifier reads.

    Tool turns are dropped — the classifier reasons about
    user/assistant dialogue, not the tool plumbing.
    """
    lines: list[str] = []
    tail = [m for m in history if m.role in ("user", "assistant")][-cap:]
    for msg in tail:
        body = msg.content.strip().replace("\n", " ")[:240]
        lines.append(f"{msg.role.upper()}: {body}")
    lines.append(f"USER: {user_text.strip()[:240]}")
    return "\n".join(lines)


__all__ = ["FallbackResult", "classify_failure"]
