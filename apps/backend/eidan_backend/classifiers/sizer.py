"""Sizer — step ④ of the agentic loop.

Picks a model id for the primary call. Output is one of a known set of
model strings; anything else collapses to ``None`` so the caller can
fall back to the operator's configured default
(:attr:`BackendSettings.default_model`).
"""

from __future__ import annotations

from dataclasses import dataclass

from ..providers.base import Provider, ProviderCallResult, UserMessage
from .scope import ScopeResult

_SIZER_MODEL = "claude-haiku-4-5-20251001"

_ALLOWED_MODELS: tuple[str, ...] = (
    "claude-haiku-4-5-20251001",
    "claude-sonnet-4-6",
)

_SIZER_SYSTEM = (
    "Pick a model class for the primary call. Reply with ONLY one of "
    "the exact strings below — no prose, no code fences:\n\n"
    "claude-haiku-4-5-20251001  — most questions and commands\n"
    "claude-sonnet-4-6          — complex reasoning, multi-step tasks, "
    "or high-urgency / high-sensitivity work"
)


@dataclass(frozen=True, slots=True)
class SizerResult:
    model: str | None


async def pick_model(
    *,
    provider: Provider,
    user_text: str,
    scope: ScopeResult,
    system_prefix: str = "",
) -> tuple[SizerResult, ProviderCallResult]:
    """Run the sizer and return (parsed_result, call_telemetry).

    ``system_prefix`` is the per-turn TZ header (issue #51) the loop
    prepends so every provider call within a turn shares the same
    clock.

    If user explicitly requests Opus (e.g. "use opus", "opus model"),
    escalate to it regardless of sizer assessment.
    """
    skills_hint = ", ".join(scope.skills) if scope.skills else "(none)"
    user_block = (
        f"Skills tagged for this turn: {skills_hint}.\n\n"
        f"User message:\n{user_text}"
    )

    chunks: list[str] = []
    async for chunk in provider.stream_turn(
        model=_SIZER_MODEL,
        messages=[UserMessage(role="user", content=user_block)],
        system=system_prefix + _SIZER_SYSTEM,
        max_tokens=32,
    ):
        chunks.append(chunk.text)
    call = await provider.last_call_result()

    text = "".join(chunks).strip()
    match = next((m for m in _ALLOWED_MODELS if m in text), None)

    # Override to Opus if user explicitly requests it
    user_text_lower = user_text.lower()
    if any(phrase in user_text_lower for phrase in ("use opus", "opus model", "claude opus", "claude-opus")):
        match = "claude-opus-4-7"

    return SizerResult(model=match), call
