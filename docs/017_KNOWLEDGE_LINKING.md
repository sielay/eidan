# 017 — Knowledge linking (graph traversal)

Status: Draft
Owner: Core
Related: `docs/ARCHITECTURE.md` (Memory model — knowledge),
`docs/003_MEMORY_DDL.md` (§5 `knowledge`, §12 reserved follow-ups),
`docs/004_SCHEMAS.md` (`memory/*` DTOs),
`docs/005_AGENTIC_LOOP.md` (§5.4 tool surface, §5.5 primary loop),
`docs/006_BEHAVIOURS_TRIGGERS.md` (§2 ToolSpec),
`docs/010_COST_BUDGETING.md` (§4 per-turn soft cap),
`docs/013_MCP_SURFACE.md` (§3.4 host catalogue),
`docs/014_UI_SURFACE.md` (§5.3 knowledge browser)

This document specifies how `eidan.knowledge` rows **reference each
other** so the agent can traverse memory as a graph, not just as a
flat list of skill-tagged leaves. It pins:

- The canonical **link syntax** authors write inside knowledge
  bodies, and the subset the extractor recognises.
- The **addressing scheme** that turns a link target into a row —
  human-readable slugs as the surface, UUIDs as the durable
  identity, and the resolution rules that bridge them.
- The **link index** — a new core table that records every
  outbound reference parsed from a body — with the read paths
  that drive both forward queries ("what does this node link to?")
  and backlink queries ("what links here?").
- The **traversal API**: how an agentic-loop call asks for
  n-hop neighbours, what bounds the runner enforces, how cycles
  are handled, and how cost is contained.
- How linking **coexists with the skill hierarchy**. Skill tags
  remain a categorical axis; links are a lateral graph; queries
  combine them but do not fold one into the other.
- The **UI rendering** of backlinks on the memory browser
  (`014 §5.3`).
- The **migration packaging** decision — whether the link index
  ships with the initial memory DDL (`003`) or as a follow-up.

The shape sits one level above the context-dilution doctrine
(when knowledge loads): this document specifies the **shape of the
thing being loaded**. A loaded knowledge row is a node in a graph,
and that graph is part of the row's identity.

Out of scope (deferred to follow-ups, see §11):

- **Cross-table linking.** Phase 1 links go knowledge → knowledge
  only. Linking a knowledge row to a note, an event, or a message
  is reserved; see §11.
- **Embedded media** (image / audio inside knowledge bodies).
  `003 §5` does not pin a media model and this document inherits
  the reservation.
- **Ranking signals on backlinks** (PageRank-style weighting,
  recency decay). The Phase 1 query surface is structural; an
  embedding- or telemetry-weighted overlay is reserved.
- **Two-way / typed links** (`is_related_to`, `contradicts`,
  `supersedes` …). Phase 1 ships untyped links plus the
  `link_type` discriminator that records *how* the link was
  written (wikilink vs markdown), not *what* the link means.
- **Anchor / section links** (`[[Foo#heading]]`). The extractor
  ignores the `#heading` suffix in Phase 1 and links resolve to
  the whole row; preserving the anchor for the UI is reserved.

---

## 1. Vocabulary

| Term                  | Meaning                                                                                                                                                  |
|-----------------------|----------------------------------------------------------------------------------------------------------------------------------------------------------|
| **Knowledge node**    | One row in `eidan.knowledge` (`003 §5`). Identified by `id` (uuid) and addressed by `slug` (this document, §3).                                          |
| **Wikilink**          | The `[[target]]` form. Canonical for in-body author intent. The target string is resolved per §3.3.                                                       |
| **Knowledge markdown link** | `[label](knowledge://<slug>)`. The escape hatch for cases where the rendered link needs custom anchor text. Not the same as a generic markdown link. |
| **Slug**              | A short, lowercase, hyphenated string that addresses a knowledge node within a user. Stable across title edits.                                          |
| **Link index**        | The `eidan.knowledge_links` table introduced in §4. One row per extracted outbound reference per source.                                                  |
| **Forward query**     | "What does node X link to?" — `WHERE from_knowledge_id = X`.                                                                                              |
| **Backlink query**    | "What links to node X?" — `WHERE to_knowledge_id = X`.                                                                                                    |
| **Unresolved link**   | A link whose target slug does not match any live knowledge node at extraction time. `to_knowledge_id IS NULL`; `to_slug` is kept verbatim for late binding. |
| **Traversal frontier**| The set of node ids that the next hop of a graph walk will visit.                                                                                         |
| **Hop**               | One step in a graph traversal. The starting node is hop 0; its direct neighbours are hop 1.                                                              |
| **Context-expansion move** | A primary-call tool call that asks "given node X already in context, follow its links N hops and return what you find." See §6.                       |

---

## 2. Link syntax

Two forms are recognised by the extractor. The first is canonical;
the second is an escape hatch.

### 2.1 Wikilinks (canonical)

```
See also [[home-network-vlans]] and [[gardening/tomato-rotation]].
```

The form is `[[target]]`. The `target` is the literal slug of a
knowledge node, with the `<skill>/` prefix optional (§3.3 explains
when each form resolves).

**Why wikilinks are canonical:**

- They render legibly in raw markdown without obscuring the link
  target — the operator scanning a body sees what an in-body
  reference refers to without parsing a URL.
- They have no anchor-text affordance, which keeps the body
  consistent: the linked node's title is the anchor. A node renamed
  later remains addressable through its slug, and the rendered UI
  picks up the new title automatically (§7).
- They survive copy/paste between bodies without rewriting (no
  per-document relative paths).

### 2.2 Knowledge markdown links (escape hatch)

```
See also [the VLAN deep-dive](knowledge://home-network-vlans).
```

The form is `[label](knowledge://<slug>)`. The `label` is free
text; the URL scheme is exactly `knowledge://` followed by a slug
(no path segments beyond the slug, no query, no fragment in Phase
1). The extractor strips the scheme and resolves the slug per
§3.3.

**Why we keep this form at all:**

- Custom anchor text is occasionally indispensable (the linked
  node's title is too terse, or the body needs to refer to the
  node by an alias).
- It survives a markdown-aware export pipeline. A renderer that
  does not understand wikilinks but does understand the
  `knowledge://` scheme can still display a clickable label.

### 2.3 Forms the extractor does NOT treat as knowledge links

- Plain markdown `[label](./foo.md)` or `[label](/memory/...)`.
  Filesystem and host-route paths are author error; the extractor
  ignores them. The UI renders them as broken links per the
  markdown renderer's default behaviour.
- External URLs (`[docs](https://example.com)`). These are
  passed through verbatim and never enter `knowledge_links`.
- Inline `[[bracketed text that is not a slug]]`. A bracketed
  span containing whitespace, uppercase letters, or characters
  outside `[a-z0-9/_-]` does not match the wikilink pattern and
  is rendered as literal text. Authors who want literal `[[...]]`
  in body text are unaffected.

### 2.4 Regular expressions (Phase 1)

The extractor is deterministic. It applies two regexes in a single
pass over the body and emits one record per match:

```
WIKILINK_RE = r"\[\[([a-z0-9][a-z0-9/_-]*)\]\]"
MD_LINK_RE  = r"\[([^\]]+)\]\(knowledge://([a-z0-9][a-z0-9/_-]*)\)"
```

Both regexes are anchored to the slug grammar in §3.1. A match
that captures a slug containing `/` is treated as a
`skill/slug` form (§3.3).

The order of emission is by character offset in the body, which
becomes the link's `position_offset` (§4.1).

---

## 3. Identity and addressing

### 3.1 Slug grammar

A slug is a non-empty string matching
`^[a-z0-9][a-z0-9_-]*(/[a-z0-9][a-z0-9_-]*)?$` — one or two
segments, each lowercase alphanumeric with `_` / `-`, separated
by a single `/`. Maximum length 128 characters end-to-end.

The grammar deliberately excludes capital letters and whitespace
so wikilink matching is unambiguous and the resolver does not
need to normalise case.

### 3.2 `eidan.knowledge.slug`

A new column on `eidan.knowledge`:

```sql
ALTER TABLE eidan.knowledge
  ADD COLUMN slug text;

-- One live slug per user. Soft-deleted rows are excluded so a new
-- node can reuse a tombstoned slug.
CREATE UNIQUE INDEX uq_knowledge_user_slug
  ON eidan.knowledge (user_id, slug)
  WHERE deleted_at IS NULL
    AND slug IS NOT NULL;

ALTER TABLE eidan.knowledge
  ADD CONSTRAINT knowledge_slug_chk CHECK (
    slug IS NULL
    OR slug ~ '^[a-z0-9][a-z0-9_-]*(/[a-z0-9][a-z0-9_-]*)?$'
  );
```

Backfill (run inside the same additive migration that creates the
column, §9):

```sql
-- Backfill: derive slug from skill + title for every live row.
-- The slugifier matches the host's Python `slugify()` (NFKD,
-- lowercase, ascii-only, runs of non-alphanum collapse to '-').
UPDATE eidan.knowledge SET
  slug = lower(regexp_replace(
    regexp_replace(unaccent(skill || '/' || title), '[^a-zA-Z0-9]+', '-', 'g'),
    '(^-|-$)', '', 'g'
  ))
WHERE slug IS NULL
  AND deleted_at IS NULL;
```

`slug` is **NOT NULL after backfill** in application code, but the
column stays nullable in DDL so a future plugin that imports
knowledge ahead of slug-resolution can stage rows. The unique
index is partial on `slug IS NOT NULL` accordingly.

Slugs are immutable in normal use. Renaming a slug is a privileged
operation (`PATCH /api/memory/knowledge/:id` with `slug=`) that
also re-resolves any **unresolved** inbound links whose
`to_slug` matches the new value (§4.4).

### 3.3 Resolution rules

Given a wikilink target string `T` and a user `U`, the resolver
applies these rules in order, stopping at the first that
produces a single live row:

1. **Exact slug match.** If `T` matches no `/`, look up
   `(user_id = U, slug = T)`. Single hit → resolved.
2. **Skill-qualified slug.** If `T` is `<skill>/<rest>`, look up
   `(user_id = U, slug = T)`. Single hit → resolved.
3. **Skill-prefix fallback.** If step 1 missed and `T` has no `/`,
   look up rows where `slug` ends with `/<T>` (one row per skill
   that owns a slug with that tail). If exactly one row matches
   across all skills → resolved.
4. **Title slugify fallback.** Slugify `T` itself using the same
   slugifier as §3.2 and re-try step 1. This is the path that
   makes `[[Home Network VLANs]]` work when the author wrote a
   human-readable string the renderer would have liked to render
   as a label.

If none of the above produce a single hit, the link is
**unresolved**:

- Zero hits → `to_knowledge_id` is NULL; `to_slug` is the
  original target string.
- Two or more hits → `to_knowledge_id` is NULL; `to_slug` carries
  a suffix `?ambiguous` so the UI can render an explicit warning
  and the resolver does not silently late-bind one of the
  candidates.

The resolver runs at extraction time (§4.3). It is the only place
the rules above are codified.

### 3.4 Why slugs *and* UUIDs

UUIDs are durable, opaque, and immune to rename — the database's
identity story. Slugs are friendly, type-able, and survive copy
into a body — the human's identity story. They serve different
readers and need to coexist:

- Bodies reference **slugs** because a UUID embedded in a body
  is unreadable.
- The link index stores **both** the resolved `to_knowledge_id`
  (UUID) and the literal `to_slug`, so a slug change can be
  re-resolved and a backlink query against a renamed slug still
  works.
- The traversal API (§5) accepts **either**: an `id` argument
  takes a UUID, a `slug` argument takes a slug, exactly one of
  them is required.

The cost of the dual addressing is one extra column on the link
index and the resolver in §3.3. Both are cheap. The win is
operator ergonomics that survive every rename the agent or user
might perform.

---

## 4. `eidan.knowledge_links`

The link index. One row per extracted outbound reference, per
source body, per writer pass.

### 4.1 Schema

```sql
CREATE TABLE eidan.knowledge_links (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             uuid        NOT NULL
                                  REFERENCES eidan.users(id)
                                  ON DELETE CASCADE,

  from_knowledge_id   uuid        NOT NULL
                                  REFERENCES eidan.knowledge(id)
                                  ON DELETE CASCADE,
  to_knowledge_id     uuid        REFERENCES eidan.knowledge(id)
                                  ON DELETE SET NULL,
  to_slug             text        NOT NULL,

  link_type           text        NOT NULL,
  position_offset     integer     NOT NULL,
  surrounding_context text        NOT NULL,

  created_at          timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT knowledge_links_link_type_chk CHECK (
    link_type IN ('wikilink', 'markdown')
  ),
  CONSTRAINT knowledge_links_offset_chk CHECK (
    position_offset >= 0
  )
);

-- Forward queries: "what does node X link to?"
CREATE INDEX idx_knowledge_links_from
  ON eidan.knowledge_links (from_knowledge_id, position_offset);

-- Backlink queries: "what links to node X?"
CREATE INDEX idx_knowledge_links_to
  ON eidan.knowledge_links (to_knowledge_id)
  WHERE to_knowledge_id IS NOT NULL;

-- Late-binding lookup: "find every unresolved link that mentions slug S"
CREATE INDEX idx_knowledge_links_to_slug_unresolved
  ON eidan.knowledge_links (user_id, to_slug)
  WHERE to_knowledge_id IS NULL;

-- Per-user pagination over recent links (used by the memory browser).
CREATE INDEX idx_knowledge_links_user_created
  ON eidan.knowledge_links (user_id, created_at DESC);
```

Notes on shape:

- **No `updated_at`, no soft-delete.** Link rows are immutable
  inside an extraction window. Re-extraction (§4.3) deletes the
  source's existing rows and inserts a fresh set; there is no
  middle state to keep `updated_at` honest.
- **`user_id` is denormalised** from `from_knowledge_id`. The
  redundancy buys two things: cheap partial indexes on
  `(user_id, to_slug)` for the late-binding lookup, and a
  guard against accidentally cross-user link writes when the
  resolver's input is the slug only.
- **`surrounding_context` is the snippet** the UI renders in a
  backlink row. Phase 1 captures ±100 characters around the link
  match, normalising whitespace. The snippet is fixed at write
  time so the backlinks UI does not have to refetch the source
  body.
- **`position_offset`** is the character offset of the link's
  first `[` in the source body. It provides a stable order on
  forward queries (links rendered in source order) and supports
  in-place de-duplication when the same target is referenced
  multiple times in a body — Phase 1 keeps duplicates, but a
  future ranking layer can collapse them by `(from, to, count)`.

### 4.2 What the extractor produces

For every accepted match in the body, one row with:

- `from_knowledge_id` — the source knowledge node's id.
- `to_knowledge_id` — the resolved target id, or NULL.
- `to_slug` — the literal slug string from the body, **after**
  the resolution rules in §3.3 normalised it (so a title-slugify
  fallback writes the slugified form, not the original
  human-readable string).
- `link_type` — `wikilink` or `markdown` per the regex that
  matched.
- `position_offset` — character offset.
- `surrounding_context` — ±100 chars window with the link itself
  preserved inside the snippet (so the UI can highlight it).

The extractor runs **inside the same transaction** as the
`knowledge` write. Two-phase commit on body and links is not
required because both rows are local to one database.

### 4.3 Re-extraction on update

When a knowledge row's body is updated:

```sql
BEGIN;
  UPDATE eidan.knowledge SET body = $new WHERE id = $id;
  DELETE FROM eidan.knowledge_links WHERE from_knowledge_id = $id;
  INSERT INTO eidan.knowledge_links (...) VALUES (...);  -- one row per link
COMMIT;
```

The delete-then-insert shape is intentional. Diffing extracted
links against existing rows to produce a minimal update is
needlessly clever for the size of body we are dealing with
(`eidan.knowledge.body` is markdown, typically a few KiB). The
delete-and-insert path is one transaction, one source of truth,
no diff bugs.

The implementation lives in `apps/backend` — there is no
trigger. Trigger-based extraction would couple a body-shape
parser to the database, which fights the convention that
`apps/backend` owns the runtime parser (`004_SCHEMAS.md` style).

### 4.4 Late binding on insert / undelete

When a knowledge row is **inserted** (or **un-tombstoned**) with
a slug `S` for user `U`, the host runs:

```sql
UPDATE eidan.knowledge_links
SET to_knowledge_id = $new_id
WHERE user_id = $U
  AND to_slug = $S
  AND to_knowledge_id IS NULL;
```

This is the "create the target after the link was written"
path. It makes the order-of-writing irrelevant: an agent that
writes a reference to a not-yet-existing node and then later
creates the node ends up with a resolved link without a
re-extraction pass over the source body.

The reverse — a knowledge row is **hard-deleted** — relies on
the FK `ON DELETE SET NULL` (§4.1) to demote outbound references
to unresolved. Soft-deletes (`deleted_at IS NOT NULL`) do **not**
flip the FK column to NULL; the link still points at the
tombstone, and the read path (§5.1) filters tombstones out at
query time.

---

## 5. Read paths

The link index drives three query shapes. All three are pinned
schemas (`004_SCHEMAS.md`) and exposed both as in-process Python
APIs (`apps/backend`) and as MCP tools on the host catalogue
(`013 §3.4`, additive).

### 5.1 Forward — "what does this node link to?"

```sql
SELECT kl.to_knowledge_id,
       kl.to_slug,
       kl.link_type,
       kl.position_offset,
       k.skill,
       k.title
FROM   eidan.knowledge_links kl
LEFT JOIN eidan.knowledge k
       ON k.id = kl.to_knowledge_id
      AND k.deleted_at IS NULL
WHERE  kl.from_knowledge_id = $node_id
ORDER  BY kl.position_offset;
```

The `LEFT JOIN` is deliberate: an unresolved link or a link
pointing at a soft-deleted row still appears in the result with
NULL `skill` / `title`, so the UI can render the broken link with
its slug.

### 5.2 Backlinks — "what links here?"

```sql
SELECT kl.from_knowledge_id,
       kl.surrounding_context,
       kl.link_type,
       kl.position_offset,
       k.skill,
       k.title
FROM   eidan.knowledge_links kl
JOIN   eidan.knowledge k
       ON k.id = kl.from_knowledge_id
      AND k.deleted_at IS NULL
WHERE  kl.to_knowledge_id = $node_id
ORDER  BY k.updated_at DESC, kl.position_offset;
```

Backlinks **never** include unresolved-link rows (those have no
target to query against), and they hide source rows that are
soft-deleted (the inner join). The UI's backlinks panel (`014
§5.3`) reads from this exact query.

### 5.3 n-hop traversal — "neighbourhood around this node"

A bounded breadth-first walk. Pseudocode in §6.1. The query is
not a single SQL statement; the runner alternates SELECTs on the
forward index with a Python-side visited set. A recursive CTE
would work but the bounds we want (max hops, max nodes, dedup
across visited frontier) are easier to enforce in application
code than as Postgres parameters.

---

## 6. Agentic-loop integration

### 6.1 The `knowledge.follow_links` tool

A new in-process tool, registered on the host's tool surface
(`005 §5.4`) and exposed via the host MCP server's catalogue
(`013 §3.4`):

```json
{
  "name": "knowledge.follow_links",
  "description": "Given a knowledge node (by id or slug), return its n-hop neighbourhood as a graph: nodes and the links between them. Use this to widen recall laterally when the answer needs more than one related entry.",
  "input_schema": {
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "id":        { "type": "string", "format": "uuid" },
      "slug":      { "type": "string" },
      "hops":      { "type": "integer", "minimum": 1, "maximum": 3, "default": 1 },
      "max_nodes": { "type": "integer", "minimum": 1, "maximum": 50, "default": 20 },
      "direction": { "enum": ["out", "in", "both"], "default": "out" },
      "link_types": {
        "type": "array",
        "items": { "enum": ["wikilink", "markdown"] }
      }
    },
    "oneOf": [
      { "required": ["id"] },
      { "required": ["slug"] }
    ]
  }
}
```

Pseudocode for the traversal:

```python
async def follow_links(
    user_id: UUID,
    *,
    start_id: UUID | None,
    start_slug: str | None,
    hops: int,
    max_nodes: int,
    direction: str,
    link_types: frozenset[str] | None,
) -> GraphResponse:
    start = await resolve_start(user_id, start_id, start_slug)
    visited: set[UUID] = {start.id}
    frontier: set[UUID] = {start.id}
    nodes: dict[UUID, NodeSummary] = {start.id: summary(start)}
    edges: list[EdgeSummary] = []

    for _ in range(hops):
        if not frontier or len(visited) >= max_nodes:
            break
        rows = await fetch_links(user_id, frontier, direction, link_types)
        next_frontier: set[UUID] = set()
        for row in rows:
            edges.append(edge(row))
            for neighbour_id in (row.from_id, row.to_id):
                if neighbour_id and neighbour_id not in visited:
                    visited.add(neighbour_id)
                    if len(visited) > max_nodes:
                        break
                    nodes[neighbour_id] = summary_for(neighbour_id)
                    next_frontier.add(neighbour_id)
        frontier = next_frontier

    return GraphResponse(nodes=list(nodes.values()), edges=edges,
                         truncated=len(visited) >= max_nodes)
```

Two properties:

- **Visited set is per-call**, so cycles do not loop. A → B → A
  collapses to a single edge B → A (the second occurrence is
  dropped at the visited check), with the node A appearing once.
- **`max_nodes` is the hard stop**, not `hops`. A dense
  neighbourhood truncates at the node budget and reports
  `truncated: true`. The primary call can decide whether to
  re-issue with a smaller `hops` or a different `direction`
  on the same node.

### 6.2 Cost containment

Following links costs tokens — every new node added to the
graph response is more text the next provider call has to
ingest. The Phase 1 envelope is:

- **Hard cap on `hops`** at 3. Beyond three hops the
  neighbourhood is usually too broad to be useful and almost
  always blows the per-turn soft cap (`010 §4`).
- **Hard cap on `max_nodes`** at 50. The default is 20.
- **Node summaries, not bodies.** The tool returns each node's
  `id`, `slug`, `skill`, `title`, and the first 300 characters
  of its body. The primary call follows up with
  `knowledge.get` (existing `013 §3.4` tool, additive on
  `body` retrieval) to load full bodies only for the nodes it
  needs.
- **No transitive auto-load.** The tool returns a graph
  response; it does **not** rewrite the primary call's system
  prompt or otherwise inject the neighbourhood into context
  automatically. The model decides which nodes to fetch in
  full.

These bounds align with the per-turn cap shape in `010 §4` and
keep the worst-case traversal predictable.

### 6.3 Context-expansion behaviour

A plugin-contributed behaviour (`006 §2`) may register the tool
under an AUTO trigger so that the primary model is reminded of
its existence when a user message references "related",
"see also", "what else", or similar. The behaviour's prompt
stanza is a single line:

```
When the answer plausibly spans multiple knowledge entries,
use `knowledge.follow_links` once on the most relevant node
before drafting the response.
```

Phase 1 ships this stanza as a core-bundled behaviour with
`priority: 10` so it is dominated by domain-specific behaviours
but always present.

---

## 7. Hierarchy vs graph

Skill tags (`eidan.knowledge.skill`, `003 §5`) and the link
index serve **different recall shapes** and Phase 1 keeps them
separate:

| Axis            | Skill tag                                       | Link index                                             |
|-----------------|--------------------------------------------------|---------------------------------------------------------|
| Cardinality     | One per node (free-text, small per-user set).   | Many per node (zero or more outbound, zero or more inbound). |
| Semantics       | "What domain is this about?"                    | "What is this node *related to* by author intent?"      |
| Query           | `WHERE skill = $S`                              | Forward / backlink / n-hop (§5).                        |
| Editorial path  | Set by the agent when the node is written.      | Inferred from the body at every write.                  |
| Naming          | Open vocabulary, no validation.                 | Closed grammar — slugs must match §3.1.                 |

The two combine **at query composition time**, not at storage
time. A recall plan that wants "everything tagged
`home-network` plus everything two hops out from
`home-network/router-config`" runs two queries (one against
`eidan.knowledge` by skill, one against
`knowledge.follow_links`) and unions the results in the
caller. There is no `knowledge_links.skill_tag` column and no
plan to add one.

This separation is deliberate. Skill is **categorisation**;
links are **lateral structure**. Conflating them would mean a
rename of the skill of node A invalidates every link that uses
the `<skill>/<slug>` form — which is exactly the rename
fragility the slug column was added to avoid.

---

## 8. UI rendering

The memory browser's knowledge detail view (`014 §5.3`)
inherits one new section.

### 8.1 The "Backlinks" panel

Renders below the body, full-width, collapsed by default when
the panel has more than five entries:

```
┌── Backlinks (3) ─────────────────────────────────────┐
│                                                       │
│  Home network — router config                         │
│    …see also [[home-network-vlans]] for the rule…    │
│                                                       │
│  Networking notes — 2026-04-12                        │
│    …the VLAN setup described in [[home-network-      │
│    vlans]] applies here as well…                     │
│                                                       │
│  Gardening — sensor mesh                              │
│    …reuse the management VLAN ([[home-network-       │
│    vlans]]) for telemetry…                            │
│                                                       │
└───────────────────────────────────────────────────────┘
```

Each row carries: the source node's title (linked to
`/memory/knowledge/<id>`), the `surrounding_context` snippet
with the link span highlighted, and the source's skill tag as
a small badge.

The panel reads from the §5.2 query, paginated cursor-based
on `(updated_at DESC, position_offset)`. Phase 1 ships
read-only — the operator cannot dismiss a backlink from the
UI; the backlink disappears when the source body is edited to
remove the reference.

### 8.2 Unresolved-link rendering inside a body

When the markdown renderer encounters a wikilink that resolved
to no live node, it renders the slug in muted text with a
dotted underline and a tooltip:

```
…see also [[home-network-vlans]] for the rule…
                ^^^^^^^^^^^^^^^^^^
                Not yet a knowledge entry. Create one?
```

Clicking the muted span opens the "New knowledge" form with
the slug pre-filled. This is the only Phase 1 write affordance
on the knowledge browser; it lives here rather than as a
top-level "+" button because the most common reason an
operator creates a knowledge node is "fill in a reference an
existing node made."

### 8.3 Forward-links rendering

A small "Links out (N)" inline disclosure renders above the
backlinks panel, listing the §5.1 result as a flat row of
chips. Each chip is the target's title (or slug for
unresolved targets) linked to its detail view.

---

## 9. Migration packaging

The link index is delivered as a **single additive core
migration**, separate from the initial memory DDL in `003 §11`.
Two migrations, not one:

- `003 §11`'s init migration creates the eight memory tables
  without `slug` and without `knowledge_links`.
- A follow-up
  `migrations/versions/<UTC-timestamp>_knowledge_linking.py`
  adds the `slug` column to `eidan.knowledge`, runs the backfill
  from §3.2, and creates `eidan.knowledge_links` and its indexes.

### 9.1 Why not bundle into the init migration

Two reasons, both load-bearing:

- **The extractor is the long pole.** The link index is useful
  only when the application-side extractor produces correct
  rows. Shipping the table in the init migration would create a
  window where rows exist as `knowledge` writes but the index is
  empty, and the §5.2 backlink panel renders confusingly empty
  for every node. Shipping the table at the same time as the
  extractor keeps the contract honest: when this migration is
  applied, the host knows how to populate it.
- **`003`'s init migration is hot-path code for every new
  deployment.** Adding an extractor-dependent table delays the
  first turn an operator can run. The link index is a
  curated-recall feature, not a turn-gating dependency, so it
  can land in a second core release without holding up the
  first.

### 9.2 Upgrade safety

The follow-up migration is **idempotent and rerunnable** by
Alembic discipline:

- `ALTER TABLE ... ADD COLUMN slug` is rerunnable because Alembic
  records the version; the `IF NOT EXISTS` form is unnecessary
  because Alembic refuses to apply a revision twice.
- The backfill `UPDATE ... WHERE slug IS NULL` is a no-op on a
  second pass.
- `CREATE TABLE eidan.knowledge_links` runs once.

The migration's `downgrade()` drops `eidan.knowledge_links`
and the `slug` column. Per `002 §6.1`, downgrades are for the
dev / test path only.

### 9.3 Backfilling links from existing knowledge

The follow-up migration also runs a **one-shot link extraction
pass** over every live `eidan.knowledge` row at apply time:

```python
def upgrade():
    op.execute("ALTER TABLE eidan.knowledge ADD COLUMN slug text")
    # … unique index, check constraint, slug backfill (§3.2) …
    op.execute(KNOWLEDGE_LINKS_DDL)

    # one-shot extraction over existing bodies
    op.run_python(extract_links_into_index_from_existing_knowledge)
```

The application code that implements the extractor is the same
code the turn runner calls at write time (§4.3) — there is no
second extractor. The migration imports the host's extractor
module and runs it row-by-row.

A deployment with zero knowledge rows pays nothing for this
step; a deployment with N rows pays one extraction pass per
row, which is well under one second per thousand rows in
practice.

---

## 10. Index summary

For convenience, the indexes introduced by this document:

**Knowledge (additive)**

- `uq_knowledge_user_slug (user_id, slug) WHERE deleted_at IS NULL AND slug IS NOT NULL`

**Knowledge links (new table)**

- `idx_knowledge_links_from (from_knowledge_id, position_offset)`
- `idx_knowledge_links_to (to_knowledge_id) WHERE to_knowledge_id IS NOT NULL`
- `idx_knowledge_links_to_slug_unresolved (user_id, to_slug) WHERE to_knowledge_id IS NULL`
- `idx_knowledge_links_user_created (user_id, created_at DESC)`

The forward index is the only one without a partial predicate;
every link has a `from_knowledge_id` by construction
(`NOT NULL` on the column).

---

## 11. Reserved for later specs

Out of scope here, deferred to follow-ups:

- **Cross-table linking.** A knowledge body referencing a note,
  an event, or a message. The shape will need a discriminated
  `to_kind` column on the link index (or a sibling table per
  target kind), the resolver gains per-kind rules, and the UI
  grows a "Mentions" panel that fans into multiple tables.
- **Typed links.** `is_related_to`, `supersedes`, `contradicts`.
  Phase 1's `link_type` discriminator is *how the link was
  written*, not *what it means*; a follow-up adds a semantic
  `relation_type` column populated by a small classifier call
  at extraction time.
- **Anchor / section links.** `[[Foo#heading]]`. The Phase 1
  extractor strips the `#heading` suffix; preserving it as a
  `to_anchor` column on the link index, plus the renderer that
  scrolls into a heading, is reserved.
- **Embedding-weighted recall over the graph.** Combining the
  structural traversal in §6 with embedding similarity (loaded
  from the reserved `eidan.memory_embeddings` companion in
  `003 §12`) into a single ranking surface.
- **Telemetry on link follow.** Counting how often each link
  was traversed by the agent across turns, surfacing
  "frequently traversed pairs" as a recommended-link panel in
  the UI. Phase 1 records nothing about traversal usage.
- **Multi-user / shared knowledge graphs.** Phase 1 scopes every
  knowledge node and every link to one `user_id`. Shared
  knowledge spaces — delivered later via a paid plugin — will
  need an additional `space_id` column on both `eidan.knowledge`
  and `eidan.knowledge_links` (per `002 §2.2`, supporting columns
  live in core), plus a redesigned resolver that searches a
  space before falling back to the user's private graph.
