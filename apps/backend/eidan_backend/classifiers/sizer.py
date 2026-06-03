"""Sizer — step ④ of the agentic loop.

Picks a model id for the primary call. Output is one of a known set of
model strings; anything else collapses to ``None`` so the caller can
fall back to the operator's configured default
(:attr:`BackendSettings.default_model`).
"""

from __future__ import annotations

import os
import re
from dataclasses import dataclass

from ..providers.base import Provider, ProviderCallResult, UserMessage
from .scope import ScopeResult, _classifier_model

_ALLOWED_MODELS: tuple[str, ...] = (
    "claude-haiku-4-5-20251001",
    "claude-sonnet-4-6",
)


def _sizer_enabled() -> bool:
    """``EIDAN_SIZER_ENABLED`` kill switch.

    The sizer's prompt + allowed-model list are Anthropic-specific
    (haiku/sonnet/opus tier ladder). Operators running on Ollama,
    OpenAI, or vLLM should set ``EIDAN_SIZER_ENABLED=0`` so the
    loop bypasses the sizer entirely and uses the node's
    configured ``default_model`` for the primary call. Default
    ``True`` keeps Anthropic-shaped installs working as before.
    """
    raw = os.environ.get("EIDAN_SIZER_ENABLED", "").strip().lower()
    return raw not in {"0", "false", "no", "off"}

# Default-deny escalation. The prior prompt's "complex reasoning / high
# sensitivity" clause was broader than the ground truth and over-picked
# sonnet on turns haiku handles fine — see issue #47 and docs/007 §6.2,
# which reserves MEDIUM (sonnet) for *default substantive* answers,
# implying most turns land in SMALL (haiku).
_SIZER_SYSTEM = (
    "Pick a model class for the primary call.\n\n"
    "Reply with EXACTLY two lines, no prose, no code fences:\n"
    "MODEL: <one of the model ids below>\n"
    "REASON: <short phrase, ≤8 words, naming the trigger>\n\n"
    "Default is haiku. Pick sonnet ONLY if at least one holds:\n"
    "  • the user asks the agent to plan or sequence ≥3 distinct steps\n"
    "  • the user asks for synthesis across ≥3 named entities\n"
    "  • the user explicitly asks for depth, rewriting, or rigour\n"
    "  • the turn carries high-stakes wording (legal, medical, money)\n"
    "Length alone is not a reason. Vocabulary alone is not a reason.\n\n"
    "Models:\n"
    "  claude-haiku-4-5-20251001\n"
    "  claude-sonnet-4-6\n\n"
    "Examples:\n"
    "  User: what's the timezone in São Paulo right now?\n"
    "  → MODEL: claude-haiku-4-5-20251001\n"
    "    REASON: factual lookup\n\n"
    "  User: summarise my notes from this week\n"
    "  → MODEL: claude-haiku-4-5-20251001\n"
    "    REASON: shallow summary\n\n"
    "  User: draft a 3-week plan to migrate auth across 4 services\n"
    "  → MODEL: claude-sonnet-4-6\n"
    "    REASON: multi-step plan, multi-entity"
)


_MODEL_LINE = re.compile(r"(?im)^\s*MODEL\s*:\s*(\S+)")
_REASON_LINE = re.compile(r"(?im)^\s*REASON\s*:\s*(.+?)\s*$")


@dataclass(frozen=True, slots=True)
class SizerResult:
    model: str | None
    escalation_reason: str | None = None


def _parse(text: str) -> tuple[str | None, str | None]:
    """Extract (model, reason) from the sizer's reply.

    Tolerant of three shapes seen in practice:
      1. The structured ``MODEL: ... / REASON: ...`` shape the prompt asks for.
      2. A bare model id, for backward compatibility with the prior prompt.
      3. Any reply that mentions one of the allowed ids in passing.
    """
    model_match = _MODEL_LINE.search(text)
    if model_match:
        candidate = model_match.group(1).strip().rstrip(",.;")
        model = next((m for m in _ALLOWED_MODELS if candidate == m), None)
    else:
        model = next((m for m in _ALLOWED_MODELS if m in text), None)

    reason_match = _REASON_LINE.search(text)
    reason = reason_match.group(1).strip() if reason_match else None
    if reason == "":
        reason = None
    return model, reason


async def pick_model(
    *,
    provider: Provider,
    user_text: str,
    scope: ScopeResult,
    system_prefix: str = "",
) -> tuple[SizerResult, ProviderCallResult | None]:
    """Run the sizer and return (parsed_result, call_telemetry).

    ``system_prefix`` is the per-turn TZ header (issue #51) the loop
    prepends so every provider call within a turn shares the same
    clock.

    If user explicitly requests Opus (e.g. "use opus", "opus model"),
    escalate to it regardless of sizer assessment.

    When ``EIDAN_SIZER_ENABLED=0`` (operator opt-out on non-Anthropic
    providers), returns ``(SizerResult(model=None), None)`` without
    making a provider call — the caller falls back to ``default_model``
    and skips the telemetry insert.
    """
    if not _sizer_enabled():
        return SizerResult(model=None, escalation_reason=None), None

    skills_hint = ", ".join(scope.skills) if scope.skills else "(none)"
    user_block = (
        f"Skills tagged for this turn: {skills_hint}.\n\n"
        f"User message:\n{user_text}"
    )

    chunks: list[str] = []
    async for chunk in provider.stream_turn(
        model=_classifier_model(),
        messages=[UserMessage(role="user", content=user_block)],
        system=system_prefix + _SIZER_SYSTEM,
        max_tokens=64,
    ):
        chunks.append(chunk.text)
    call = await provider.last_call_result()

    text = "".join(chunks).strip()
    model, reason = _parse(text)

    user_text_lower = user_text.lower()
    if any(
        phrase in user_text_lower
        for phrase in ("use opus", "opus model", "claude opus", "claude-opus")
    ):
        model = "claude-opus-4-7"
        reason = "user-requested opus"

    return SizerResult(model=model, escalation_reason=reason), call
