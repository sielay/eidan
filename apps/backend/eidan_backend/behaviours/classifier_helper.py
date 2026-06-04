# SPDX-License-Identifier: AGPL-3.0-or-later
"""Classifier helper for behaviour dispatch kinds — `docs/026 §2.3`.

Provides `classify_for_behaviour()` which wraps the classifier pipeline
without requiring a full turn. Used by classifier_gate behaviours to
make a single LLM decision at a branch point.

Example from docs/026:

    verdict = await ctx.classify(
        prompt="Triage this issue: ...",
        inputs={"issue": event.payload},
        schema=TriageVerdict,
    )
    match verdict.action:
        case "high": await ctx.tools.escalate(...)
        case "low": await ctx.tools.ack(...)
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    import asyncpg

    from ..providers import Provider


async def classify_for_behaviour(
    *,
    conn: asyncpg.Connection,
    provider: Provider | None,
    model: str,
    prompt: str,
    inputs: dict[str, Any] | None = None,
    schema: Any = None,
) -> dict[str, Any]:
    """Invoke a classifier for a behaviour.

    Args:
        conn: DB connection for writing llm_calls row
        provider: LLM provider (if None, returns empty verdict)
        model: Model identifier
        prompt: System prompt or instruction for the classifier
        inputs: Input dict passed to the model
        schema: Expected output schema (if provided, used for validation)

    Returns:
        Parsed JSON response from the model.

    Writes an llm_calls row with role='behaviour_classifier' for
    observability (#151 / docs/026).
    """
    if provider is None:
        # No provider configured, skip classification
        return {}

    inputs = inputs or {}

    # TODO: Implement actual classifier call. For now, placeholder.
    # This will reuse patterns from classifiers.scope / intent / failure,
    # but invoked directly instead of inside run_turn.
    result = {"action": "default"}

    # TODO: Write llm_calls row
    # await insert_llm_call(
    #     conn,
    #     role="behaviour_classifier",
    #     result=...,
    # )

    return result
