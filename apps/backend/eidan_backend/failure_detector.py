"""Failure detector — steps ②.5 (pre-primary) and ⑦ (post-primary).

Deterministic, pure-Python signals over the conversation tail and the
just-completed primary turn. No LLM call: the detector decides
*whether* the critic / classifier-fallback should think harder; the
LLM-driven half does the thinking (`docs/005 §5.7-§5.8`, `docs/009
§6`).

Phase 1 ships:

**Within-turn (`docs/009 §3.1`) — step ⑦**

- ``empty_response``                — final assistant content empty, no tool calls.
- ``refusal``                       — final assistant text matches a refusal prefix.
- ``loop_exhausted``                — primary loop hit its iteration cap without a
                                      terminal text response.
- ``echoed_question``               — final assistant text effectively repeats the
                                      user message back instead of answering.
- ``actions_declared_not_executed`` — the intent classifier (issue #59) named
                                      verifiable actions but the primary loop
                                      produced no tool_use blocks.

**Cross-turn (`docs/009 §3.2`) — step ②.5, new in Phase 1**

- ``repeated_correction``           — current user message starts with a correction
                                      prefix ("no,", "wrong", "i said …").
- ``near_identical_user_msg``       — current user message Jaccard-similar to any
                                      prior user message in the lookback window
                                      (cheap shingle fallback per §3.2 — no
                                      embeddings required).
- ``direct_correction_phrase``      — exact correction phrase anywhere in the
                                      current user message.
- ``frustration_marker``            — frustration-lexicon hit (multi-punct, all-caps
                                      runs, explicit dissatisfaction).
- ``unanswered_question``           — prior user msg asked, prior assistant refused,
                                      current user msg asks again.
- ``prior_critic_fired``            — any of the last ``lookback`` messages carries
                                      ``metadata.critic.verdict != null``.

The aggregate score (sum of weights) is what the loop tests against
the should-classify threshold. When it crosses, the loop pays for the
classifier-fallback call (`docs/009 §6`) which lands its own
`llm_calls` row with `role='failure_classifier'`.
"""

from __future__ import annotations

import re
import unicodedata
from collections.abc import Sequence
from dataclasses import dataclass, field

from eidan_schemas import IntendedActions

from .providers.base import ToolUseBlock

# Action `kind`s that have an observable side-effect; these are the
# entries the says-vs-did detector checks. `lookup` and `unknown` are
# explicitly not verifiable (a lookup is supposed to leave no trace;
# unknown is the escape hatch).
_VERIFIABLE_KINDS = frozenset({"create_event", "update_row", "send_message"})

# `docs/009 §3.4` — refusal prefixes. The detector applies them as
# case-insensitive matches against the stripped leading text of the
# assistant's final turn.
_REFUSAL_PATTERNS: tuple[re.Pattern[str], ...] = (
    re.compile(r"^I (cannot|can't|won't|will not|am unable|am not able)\b", re.IGNORECASE),
    re.compile(r"^I'?m (sorry|afraid).{0,30}(can|cannot|can't|won't)", re.IGNORECASE),
    re.compile(r"^As an? (AI|assistant).{0,40}(can|cannot|can't|won't)", re.IGNORECASE),
    re.compile(r"^Unfortunately,? I (cannot|can't|won't)", re.IGNORECASE),
    re.compile(r"^That'?s (outside|beyond) my (scope|capabilities)", re.IGNORECASE),
)

# Echoed-question detection: if the assistant's reply, after
# normalisation, is a near-equal of the user's question (or contains
# nothing but the question), the model has reflected the prompt rather
# than answering it.
_ECHO_JACCARD_THRESHOLD = 0.85
_ECHO_MIN_USER_TOKENS = 3

# Default lookback window for cross-turn signals (`docs/009 §3.2`).
# Twelve messages ≈ six user/assistant pairs; cheap to scan, deep
# enough to catch a re-asked question two turns back.
_DEFAULT_LOOKBACK = 12

# Cross-turn signal weights from `docs/009 §3.2`. Sum of weights from
# matched signals is the aggregate score the should-classify decision
# tests against the threshold.
_CROSS_TURN_WEIGHTS: dict[str, float] = {
    "repeated_correction": 0.9,
    "near_identical_user_msg": 0.9,
    "direct_correction_phrase": 0.8,
    "frustration_marker": 0.7,
    "unanswered_question": 0.6,
    "prior_critic_fired": 0.3,
}

# `docs/009 §3.4` — correction prefixes (current user message starts
# with one). Distinct from the in-message correction phrases below
# which match anywhere.
_CORRECTION_PREFIXES: tuple[re.Pattern[str], ...] = (
    re.compile(r"^(no\b|no,|no not|nope\b)", re.IGNORECASE),
    re.compile(
        r"^(i said|i meant|i didn't say|i did not say)", re.IGNORECASE
    ),
    re.compile(
        r"^(you (misunderstood|misread|got it wrong))", re.IGNORECASE
    ),
    re.compile(r"^(that(\s|'s)not (what|right))", re.IGNORECASE),
    re.compile(r"^(stop|wait)\b", re.IGNORECASE),
    re.compile(r"^wrong\b", re.IGNORECASE),
)

# `docs/009 §3.2` — direct correction phrases (anywhere in the
# message). Stronger than the prefix match because the user has
# spelled out their dissatisfaction.
_DIRECT_CORRECTION_PHRASES: tuple[str, ...] = (
    "that's wrong",
    "you're wrong",
    "incorrect",
    "no that is not",
    "i didn't ask for that",
    "read it again",
)

# `docs/009 §3.4` — frustration lexicon. Compiled into regexes once at
# module import so the per-turn loop's overhead is just `pattern.search`.
_FRUSTRATION_PATTERNS: tuple[re.Pattern[str], ...] = (
    re.compile(r"\buseless\b", re.IGNORECASE),
    re.compile(r"\bnot helpful\b", re.IGNORECASE),
    re.compile(r"\bunhelpful\b", re.IGNORECASE),
    re.compile(r"\bdisappointing\b", re.IGNORECASE),
    re.compile(r"\bridiculous\b", re.IGNORECASE),
    re.compile(r"\bterrible answer\b", re.IGNORECASE),
    re.compile(r"!{3,}"),
    re.compile(r"\?{2,}"),
    # 4+ word ALL-CAPS span — rough approximation of the spec's regex.
    re.compile(r"\b[A-Z][A-Z\s]{15,}\b"),
)

# Near-identical Jaccard threshold for the cross-turn signal (`docs/009
# §3.2` fallback path — no embeddings dep). 0.85 here matches the
# spec's "cheaper and imperfect but never blocks the turn" fallback.
_NEAR_IDENTICAL_JACCARD_THRESHOLD = 0.85
_NEAR_IDENTICAL_MIN_TOKENS = 4


@dataclass(frozen=True, slots=True)
class FailureSignal:
    """One matched detector rule.

    ``name`` is the catalogue identifier (`docs/009 §3`). ``evidence``
    carries rule-specific debug info for the per-turn debugger and the
    critic's prompt.
    """

    name: str
    evidence: dict = field(default_factory=dict)


@dataclass(frozen=True, slots=True)
class DetectorResult:
    """Verdict + matched signals for one turn.

    Phase 1.5 fires the critic on *any* matched signal — the weighted
    aggregator in `docs/009 §7` is a later phase. ``signals`` is
    preserved so the assistant message's ``metadata.failure`` can
    carry the full list for downstream analysis.
    """

    signals: tuple[FailureSignal, ...]

    @property
    def should_critique(self) -> bool:
        return bool(self.signals)


def detect(
    *,
    user_text: str,
    final_text: str,
    final_tool_calls: Sequence[ToolUseBlock],
    iterations_used: int,
    max_iterations: int,
    intended_actions: IntendedActions | None = None,
    tool_uses_seen: int = 0,
) -> DetectorResult:
    """Run the Phase 1.5 heuristics against one completed turn.

    ``iterations_used`` is the number of primary iterations the loop
    actually consumed; ``max_iterations`` is the cap (`docs/005 §5.5`).
    A turn that exits because the cap was hit while still emitting
    tool_use blocks fires ``loop_exhausted``.

    ``intended_actions`` is the structured list the intent classifier
    emitted for this turn (issue #59). When set and containing
    verifiable entries, the detector compares it against
    ``tool_uses_seen`` (the total tool_use blocks the primary loop
    actually executed) and fires ``actions_declared_not_executed`` when
    the model declared a verifiable action but did not emit a single
    tool_use block. This is the heuristic version of the says-vs-did
    check (issue #60); a full DB-structural verification lands in a
    later phase.
    """
    signals: list[FailureSignal] = []

    stripped_final = final_text.strip()

    if not stripped_final and not final_tool_calls:
        signals.append(FailureSignal(name="empty_response"))

    if iterations_used >= max_iterations and final_tool_calls:
        signals.append(
            FailureSignal(
                name="loop_exhausted",
                evidence={
                    "iterations_used": iterations_used,
                    "max_iterations": max_iterations,
                },
            )
        )

    refusal_evidence = _match_refusal(stripped_final)
    if refusal_evidence is not None:
        signals.append(
            FailureSignal(name="refusal", evidence={"matched": refusal_evidence})
        )

    if _is_echoed_question(user_text, stripped_final):
        signals.append(FailureSignal(name="echoed_question"))

    verifiable = _verifiable_actions(intended_actions)
    if verifiable and tool_uses_seen == 0:
        signals.append(
            FailureSignal(
                name="actions_declared_not_executed",
                evidence={
                    "declared": [
                        {"kind": k, "summary": s} for k, s in verifiable
                    ],
                    "tool_uses_seen": tool_uses_seen,
                },
            )
        )

    return DetectorResult(signals=tuple(signals))


def _verifiable_actions(
    intended: IntendedActions | None,
) -> list[tuple[str, str]]:
    """Project the intended-actions list down to (kind, summary) tuples
    for the verifiable kinds only.

    The summary is a short human-readable hint the critic's prompt can
    reference ("you said you'd create_event 'dentist' but emitted no
    tool calls"). It's deliberately not the full action payload — that
    would balloon the critic's prompt for negligible signal.
    """
    if intended is None or not intended.actions:
        return []
    out: list[tuple[str, str]] = []
    for action in intended.actions:
        kind = getattr(action, "kind", None)
        if kind in _VERIFIABLE_KINDS:
            summary = (
                getattr(action, "summary", None)
                or getattr(action, "table", None)
                or getattr(action, "channel", None)
                or "(no summary)"
            )
            out.append((kind, str(summary)))
    return out


def _match_refusal(text: str) -> str | None:
    if not text:
        return None
    for pattern in _REFUSAL_PATTERNS:
        m = pattern.match(text)
        if m is not None:
            return m.group(0)
    return None


def _is_echoed_question(user_text: str, final_text: str) -> bool:
    """Heuristic match for "the assistant restated the question."

    Normalises both sides (lowercase, strip punctuation, collapse
    whitespace), then compares token-set Jaccard similarity. A reply
    of a few words is ignored — short answers like "yes" or
    "no" are not echoes.
    """
    if not user_text or not final_text:
        return False

    user_tokens = _tokenise(user_text)
    final_tokens = _tokenise(final_text)

    if len(user_tokens) < _ECHO_MIN_USER_TOKENS:
        return False
    if len(final_tokens) < _ECHO_MIN_USER_TOKENS:
        return False

    user_set = set(user_tokens)
    final_set = set(final_tokens)
    if not user_set or not final_set:
        return False

    intersection = len(user_set & final_set)
    union = len(user_set | final_set)
    if union == 0:
        return False
    jaccard = intersection / union
    return jaccard >= _ECHO_JACCARD_THRESHOLD


_TOKEN_RE = re.compile(r"[a-z0-9]+")


def _tokenise(text: str) -> list[str]:
    normalised = unicodedata.normalize("NFKD", text).lower()
    return _TOKEN_RE.findall(normalised)


# ---------------------------------------------------------------------------
# Cross-turn (pre-primary) detector — `docs/009 §3.2`
# ---------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class HistoryMessage:
    """Slim projection of an ``eidan.messages`` row the cross-turn
    detector consumes. The loop loads these via
    ``persistence.load_conversation_messages`` and projects each row
    into this shape so the detector module has no Postgres coupling
    (and tests can hand it synthetic histories cheaply).
    """

    role: str  # "user" | "assistant" | "tool"
    content: str
    metadata: dict = field(default_factory=dict)


def detect_pre_primary(
    *,
    user_text: str,
    history: Sequence[HistoryMessage],
    lookback: int = _DEFAULT_LOOKBACK,
) -> DetectorResult:
    """Run cross-turn signals against the conversation tail.

    ``history`` is the oldest→newest tail of the conversation,
    EXCLUDING the just-persisted user message (``user_text`` is that
    message, threaded in separately so the detector doesn't need to
    know its id). ``lookback`` bounds the slice the rules can see;
    longer windows would push the signal-to-noise the wrong way.

    Returns a :class:`DetectorResult` whose ``signals`` are the
    cross-turn hits in firing order. The aggregator (`docs/009 §7`)
    sums their weights via :func:`aggregate_weight` to decide whether
    to escalate to the classifier-fallback call.
    """
    window = list(history[-lookback:]) if lookback > 0 else list(history)

    signals: list[FailureSignal] = []
    stripped = user_text.strip()

    prefix_evidence = _match_correction_prefix(stripped)
    if prefix_evidence is not None:
        signals.append(
            FailureSignal(
                name="repeated_correction",
                evidence={"matched": prefix_evidence},
            )
        )

    direct = _match_direct_correction(stripped)
    if direct is not None:
        signals.append(
            FailureSignal(
                name="direct_correction_phrase",
                evidence={"matched": direct},
            )
        )

    frustration = _match_frustration(stripped)
    if frustration:
        signals.append(
            FailureSignal(
                name="frustration_marker",
                evidence={"matched": frustration},
            )
        )

    near = _find_near_identical_user_msg(stripped, window)
    if near is not None:
        index, jaccard = near
        signals.append(
            FailureSignal(
                name="near_identical_user_msg",
                evidence={"matched_index": index, "jaccard": round(jaccard, 3)},
            )
        )

    if _is_unanswered_question(stripped, window):
        signals.append(FailureSignal(name="unanswered_question"))

    if _prior_critic_fired(window):
        signals.append(FailureSignal(name="prior_critic_fired"))

    return DetectorResult(signals=tuple(signals))


def aggregate_weight(result: DetectorResult) -> float:
    """Sum the cross-turn weights from `docs/009 §3.2`.

    Within-turn / cross-cutting signals (`§3.1`, `§3.3`) are weighted
    elsewhere; this function intentionally only knows the §3.2 table.
    A signal absent from the table contributes 0 (forward-compat for
    new signals added without weight tuning).
    """
    return sum(
        _CROSS_TURN_WEIGHTS.get(s.name, 0.0) for s in result.signals
    )


def _match_correction_prefix(text: str) -> str | None:
    if not text:
        return None
    for pattern in _CORRECTION_PREFIXES:
        m = pattern.match(text)
        if m is not None:
            return m.group(0)
    return None


def _match_direct_correction(text: str) -> str | None:
    if not text:
        return None
    lowered = text.lower()
    for phrase in _DIRECT_CORRECTION_PHRASES:
        if phrase in lowered:
            return phrase
    return None


def _match_frustration(text: str) -> list[str]:
    if not text:
        return []
    hits: list[str] = []
    for pattern in _FRUSTRATION_PATTERNS:
        m = pattern.search(text)
        if m is not None:
            hits.append(m.group(0)[:40])
    return hits


def _find_near_identical_user_msg(
    current: str,
    window: Sequence[HistoryMessage],
) -> tuple[int, float] | None:
    """Token-set Jaccard between ``current`` and each prior user msg.

    Cheaper than embeddings and good enough as the fallback path the
    spec calls out. Skips messages shorter than
    ``_NEAR_IDENTICAL_MIN_TOKENS`` so a one-word "yes" doesn't
    collide with another short user turn.
    """
    current_tokens = set(_tokenise(current))
    if len(current_tokens) < _NEAR_IDENTICAL_MIN_TOKENS:
        return None
    best: tuple[int, float] | None = None
    for idx, msg in enumerate(window):
        if msg.role != "user":
            continue
        prior_tokens = set(_tokenise(msg.content))
        if len(prior_tokens) < _NEAR_IDENTICAL_MIN_TOKENS:
            continue
        union = len(current_tokens | prior_tokens)
        if union == 0:
            continue
        jaccard = len(current_tokens & prior_tokens) / union
        if jaccard >= _NEAR_IDENTICAL_JACCARD_THRESHOLD and (
            best is None or jaccard > best[1]
        ):
            best = (idx, jaccard)
    return best


def _is_unanswered_question(
    current_text: str,
    window: Sequence[HistoryMessage],
) -> bool:
    """Detects the ask-refuse-ask-again shape from `docs/009 §3.2`.

    Walks backwards through the window for the most recent
    user→assistant pair. Fires when the prior user message contains a
    ``?``, the prior assistant message matches a refusal prefix, and
    the current user message contains a ``?`` as well.
    """
    if "?" not in current_text:
        return False
    prior_user: str | None = None
    prior_assistant: str | None = None
    for msg in reversed(window):
        if prior_assistant is None and msg.role == "assistant":
            prior_assistant = msg.content.strip()
            continue
        if prior_assistant is not None and msg.role == "user":
            prior_user = msg.content.strip()
            break
    if prior_user is None or prior_assistant is None:
        return False
    if "?" not in prior_user:
        return False
    return _match_refusal(prior_assistant) is not None


def _prior_critic_fired(window: Sequence[HistoryMessage]) -> bool:
    for msg in window:
        critic = msg.metadata.get("critic")
        if isinstance(critic, dict) and critic.get("verdict"):
            return True
    return False


__all__ = [
    "DetectorResult",
    "FailureSignal",
    "HistoryMessage",
    "aggregate_weight",
    "detect",
    "detect_pre_primary",
]
