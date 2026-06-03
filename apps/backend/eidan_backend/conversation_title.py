# SPDX-License-Identifier: AGPL-3.0-or-later
"""Conversation auto-title — cheap haiku-class summary of the opening
exchange, stored on ``eidan.conversations.title`` per issue #48.

A single one-shot, no-tools provider call: feed the first user and
assistant turn, get back a ≤60-char label suitable for the sidebar.
Same shape as :mod:`eidan_backend.classifiers.scope` — lean system
prompt, JSON-free output, graceful degradation on parse failures.

The helper does not own its own DB session. Callers (``POST
/api/turn`` background hook, ``POST /api/conversations/{id}/
regenerate_title``) open the connection, fetch the first-turn pair,
call this helper, then write the title back via
:func:`eidan_backend.persistence.update_conversation_title`.
"""

from __future__ import annotations

from .classifiers.scope import _classifier_model
from .providers.base import Provider, UserMessage
_TITLE_MAX_CHARS = 60

_TITLE_SYSTEM = (
    "You write short titles for chat conversations.\n\n"
    "Given the opening user message and assistant reply, output ONE "
    f"label of at most {_TITLE_MAX_CHARS} characters that captures the "
    "topic. No quotes, no trailing punctuation, no prose, no prefix "
    'like "Title:". Title Case. If the exchange is empty or pure '
    "greeting, output exactly: Untitled."
)


def _clean(raw: str) -> str:
    """Strip provider noise (quotes, ``Title:`` prefix, trailing dots)
    and clamp to ``_TITLE_MAX_CHARS`` characters."""
    text = raw.strip()
    # Strip a leading ``Title:`` / ``Label:`` / etc. — small models
    # sometimes ignore the "no prefix" instruction.
    for prefix in ("title:", "label:", "topic:"):
        if text.lower().startswith(prefix):
            text = text[len(prefix) :].strip()
            break
    # Strip wrapping quotes (smart and ASCII).
    if len(text) >= 2 and text[0] in "\"'“‘" and text[-1] in "\"'”’":
        text = text[1:-1].strip()
    # Collapse newlines — the model occasionally returns a header + blurb.
    text = text.splitlines()[0].strip() if text else ""
    # Drop trailing punctuation that reads badly in a sidebar.
    text = text.rstrip(".!?,;:")
    if len(text) > _TITLE_MAX_CHARS:
        text = text[: _TITLE_MAX_CHARS - 1].rstrip() + "…"
    return text


async def generate_conversation_title(
    *,
    provider: Provider,
    user_text: str,
    assistant_text: str,
) -> str | None:
    """Summarise the opening exchange into a ≤60-char title.

    Returns ``None`` when the model refused / produced empty output or
    when it emitted the literal sentinel ``Untitled`` — callers persist
    ``None`` (i.e. leave ``title NULL``) in that case so the row stays
    autogen-eligible for a future regenerate.
    """
    prompt = (
        f"USER:\n{user_text.strip()}\n\n"
        f"ASSISTANT:\n{assistant_text.strip()}"
    )
    chunks: list[str] = []
    async for chunk in provider.stream_turn(
        model=_classifier_model(),
        messages=[UserMessage(role="user", content=prompt)],
        system=_TITLE_SYSTEM,
        max_tokens=48,
    ):
        chunks.append(chunk.text)

    text = _clean("".join(chunks))
    if not text or text.lower() == "untitled":
        return None
    return text
