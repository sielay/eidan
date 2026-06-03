"""Conditional critic — step ⑧ of the agentic loop.

Runs only when the failure detector (`failure_detector.py`) flagged the
primary's final turn. The critic re-reads the user prompt and the
primary's response, returns a structured verdict
(`accept` / `rewrite` / `escalate`), and Phase 1.5 records that verdict
on the assistant message's metadata without yet acting on it
(`docs/005 §5.8`). Re-running the primary on a rewrite / escalate is a
Phase 2 task.
"""

from __future__ import annotations

import json
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Literal

from .failure_detector import FailureSignal
from .persistence import capture_call_inputs
from .providers.base import Provider, ProviderCallResult, UserMessage

_CRITIC_MODEL = "claude-sonnet-4-6"

_CRITIC_SYSTEM = (
    "You are the critic. The primary model just produced a response "
    "that a deterministic detector flagged as suspect.\n\n"
    "Decide one of three verdicts:\n"
    '  "accept"   — the primary response is fine as-is\n'
    '  "rewrite"  — the response should be replaced with a better one\n'
    '  "escalate" — the response needs a larger model on the next pass\n\n'
    "Respond with ONLY a JSON object — no prose, no code fences — "
    "matching this shape:\n"
    '  {"verdict": "accept" | "rewrite" | "escalate", '
    '"reason": "<one short sentence>"}\n'
)


Verdict = Literal["accept", "rewrite", "escalate"]


@dataclass(frozen=True, slots=True)
class CriticResult:
    """Parsed critic verdict.

    Phase 1.5 stores this on the primary assistant message's
    ``metadata.critic`` and stops. The ``rewritten_response`` /
    ``escalate`` branches from `docs/005 §5.8` are deferred.
    """

    verdict: Verdict
    reason: str


async def run_critic(
    *,
    provider: Provider,
    user_text: str,
    primary_text: str,
    signals: Sequence[FailureSignal],
    system_prefix: str = "",
) -> tuple[CriticResult, ProviderCallResult]:
    """Drive the critic call and return (parsed_result, call_telemetry).

    ``system_prefix`` is the per-turn TZ header (issue #51) so the critic
    reasons about "yesterday" / "tomorrow" against the same clock the
    primary saw.

    Signal evidence is rendered inline so the critic sees the
    discrepancy (e.g. "you said you'd create an event but emitted no
    tool calls") — important for issue #60's says-vs-did check, where
    the verdict needs to be actionable.
    """
    signal_block = _render_signals(signals)
    user_block = (
        f"Detector signals:\n{signal_block}\n\n"
        f"User message:\n{user_text}\n\n"
        f"Primary response:\n{primary_text}"
    )

    system_prompt = system_prefix + _CRITIC_SYSTEM
    chunks: list[str] = []
    async for chunk in provider.stream_turn(
        model=_CRITIC_MODEL,
        messages=[UserMessage(role="user", content=user_block)],
        system=system_prompt,
        max_tokens=256,
    ):
        chunks.append(chunk.text)
    call = await provider.last_call_result()
    call = capture_call_inputs(
        call, system_prompt=system_prompt, user_text=user_block
    )

    text = "".join(chunks).strip()
    verdict: Verdict = "accept"
    reason = ""
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError:
        parsed = None
    if isinstance(parsed, dict):
        raw_verdict = str(parsed.get("verdict", "")).strip().lower()
        if raw_verdict in ("accept", "rewrite", "escalate"):
            verdict = raw_verdict  # type: ignore[assignment]
        raw_reason = parsed.get("reason")
        if isinstance(raw_reason, str):
            reason = raw_reason.strip()

    return CriticResult(verdict=verdict, reason=reason), call


def _render_signals(signals: Sequence[FailureSignal]) -> str:
    """Render the detector signals into a critic-prompt-shaped block.

    Per-signal lines preserve evidence so the critic can quote it back
    in the ``reason`` field. The format is deliberately compact — the
    critic is a small model and we want it to focus on the verdict, not
    on parsing a long structured payload.
    """
    if not signals:
        return "(none)"
    lines: list[str] = []
    for s in signals:
        if s.name == "actions_declared_not_executed":
            declared = s.evidence.get("declared", [])
            named = ", ".join(
                f"{d.get('kind')}:{d.get('summary')!r}" for d in declared
            ) or "(none)"
            lines.append(
                f"- {s.name}: declared verifiable actions ({named}) but the "
                f"primary emitted no tool calls."
            )
        elif s.evidence:
            lines.append(f"- {s.name}: {s.evidence}")
        else:
            lines.append(f"- {s.name}")
    return "\n".join(lines)


__all__ = ["CriticResult", "Verdict", "run_critic"]
