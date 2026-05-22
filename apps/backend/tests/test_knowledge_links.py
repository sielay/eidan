"""Knowledge-link extractor tests (issue #100 / `docs/017`).

The traversal half (BFS over eidan.knowledge_links) needs the real
PG fixture and runs in the integration test suite alongside the
HTTP routes. This file exercises the pure-Python extractor +
slugifier — fast, no DB.
"""

from __future__ import annotations

from eidan_backend.knowledge_links import (
    collect_missing,
    extract_links,
    slugify,
)


def test_extract_wikilink_simple() -> None:
    body = "See [[home-network-vlans]] for the layout."
    out = extract_links(body)
    assert len(out) == 1
    link = out[0]
    assert link.to_slug == "home-network-vlans"
    assert link.link_type == "wikilink"
    assert link.position_offset == body.index("[[")


def test_extract_two_segment_slug() -> None:
    body = "Also [[gardening/tomato-rotation]] applies here."
    out = extract_links(body)
    assert len(out) == 1
    assert out[0].to_slug == "gardening/tomato-rotation"


def test_extract_markdown_knowledge_link() -> None:
    body = "Read [the full notes](knowledge://network-spec) later."
    out = extract_links(body)
    assert len(out) == 1
    link = out[0]
    assert link.to_slug == "network-spec"
    assert link.link_type == "markdown"


def test_extract_ignores_non_knowledge_markdown_links() -> None:
    body = "Visit [google](https://google.com) — not a knowledge link."
    assert extract_links(body) == []


def test_extract_orders_by_offset() -> None:
    body = "Later: [[zulu]]. Earlier: see [[alpha]] above."
    out = extract_links(body)
    assert [link.to_slug for link in out] == ["zulu", "alpha"]
    # Position offsets are character indices into the body.
    assert out[0].position_offset == body.index("[[zulu]]")
    assert out[1].position_offset == body.index("[[alpha]]")


def test_extract_captures_context_window() -> None:
    body = (
        "First sentence about something else here. "
        "Second sentence mentions [[home-network-vlans]] in passing. "
        "Third sentence about something else again, completely unrelated."
    )
    out = extract_links(body)
    snippet = out[0].surrounding_context
    # The window includes the link and some surrounding prose.
    assert "[[home-network-vlans]]" in snippet
    assert "Second sentence" in snippet


def test_extract_skips_non_slug_brackets() -> None:
    body = "TODO: [[Foo Bar with Spaces]] is not a slug; [[also Caps]] either."
    # Capital + space content fails the slug grammar — no rows.
    assert extract_links(body) == []


def test_slugify_basic() -> None:
    assert slugify("Home Network VLANs") == "home-network-vlans"
    assert slugify("Trim   whitespace  ") == "trim-whitespace"


def test_slugify_two_segment_form() -> None:
    assert slugify("Gardening: Tomato Rotation") == "gardening/tomato-rotation"


def test_slugify_drops_diacritics() -> None:
    assert slugify("Café Périgord") == "cafe-perigord"


def test_collect_missing_returns_unresolved_targets() -> None:
    body = "see [[a]] and [[b]] and [[c]]."
    out = extract_links(body)
    assert collect_missing(out) == ["a", "b", "c"]
