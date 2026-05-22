"""Knowledge link extraction + traversal — `docs/017`.

Two halves:

1. **Extraction** (:func:`extract_links`) scans a knowledge body for
   wikilinks (``[[slug]]``) and knowledge-scheme markdown links
   (``[label](knowledge://slug)``), returning structured
   :class:`ExtractedLink` records the writer persists.
2. **Traversal** (:func:`neighbours`) returns the bounded BFS frontier
   around a knowledge node, walking the ``eidan.knowledge_links``
   adjacency rows the extractor wrote.

Resolution from a slug to a knowledge id happens in
:func:`resolve_slug` against the live ``eidan.knowledge.slug``
column. Unresolved targets are still persisted (``to_knowledge_id IS
NULL``) so the late-binding lookup from `docs/017 §3.3` can pick
them up when the operator later creates a node with the matching
slug.
"""

from __future__ import annotations

import re
import unicodedata
from collections.abc import Iterable
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any
from uuid import UUID

if TYPE_CHECKING:
    import asyncpg


# `docs/017 §2.4` — the two regexes the extractor applies. The slug
# grammar is anchored to `docs/017 §3.1`.
_WIKILINK_RE = re.compile(r"\[\[([a-z0-9][a-z0-9/_-]*)\]\]")
_MD_LINK_RE = re.compile(
    r"\[([^\]]+)\]\(knowledge://([a-z0-9][a-z0-9/_-]*)\)"
)

# Half-window around a match for ``surrounding_context``. The whole
# 200-char window lands so the UI can highlight the link inside the
# snippet without a re-fetch.
_CONTEXT_HALF = 100

_SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9_-]*(/[a-z0-9][a-z0-9_-]*)?$")


@dataclass(frozen=True, slots=True)
class ExtractedLink:
    """One raw extractor hit before resolution. Carries the literal
    slug from the body, the link type, the character offset, and the
    snippet used as `surrounding_context`."""

    to_slug: str
    link_type: str  # 'wikilink' | 'markdown'
    position_offset: int
    surrounding_context: str


def slugify(text: str) -> str:
    """`docs/017 §3.3` — the title-slugify fallback.

    NFKD normalises Unicode, lowercases, replaces runs of
    whitespace + ``_`` with ``-``, drops anything outside the slug
    grammar's character class, and trims leading / trailing ``-``.
    Two-segment titles (``Skill: Title``) collapse to ``skill/title``.
    """
    out = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode()
    out = out.lower().strip()
    parts: list[str] = []
    for seg in out.split(":", 1):
        token = re.sub(r"[^a-z0-9/_-]+", "-", seg).strip("-")
        if token:
            parts.append(token)
    if not parts:
        return ""
    return "/".join(parts)[:128]


def extract_links(body: str) -> list[ExtractedLink]:
    """Scan ``body`` for wikilinks + knowledge:// markdown links and
    return one :class:`ExtractedLink` per accepted match, sorted by
    character offset (`docs/017 §2.4`)."""
    hits: list[ExtractedLink] = []
    for match in _WIKILINK_RE.finditer(body):
        slug = match.group(1)
        offset = match.start()
        hits.append(
            ExtractedLink(
                to_slug=slug,
                link_type="wikilink",
                position_offset=offset,
                surrounding_context=_context_snippet(body, match.start(), match.end()),
            )
        )
    for match in _MD_LINK_RE.finditer(body):
        slug = match.group(2)
        offset = match.start()
        hits.append(
            ExtractedLink(
                to_slug=slug,
                link_type="markdown",
                position_offset=offset,
                surrounding_context=_context_snippet(body, match.start(), match.end()),
            )
        )
    hits.sort(key=lambda h: h.position_offset)
    return hits


def _context_snippet(body: str, start: int, end: int) -> str:
    left = max(0, start - _CONTEXT_HALF)
    right = min(len(body), end + _CONTEXT_HALF)
    snippet = body[left:right]
    return " ".join(snippet.split())


async def resolve_slug(
    conn: asyncpg.Connection,
    *,
    user_id: UUID,
    slug: str,
) -> UUID | None:
    """`docs/017 §3.3` — exact-slug lookup. Phase 1 only honours the
    literal slug match; case-fold + title-slugify fallbacks land
    alongside the writer hook that calls this resolver."""
    row = await conn.fetchrow(
        """
        SELECT id
        FROM eidan.knowledge
        WHERE user_id = $1 AND slug = $2 AND deleted_at IS NULL
        """,
        user_id,
        slug,
    )
    return row["id"] if row is not None else None


async def record_links_for(
    conn: asyncpg.Connection,
    *,
    user_id: UUID,
    from_knowledge_id: UUID,
    body: str,
) -> int:
    """Re-extract + replace adjacency rows for one source node.

    Per `docs/017 §4.3`: deletes the source's existing rows and
    inserts a fresh set. Returns the number of links written.
    Idempotent — calling twice with the same body produces the same
    final state.
    """
    await conn.execute(
        "DELETE FROM eidan.knowledge_links WHERE from_knowledge_id = $1",
        from_knowledge_id,
    )
    hits = extract_links(body)
    if not hits:
        return 0
    for hit in hits:
        resolved = await resolve_slug(conn, user_id=user_id, slug=hit.to_slug)
        await conn.execute(
            """
            INSERT INTO eidan.knowledge_links
                (user_id, from_knowledge_id, to_knowledge_id, to_slug,
                 link_type, position_offset, surrounding_context)
            VALUES
                ($1, $2, $3, $4, $5, $6, $7)
            """,
            user_id,
            from_knowledge_id,
            resolved,
            hit.to_slug,
            hit.link_type,
            hit.position_offset,
            hit.surrounding_context,
        )
    return len(hits)


@dataclass(frozen=True, slots=True)
class NeighbourNode:
    """One node in a traversal frontier. ``hops`` is the BFS depth
    at which this node was first reached from the seed (0 for the
    seed itself, 1 for direct outbound + backlink targets, …)."""

    id: UUID
    slug: str | None
    title: str | None
    hops: int


async def neighbours(
    conn: asyncpg.Connection,
    *,
    user_id: UUID,
    seed_id: UUID,
    depth: int = 1,
    limit: int = 64,
) -> list[NeighbourNode]:
    """BFS frontier around ``seed_id`` up to ``depth`` hops.

    Walks both outbound (``from_knowledge_id = seed``) AND inbound
    (``to_knowledge_id = seed``) edges per `docs/017 §5`. The seed
    itself is the first row in the result. ``limit`` bounds the
    visited set so a heavily-linked node doesn't fan out without
    bound on a low-resource host.
    """
    if depth < 1:
        return await _seed_only(conn, user_id=user_id, seed_id=seed_id)

    visited: dict[UUID, int] = {seed_id: 0}
    frontier: list[UUID] = [seed_id]
    for hop in range(1, depth + 1):
        if not frontier:
            break
        rows = await conn.fetch(
            """
            SELECT
                CASE
                    WHEN from_knowledge_id = ANY($2) THEN to_knowledge_id
                    ELSE from_knowledge_id
                END AS neighbour_id
            FROM eidan.knowledge_links
            WHERE user_id = $1
              AND (
                from_knowledge_id = ANY($2)
                OR to_knowledge_id = ANY($2)
              )
              AND CASE
                    WHEN from_knowledge_id = ANY($2) THEN to_knowledge_id
                    ELSE from_knowledge_id
                  END IS NOT NULL
            """,
            user_id,
            frontier,
        )
        next_frontier: list[UUID] = []
        for row in rows:
            nid = row["neighbour_id"]
            if nid is None or nid in visited:
                continue
            if len(visited) >= limit:
                break
            visited[nid] = hop
            next_frontier.append(nid)
        frontier = next_frontier

    if not visited:
        return []

    ids = list(visited.keys())
    rows = await conn.fetch(
        """
        SELECT id, slug, title
        FROM eidan.knowledge
        WHERE user_id = $1 AND id = ANY($2) AND deleted_at IS NULL
        """,
        user_id,
        ids,
    )
    rows_by_id: dict[UUID, Any] = {r["id"]: r for r in rows}
    out: list[NeighbourNode] = []
    for nid in ids:
        row = rows_by_id.get(nid)
        if row is None:
            continue
        out.append(
            NeighbourNode(
                id=nid,
                slug=row.get("slug"),
                title=row.get("title"),
                hops=visited[nid],
            )
        )
    out.sort(key=lambda n: (n.hops, str(n.slug or n.id)))
    return out


async def _seed_only(
    conn: asyncpg.Connection,
    *,
    user_id: UUID,
    seed_id: UUID,
) -> list[NeighbourNode]:
    row = await conn.fetchrow(
        """
        SELECT id, slug, title
        FROM eidan.knowledge
        WHERE user_id = $1 AND id = $2 AND deleted_at IS NULL
        """,
        user_id,
        seed_id,
    )
    if row is None:
        return []
    return [
        NeighbourNode(
            id=row["id"],
            slug=row.get("slug"),
            title=row.get("title"),
            hops=0,
        )
    ]


def collect_missing(links: Iterable[ExtractedLink]) -> list[str]:
    """Helper: list of unresolved target slugs (`docs/017 §4.2`).

    Useful for writing into ``messages.metadata.missing_links[]`` so
    the operator's debugger can flag broken links without a join.
    """
    return [link.to_slug for link in links]


__all__ = [
    "ExtractedLink",
    "NeighbourNode",
    "collect_missing",
    "extract_links",
    "neighbours",
    "record_links_for",
    "resolve_slug",
    "slugify",
]
