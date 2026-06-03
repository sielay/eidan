"""Scope classifier — step ③ of the agentic loop.

A cheap upstream call that tags the inbound user message with a small
set of skill labels. Phase 1.5 ships the tagging only; behaviour
loading off the result is a follow-up (`docs/005 §5.4`).

The classifier deliberately ignores conversation history and runs
against a single lean system prompt — `docs/005 §5.2` ("lean base
context"). Even when the model returns garbage, the surrounding loop
must still progress, so a parse failure collapses to an empty tag list
rather than raising.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass

from ..persistence import capture_call_inputs
from ..providers.base import Provider, ProviderCallResult, UserMessage

_DEFAULT_CLASSIFIER_MODEL = "claude-haiku-4-5-20251001"


def _classifier_model() -> str:
    """Resolve the model id this classifier asks the provider for.

    ``EIDAN_CLASSIFIER_MODEL`` overrides the default at call time.
    Operators running non-Anthropic providers (Ollama, OpenAI, vLLM)
    set this to a model their provider recognises — the default
    haiku id 404s outside Anthropic. Backwards-compatible: unset →
    Anthropic-shaped install behaves as before.
    """
    return (
        os.environ.get("EIDAN_CLASSIFIER_MODEL", "").strip()
        or _DEFAULT_CLASSIFIER_MODEL
    )

_SCOPE_SYSTEM = (
    "You tag the user message with 1-5 skill labels from this set:\n"
    "coding, writing, research, math, planning, chitchat, system, other.\n\n"
    "Respond with ONLY a JSON array of lowercase tag strings — no prose, "
    'no code fences. Example: ["coding", "research"]'
)


@dataclass(frozen=True, slots=True)
class ScopeResult:
    skills: list[str]


async def classify_scope(
    *,
    provider: Provider,
    user_text: str,
    system_prefix: str = "",
) -> tuple[ScopeResult, ProviderCallResult]:
    """Run the scope classifier and return (parsed_result, call_telemetry).

    ``system_prefix`` is prepended to the classifier's own system prompt.
    The loop uses this to inject the per-turn TZ header (issue #51) so
    even short-context classifier calls share the same clock as the
    primary call.

    The telemetry is handed back so the caller can persist a single
    ``llm_calls`` row with ``role='scope_classifier'`` per `docs/010 §3`.
    """
    system_prompt = system_prefix + _SCOPE_SYSTEM
    chunks: list[str] = []
    async for chunk in provider.stream_turn(
        model=_classifier_model(),
        messages=[UserMessage(role="user", content=user_text)],
        system=system_prompt,
        max_tokens=128,
    ):
        chunks.append(chunk.text)
    call = await provider.last_call_result()
    call = capture_call_inputs(
        call, system_prompt=system_prompt, user_text=user_text
    )

    text = "".join(chunks).strip()
    skills: list[str] = []
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError:
        parsed = None
    if isinstance(parsed, list):
        skills = [str(s).strip().lower() for s in parsed if isinstance(s, (str, int))]
        skills = [s for s in skills if s]

    return ScopeResult(skills=skills), call
