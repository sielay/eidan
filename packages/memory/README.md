# @eidandev/memory

eidan's **relational long-term memory** — the knowledge store the agent
writes to and reads from across conversations, kept as queryable rows in
Postgres (the `eidan` schema), RLS-scoped to the owner. This is the heart of
eidan's wedge: structured, linkable memory rather than a flat file or an
opaque vector blob.

It registers the `EidanMemory` service (so other plugins and bundles can read
and write knowledge with full type safety — `services.EidanMemory?.…`) plus
the two agent-facing tools below.

## Tools

| Tool | Purpose |
|------|---------|
| `remember` | Save a durable, skill-tagged knowledge entry to long-term memory. Inputs: `skill` (free-text domain tag), `title` (short, unique within the skill), `body` (markdown). |
| `recall`   | Search long-term knowledge by `query` and return the most relevant entries, ranked. Optional `limit` (default 10). |

## Example

> **You:** Remember that the garden irrigation timer runs 6am on Mon/Wed/Fri.
>
> → the agent calls `remember({ skill: "home", title: "Irrigation schedule", body: "Timer: 06:00 Mon/Wed/Fri" })`
>
> *(days later)* **You:** When does the garden get watered?
>
> → the agent calls `recall({ query: "garden watering schedule" })` and answers from the stored entry.

## Layout

- `src/index.ts` — the `MatbotPluginSpec`; builds `Db` from `EIDAN_DATABASE_URL`, registers the `EidanMemory` service and the two tools.
- `src/eidan-memory.ts` — the `EidanMemory` service (`remember`, `searchKnowledge`, notes surface).
- `src/tools.ts` — the matbot `Tool[]` (`remember` / `recall`); the ambient `Principal`, set per turn by the runner's `runAs`, flows into every read/write.
- `src/db.ts` — the principal-stamping query helper (RLS enforced via the ambient principal).

## Schema

`eidan.knowledge` (skill-tagged, full-text ranked) and the notes tables in the
`eidan` schema. Applied by the core migrate runner (`migrations/sql/*.sql`),
not per-plugin.

## Config

- `EIDAN_DATABASE_URL` (or `DATABASE_URL`) — Postgres connection (**required**).
