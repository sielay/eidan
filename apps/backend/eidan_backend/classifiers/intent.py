"""Intent classifier — step ④.5 of the agentic loop (issue #59).

Between sizer (④) and primary (⑥), this cheap upstream call asks the
model to enumerate the actions the user wants performed *before* the
primary tries to perform them. The output is fed into the primary
call's system prompt verbatim ("the user is asking you to: 1) X,
2) Y, ...") and stashed on ``TurnContext.intended_actions`` so the
post-primary verifier (issue #60) can check which declared actions
actually left a side-effect.

Failure mode this addresses: agents starting execution before they
understand what the user wants — drift, fan-out, the wrong thing
shipped. Naming the actions up front gives the primary a finite,
ordered todo list instead of a free-form objective.

The classifier inherits the per-turn TZ header (issue #51 piece A)
via ``system_prefix`` so relative time references inside intents
("create_event tomorrow 19:00") resolve against the same clock the
primary will see.
"""

from __future__ import annotations

import json
from dataclasses import dataclass

from eidan_schemas import IntendedActions, Lookup, Unknown

from ..persistence import capture_call_inputs
from ..providers.base import Provider, ProviderCallResult, UserMessage
from .scope import ScopeResult, _classifier_model

_INTENT_SYSTEM = (
    "Enumerate the actions the user wants the assistant to perform on "
    "this turn. ONLY the actions the user actually expressed — do not "
    "infer extras, do not invent helpfulness.\n\n"
    "Respond with ONLY a JSON object — no prose, no code fences — "
    "matching this exact shape:\n"
    "  { \"actions\": [ <action>, <action>, ... ] }\n\n"
    "Each <action> is one of:\n"
    '  { "kind": "create_event", "when": "<ISO 8601 or natural>", '
    '"summary": "<short>", "location": "<optional>", '
    '"duration_minutes": <optional int> }\n'
    '  { "kind": "update_row", "table": "<fully qualified>", '
    '"key": { ... }, "fields": { ... } }\n'
    '  { "kind": "send_message", "channel": "<email|telegram|sms|...>", '
    '"recipient": "<address>", "body": "<text>" }\n'
    '  { "kind": "lookup", "query": "<question>" }\n'
    '  { "kind": "unknown", "note": "<short description>" }\n\n'
    "Rules:\n"
    "- Prefer a verifiable kind (`create_event`, `update_row`, "
    '  `send_message`) over `lookup` when the user is asking for a '
    "  state change.\n"
    "- Resolve relative time references ('tomorrow 19:00', 'in an "
    "  hour') to ISO 8601 against the user_tz from the turn header.\n"
    "- If the user asked for nothing actionable, return "
    '  `{ "actions": [] }`.\n'
    '- Use `unknown` only as a last resort; populate `note` with what '
    "  the user appears to want."
)


@dataclass(frozen=True, slots=True)
class IntentResult:
    """Parsed intent-classifier output.

    Carries the full ``IntendedActions`` model so downstream consumers
    (primary system prompt rendering, post-primary verifier) get the
    structured types and not a raw dict.
    """

    intended: IntendedActions


def _collapse_to_unknown(raw: object, fallback_note: str) -> IntendedActions:
    """Surface an unparseable / malformed classifier output as one Unknown.

    The loop must always make forward progress; a model glitch should
    not crash the turn. The verifier ignores Unknown entries (they're
    not verifiable), so collapsing here is safe.
    """
    return IntendedActions(actions=[Unknown(kind="unknown", note=fallback_note)])


async def classify_intent(
    *,
    provider: Provider,
    user_text: str,
    scope: ScopeResult,
    system_prefix: str = "",
) -> tuple[IntentResult, ProviderCallResult]:
    """Run the intent classifier and return (parsed_result, call_telemetry).

    ``system_prefix`` is the per-turn TZ header (issue #51) the loop
    threads through every classifier so a relative time reference
    inside an intent resolves identically across the call sequence.
    """
    skills_hint = ", ".join(scope.skills) if scope.skills else "(none)"
    user_block = (
        f"Skills tagged for this turn: {skills_hint}.\n\n"
        f"User message:\n{user_text}"
    )

    system_prompt = system_prefix + _INTENT_SYSTEM
    chunks: list[str] = []
    async for chunk in provider.stream_turn(
        model=_classifier_model(),
        messages=[UserMessage(role="user", content=user_block)],
        system=system_prompt,
        max_tokens=512,
    ):
        chunks.append(chunk.text)
    call = await provider.last_call_result()
    call = capture_call_inputs(
        call, system_prompt=system_prompt, user_text=user_block
    )

    text = "".join(chunks).strip()
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError:
        return (
            IntentResult(
                intended=_collapse_to_unknown(text, "classifier emitted invalid JSON")
            ),
            call,
        )

    if not isinstance(parsed, dict):
        return (
            IntentResult(
                intended=_collapse_to_unknown(
                    parsed, "classifier emitted a non-object root"
                )
            ),
            call,
        )

    # Pre-flight: drop any action whose `kind` is outside the catalogue.
    # The Pydantic discriminator would raise on those; collapsing them
    # to Unknown one-by-one (rather than aborting the whole turn) keeps
    # the rest of the list intact.
    raw_actions = parsed.get("actions")
    if not isinstance(raw_actions, list):
        return (
            IntentResult(
                intended=_collapse_to_unknown(
                    raw_actions, "classifier emitted missing/non-list `actions`"
                )
            ),
            call,
        )

    _KNOWN_KINDS = {
        "create_event",
        "update_row",
        "send_message",
        "lookup",
        "unknown",
    }
    sanitised: list[dict] = []
    for entry in raw_actions:
        if isinstance(entry, dict) and entry.get("kind") in _KNOWN_KINDS:
            sanitised.append(entry)
        else:
            note = (
                f"unknown action kind: {entry.get('kind') if isinstance(entry, dict) else type(entry).__name__}"
            )
            sanitised.append({"kind": "unknown", "note": note})

    try:
        intended = IntendedActions.model_validate({"actions": sanitised})
    except Exception as exc:  # noqa: BLE001 — never crash the turn on bad shape
        return (
            IntentResult(
                intended=_collapse_to_unknown(
                    sanitised, f"classifier output failed validation: {exc}"
                )
            ),
            call,
        )

    return IntentResult(intended=intended), call


def render_action_list(intended: IntendedActions) -> str:
    """Render IntendedActions as the prompt-shaped block the primary sees.

    Pure function; tested independently. Returns an empty string when
    the list is empty (the primary call falls back to a free-form
    objective). When the list is non-empty, the block is appended to
    the primary's system prompt AFTER the TZ header.
    """
    if not intended.actions:
        return ""

    lines = ["The user is asking you to perform these actions, in order:"]
    for n, action in enumerate(intended.actions, start=1):
        lines.append(f"  {n}. {_render_one(action)}")
    lines.append(
        "Do these in order. Do not invent additional actions. When an "
        "action needs a tool, call the registered tool — do not just "
        "describe doing it."
    )
    return "\n".join(lines) + "\n"


def _render_one(action: object) -> str:
    """Render a single action as a one-line natural-language description."""
    if isinstance(action, Lookup):
        return f"lookup: {action.query}"
    if isinstance(action, Unknown):
        return f"unclear request: {action.note}"

    # The remaining verifiable kinds — duck-typed because Pydantic v2's
    # discriminated union returns the concrete variant; avoid a runtime
    # import cycle by going through attribute access.
    kind = getattr(action, "kind", None)
    if kind == "create_event":
        bits = [f"create_event when={getattr(action, 'when', '?')}"]
        summary = getattr(action, "summary", None)
        if summary:
            bits.append(f"summary={summary!r}")
        location = getattr(action, "location", None)
        if location:
            bits.append(f"location={location!r}")
        return " ".join(bits)
    if kind == "update_row":
        return (
            f"update_row table={getattr(action, 'table', '?')!r} "
            f"key={getattr(action, 'key', {})!r} "
            f"fields={getattr(action, 'fields', {})!r}"
        )
    if kind == "send_message":
        return (
            f"send_message channel={getattr(action, 'channel', '?')!r} "
            f"recipient={getattr(action, 'recipient', '?')!r}"
        )
    return f"unrecognised action: {kind!r}"


__all__ = ["IntentResult", "classify_intent", "render_action_list"]
