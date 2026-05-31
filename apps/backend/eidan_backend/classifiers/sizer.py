"""Sizer — step ④ of the agentic loop.

Picks a model id for the primary call. Output is one of the two model
ids the operator has slotted as ``cheap`` and ``deep`` for this node;
anything else collapses to ``None`` so the caller can fall back to the
operator's configured default (:attr:`BackendSettings.default_model`).

The slot map (cheap / deep / opus) is per-node so a Pi running Ollama
can slot ``phi3`` as cheap and route ordinary turns to the local
endpoint, while a Fly node can slot ``claude-haiku-4-5-20251001``
there. See issue #59 and :class:`SizerConfig`.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

from ..providers.base import Provider, ProviderCallResult, UserMessage
from .scope import ScopeResult


@dataclass(frozen=True, slots=True)
class SizerConfig:
    """Per-node model vocabulary the sizer chooses between.

    ``runtime_model`` is the model that drives the sizer call itself —
    on a Pi-with-ollama node this needs to be a model the local
    provider can serve (e.g. ``phi3``); on a cloud-only node the
    Anthropic default works.

    ``cheap_model`` and ``deep_model`` are the slots the sizer routes
    the *primary* call into. ``opus_model`` is the resolution for the
    user-phrase opus override path; an operator who never wants opus
    can point it at ``deep_model``.
    """

    runtime_model: str = "claude-haiku-4-5-20251001"
    cheap_model: str = "claude-haiku-4-5-20251001"
    deep_model: str = "claude-sonnet-4-6"
    opus_model: str = "claude-opus-4-7"


_DEFAULT_CONFIG = SizerConfig()


def _render_system_prompt(config: SizerConfig) -> str:
    """Build the sizer's system prompt from the node's slot map.

    The criteria are identical across nodes — what varies is the model
    ids the sizer names. Examples mention the operator's cheap id
    literally so the model echoes the right string.

    Default-deny escalation: the prior prompt's "complex reasoning /
    high sensitivity" clause was broader than the ground truth and
    over-picked the deep slot on turns the cheap slot would have
    handled fine (issue #47, docs/007 §6.2).
    """
    return (
        "Pick a model class for the primary call.\n\n"
        "Reply with EXACTLY two lines, no prose, no code fences:\n"
        "MODEL: <one of the model ids below>\n"
        "REASON: <short phrase, ≤8 words, naming the trigger>\n\n"
        f"Default is {config.cheap_model}. Pick {config.deep_model} ONLY "
        "if at least one holds:\n"
        "  • the user asks the agent to plan or sequence ≥3 distinct steps\n"
        "  • the user asks for synthesis across ≥3 named entities\n"
        "  • the user explicitly asks for depth, rewriting, or rigour\n"
        "  • the turn carries high-stakes wording (legal, medical, money)\n"
        "Length alone is not a reason. Vocabulary alone is not a reason.\n\n"
        "Models:\n"
        f"  {config.cheap_model}\n"
        f"  {config.deep_model}\n\n"
        "Examples:\n"
        "  User: what's the timezone in São Paulo right now?\n"
        f"  → MODEL: {config.cheap_model}\n"
        "    REASON: factual lookup\n\n"
        "  User: summarise my notes from this week\n"
        f"  → MODEL: {config.cheap_model}\n"
        "    REASON: shallow summary\n\n"
        "  User: draft a 3-week plan to migrate auth across 4 services\n"
        f"  → MODEL: {config.deep_model}\n"
        "    REASON: multi-step plan, multi-entity"
    )


_MODEL_LINE = re.compile(r"(?im)^\s*MODEL\s*:\s*(\S+)")
_REASON_LINE = re.compile(r"(?im)^\s*REASON\s*:\s*(.+?)\s*$")


@dataclass(frozen=True, slots=True)
class SizerResult:
    model: str | None
    escalation_reason: str | None = None


def _parse(text: str, config: SizerConfig) -> tuple[str | None, str | None]:
    """Extract (model, reason) from the sizer's reply.

    Tolerant of three shapes seen in practice:
      1. The structured ``MODEL: ... / REASON: ...`` shape the prompt asks for.
      2. A bare model id, for backward compatibility with the prior prompt.
      3. Any reply that mentions one of the allowed ids in passing.

    Allowed ids are exactly the node's cheap and deep slots — the opus
    slot is reachable only via the user-phrase override path below,
    never via the sizer's own choice.
    """
    allowed: tuple[str, ...] = (config.cheap_model, config.deep_model)
    model_match = _MODEL_LINE.search(text)
    if model_match:
        candidate = model_match.group(1).strip().rstrip(",.;")
        model = next((m for m in allowed if candidate == m), None)
    else:
        model = next((m for m in allowed if m in text), None)

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
    config: SizerConfig | None = None,
) -> tuple[SizerResult, ProviderCallResult]:
    """Run the sizer and return (parsed_result, call_telemetry).

    ``system_prefix`` is the per-turn TZ header (issue #51) the loop
    prepends so every provider call within a turn shares the same
    clock.

    ``config`` is the per-node sizer vocabulary. Omitted in unit tests
    that don't care about routing; the default matches the historic
    haiku/sonnet/opus mapping so call sites that haven't been updated
    keep working.

    If user explicitly requests Opus (e.g. "use opus", "opus model"),
    escalate to it regardless of sizer assessment.
    """
    cfg = config or _DEFAULT_CONFIG
    skills_hint = ", ".join(scope.skills) if scope.skills else "(none)"
    user_block = (
        f"Skills tagged for this turn: {skills_hint}.\n\n"
        f"User message:\n{user_text}"
    )

    chunks: list[str] = []
    async for chunk in provider.stream_turn(
        model=cfg.runtime_model,
        messages=[UserMessage(role="user", content=user_block)],
        system=system_prefix + _render_system_prompt(cfg),
        max_tokens=64,
    ):
        chunks.append(chunk.text)
    call = await provider.last_call_result()

    text = "".join(chunks).strip()
    model, reason = _parse(text, cfg)

    user_text_lower = user_text.lower()
    if any(
        phrase in user_text_lower
        for phrase in ("use opus", "opus model", "claude opus", "claude-opus")
    ):
        model = cfg.opus_model
        reason = "user-requested opus"

    return SizerResult(model=model, escalation_reason=reason), call
