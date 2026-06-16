<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# 0011 — Memory (knowledge + notes)

Status: **Shipped** — `@eidandev/memory` (the `EidanMemory` service + remember/recall tools).

## Goal

eidan's long-term memory is **relational Postgres**, not a flat text file: durable, skill-tagged
**knowledge** and conversation **notes** the agent can query and that other plugins can read with
type safety. This is the product layer on top of matbot's session store (which holds the
conversations/messages themselves).

## Surfaces

- **Tools** (`remember` / `recall`) — the agent saves a knowledge entry (`skill`, `title`, `body`,
  optional `source`/`source_type`) and recalls by query.
- **Service** (`EidanMemory`, on the registry) — other plugins consume the same surface with full
  types: `services.EidanMemory?.searchKnowledge(query, limit)` / `.remember(...)` / `.note(...)`.

## What it stores

| Table | Holds |
|---|---|
| `eidan.knowledge` | durable, skill-tagged entries (`skill`, `title`, `body`, `source`, `source_type`). |
| `eidan.notes` | lightweight per-conversation notes (`content`, optional `conversation_id`). |

- **Forgiving recall.** `searchKnowledge` builds a `tsquery` that **ORs** the query's lexemes (unlike
  `plainto_/websearch_to_tsquery`, which AND them), so a single matching term still surfaces an
  entry — biased toward recall over precision.
- **Soft-delete + RLS.** Reads filter `deleted_at IS NULL`. Tenant isolation is by **RLS**: each
  call stamps `eidan.current_user_id` from the ambient `Principal` (the SELECTs carry no explicit
  `user_id` predicate — the policy enforces it), so a non-superuser app role only sees its own rows.

## Config

Just `EIDAN_DATABASE_URL` (with the `eidan.*` schema applied). No per-plugin schema — it owns
`eidan.knowledge` + `eidan.notes` in the core schema. Load after `storage-postgres`.

## Files of record

- `packages/memory/src/eidan-memory.ts` — `EidanMemory` (remember / searchKnowledge / note / recall).
- `packages/memory/src/tools.ts` — the `remember` / `recall` agent tools.
- `packages/memory/src/db.ts` — principal-stamping transaction helper.
- `migrations/sql/0001_baseline.sql` — `eidan.knowledge` + `eidan.notes`.
