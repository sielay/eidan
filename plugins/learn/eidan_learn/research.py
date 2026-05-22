"""DB-survey helpers for the `learn` tool.

Queries the three core memory tables most likely to hold what the
operator already knows about a topic:

- ``eidan.knowledge`` — skill-tagged markdown with a stored
  ``body_tsv`` GIN index (`docs/003 §5`). Full-text search lights up.
- ``eidan.notes``     — working memory captured by agents during
  conversations (`docs/003 §6`). ILIKE on body text.
- ``eidan.messages``  — append-only turn log (`docs/003 §3`). ILIKE
  on the assistant / user content, bounded to recent turns.

The surveys are deliberately small — the model is the consumer, and
we want a tight prompt rather than a wall of rows. Each surface caps
at a handful of results.

Identity-scoped: every query filters on the captured ``user_id`` so
the plugin honours single-operator pinning (`docs/011 §3.2`) and
will continue to honour multi-user RLS when it lands.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any
from uuid import UUID

_KNOWLEDGE_LIMIT = 5
_NOTES_LIMIT = 5
_MESSAGES_LIMIT = 8
_SNIPPET_LEN = 280


@dataclass(frozen=True, slots=True)
class KnowledgeHit:
    id: str
    skill: str
    title: str
    snippet: str


@dataclass(frozen=True, slots=True)
class NoteHit:
    id: str
    conversation_id: str | None
    snippet: str


@dataclass(frozen=True, slots=True)
class MessageHit:
    conversation_id: str
    role: str
    snippet: str


@dataclass(frozen=True, slots=True)
class ResearchSurvey:
    """The complete survey payload the tool returns to the model.

    Rendered as JSON so the model parses it deterministically. The
    surfaces are listed in the order they're most likely to be
    relevant: curated knowledge first, then working notes, then
    raw message mentions.
    """

    topic: str
    knowledge: list[KnowledgeHit]
    notes: list[NoteHit]
    messages: list[MessageHit]
    suggested_questions: list[str]

    def to_json(self) -> str:
        return json.dumps(
            {
                "topic": self.topic,
                "summary": (
                    f"{len(self.knowledge)} knowledge entries, "
                    f"{len(self.notes)} notes, "
                    f"{len(self.messages)} message mentions"
                ),
                "knowledge": [
                    {
                        "id": k.id,
                        "skill": k.skill,
                        "title": k.title,
                        "snippet": k.snippet,
                    }
                    for k in self.knowledge
                ],
                "notes": [
                    {
                        "id": n.id,
                        "conversation_id": n.conversation_id,
                        "snippet": n.snippet,
                    }
                    for n in self.notes
                ],
                "messages": [
                    {
                        "conversation_id": m.conversation_id,
                        "role": m.role,
                        "snippet": m.snippet,
                    }
                    for m in self.messages
                ],
                "suggested_questions": self.suggested_questions,
            },
            indent=2,
        )


def _snippet(text: str | None, length: int = _SNIPPET_LEN) -> str:
    if not text:
        return ""
    flattened = " ".join(text.split())
    return flattened if len(flattened) <= length else flattened[: length - 1] + "…"


def _topic_to_tsquery(topic: str) -> str:
    """Convert a free-form topic into a Postgres tsquery expression.

    Each whitespace-separated token becomes an AND clause; single-quote
    chars in the topic are stripped to keep the resulting query safe to
    parameterise (we still pass through asyncpg's argument binding).
    """
    cleaned = topic.replace("'", " ")
    tokens = [t for t in cleaned.split() if t]
    if not tokens:
        return ""
    return " & ".join(f"{t}:*" for t in tokens)


def _topic_like_pattern(topic: str) -> str:
    """Build an ILIKE pattern that matches the topic substring.

    Conservative: doesn't try to expand to synonyms. If the operator
    asks about "rust async", we look for that literal phrase first.
    """
    return f"%{topic.strip()}%"


async def survey_knowledge(
    conn: Any,
    *,
    user_id: UUID,
    topic: str,
) -> list[KnowledgeHit]:
    tsquery = _topic_to_tsquery(topic)
    if not tsquery:
        return []
    rows = await conn.fetch(
        """
        SELECT id, skill, title, body
        FROM eidan.knowledge
        WHERE user_id = $1
          AND deleted_at IS NULL
          AND body_tsv @@ to_tsquery('english', $2)
        ORDER BY ts_rank(body_tsv, to_tsquery('english', $2)) DESC,
                 updated_at DESC
        LIMIT $3
        """,
        user_id,
        tsquery,
        _KNOWLEDGE_LIMIT,
    )
    return [
        KnowledgeHit(
            id=str(row["id"]),
            skill=row["skill"],
            title=row["title"],
            snippet=_snippet(row["body"]),
        )
        for row in rows
    ]


async def survey_notes(
    conn: Any,
    *,
    user_id: UUID,
    topic: str,
) -> list[NoteHit]:
    """Note: the column is ``content``, not ``body`` (per docs/003 §6
    — distinct from ``eidan.knowledge`` which DOES use ``body``)."""
    pattern = _topic_like_pattern(topic)
    rows = await conn.fetch(
        """
        SELECT id, conversation_id, content
        FROM eidan.notes
        WHERE user_id = $1
          AND deleted_at IS NULL
          AND content ILIKE $2
        ORDER BY updated_at DESC
        LIMIT $3
        """,
        user_id,
        pattern,
        _NOTES_LIMIT,
    )
    return [
        NoteHit(
            id=str(row["id"]),
            conversation_id=str(row["conversation_id"])
            if row["conversation_id"] is not None
            else None,
            snippet=_snippet(row["content"]),
        )
        for row in rows
    ]


async def survey_messages(
    conn: Any,
    *,
    user_id: UUID,
    topic: str,
) -> list[MessageHit]:
    pattern = _topic_like_pattern(topic)
    rows = await conn.fetch(
        """
        SELECT conversation_id, role, content
        FROM eidan.messages
        WHERE user_id = $1
          AND deleted_at IS NULL
          AND content IS NOT NULL
          AND content ILIKE $2
          AND role IN ('user', 'assistant')
        ORDER BY created_at DESC
        LIMIT $3
        """,
        user_id,
        pattern,
        _MESSAGES_LIMIT,
    )
    return [
        MessageHit(
            conversation_id=str(row["conversation_id"]),
            role=row["role"],
            snippet=_snippet(row["content"]),
        )
        for row in rows
    ]


def _suggested_questions(
    topic: str,
    knowledge: list[KnowledgeHit],
    notes: list[NoteHit],
    messages: list[MessageHit],
) -> list[str]:
    """Deterministic question generation — shape, not the questions.

    The model will compose the real clarifying questions when it
    renders the survey to the user. This function provides a
    suggested skeleton based on coverage: when there's no signal in
    any source, the questions are about defining the topic; when
    there's some signal, they're about narrowing.
    """
    total = len(knowledge) + len(notes) + len(messages)
    if total == 0:
        return [
            f"What does '{topic}' mean to you in this context?",
            "What outcome would success look like?",
            "Are there any constraints (time, technology, audience)?",
        ]
    if total < 3:
        return [
            f"You've mentioned '{topic}' a few times — what changed since then?",
            "What's the goal for this round — explore, decide, or build?",
        ]
    return [
        f"You have prior material on '{topic}'. What's missing that you want to fill in?",
        "Should we synthesise across what you have, or focus on a specific gap?",
    ]


async def run_survey(
    conn: Any,
    *,
    user_id: UUID,
    topic: str,
) -> ResearchSurvey:
    """Run all three surveys + assemble the response."""
    topic = topic.strip()
    knowledge = await survey_knowledge(conn, user_id=user_id, topic=topic)
    notes = await survey_notes(conn, user_id=user_id, topic=topic)
    messages = await survey_messages(conn, user_id=user_id, topic=topic)
    return ResearchSurvey(
        topic=topic,
        knowledge=knowledge,
        notes=notes,
        messages=messages,
        suggested_questions=_suggested_questions(
            topic, knowledge, notes, messages
        ),
    )
