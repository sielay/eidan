# 025 — Agent database introspection

Status: Draft
Owner: Core
Related: `docs/003_MEMORY_DDL.md` (core schema),
`docs/002_MIGRATIONS.md` (§5 RLS plugin),
`docs/011_AUTH_FLOW.md` (§9.3 `SET LOCAL eidan.current_user_id`),
`docs/017_KNOWLEDGE_LINKING.md` (`eidan.knowledge_links`),
`docs/022_ESCALATION_ENVELOPE.md`

This document specifies the **read surface the primary agent has on
its own memory**. The primary call needs to be able to ask "what's
in my notes about X?" or "what events are due today?" or "what does
my user_context say about my goals?" without a dedicated plugin
having to hand-craft each question. Core ships seven memory tools
under the `memory_*` prefix (underscore — not a dot — so each name
stays inside Anthropic's tool-name pattern `^[a-zA-Z0-9_-]{1,128}$`):

| Tool | Shape | Use |
|---|---|---|
| `memory_events_due` | `(window: enum, limit?: int)` | Pending events with `due_at` in `overdue` / `today` / `next_7d` / `next_30d`. |
| `memory_list_knowledge` | `(skill?: str, limit?: int)` | Knowledge index — titles + slugs, no bodies. |
| `memory_get_knowledge` | `(id?: uuid, slug?: str)` | One knowledge node's full body. |
| `memory_recall` | `(query: str, table?: enum, limit?: int)` | Substring search over `knowledge.body` + `notes.body`. |
| `memory_notes_recent` | `(conversation_id?: uuid, limit?: int)` | Recent notes, optionally scoped to one conversation. |
| `memory_user_context` | `(key?: str)` | The user's durable facts. With a key, returns that value only. |
| `memory_query_sql` | `(sql: str)` | **Generic safe SELECT** — arbitrary read query against the whitelisted table set. |

`memory_query_sql` is the load-bearing one. The agent can ask
*any* question that crosses the structured helpers — joining
events with knowledge, aggregating notes by week, recursively
walking the knowledge graph — by writing SQL. The host validates
the query against a strict whitelist *before* opening a connection.

---

## 1. The read surface

`memory_query_sql` exposes **every table in every schema** to the
agent — `eidan.*`, every `plugin_*.*`, `pg_catalog.*`, and
`information_schema.*` all read freely. The structured helpers (§0
above) sit on top of the same surface as convenience wrappers; the
generic tool is the one with no shape constraint.

Schema introspection is part of the surface on purpose. The agent
can ask `pg_catalog.pg_tables` what exists or
`information_schema.columns` what shape a table has before writing a
join — same way an operator would explore an unfamiliar database.

## 2. The deny-list

Two tables stay out of reach even though every other row is fair game:

| Table | Why denied |
|---|---|
| `eidan.auth_keypair` | Fernet-sealed RS256 signing key. The blob is sealed by `EIDAN_AUTH_MASTER_KEY` (which lives outside the DB), but exposing the ciphertext over the agent's context narrows the attacker's path from "compromise DB + master key" to "compromise master key alone". |
| `eidan.secrets_vault` | Fernet-sealed provider / plugin secrets. Same reasoning. |

A query that references either raises
`SqlValidationError("table 'eidan.auth_keypair' holds encrypted secret
material and is not readable by the agent")` before any DB
connection opens. Operators who want to widen or narrow this set on
a particular install can edit `_DENY_TABLES` in
`apps/backend/eidan_backend/memory_tools.py`.

Note: tables that were previously denied for content-leak reasons —
`eidan.llm_calls` (carries raw prompts in `metadata`), `eidan.users`
(email PII), `eidan.agent_context` (persona overrides),
`eidan.plugin_state`, `eidan.escalations`, and every `plugin_*.*`
schema — are **now readable**. The single-operator install model
treats the agent as the operator's own assistant on their own data;
"operator-private" and "agent-readable" collapse to the same
boundary in that model. Multi-operator installs (the universal paid
baseline's RLS bundle, `docs/018 §3`) re-introduce per-row scoping
via `eidan.current_user_id`, not table-level denials.

## 3. The SQL safety rules

`memory_query_sql` accepts a single string. Before any DB
connection opens, the host runs `validate_sql()` which rejects on:

- Empty / over-length input (> 4000 characters).
- Any leading keyword other than `SELECT` or `WITH` (CTE).
- Any of: `INSERT`, `UPDATE`, `DELETE`, `TRUNCATE`, `DROP`, `ALTER`,
  `CREATE`, `GRANT`, `REVOKE`, `SET`, `SHOW`, `CALL`, `COPY`,
  `VACUUM`, `ANALYZE`, `CLUSTER`, `\copy`.
- Multi-statement queries (any `;` followed by more SQL).
- Any reference to a table in §2's deny-list.

The validator is **conservative** — false positives (refusing a
safe query) are preferred over false negatives (accepting an
unsafe one). A query that mentions `INSERT` inside a string
literal (`WHERE title = 'before INSERT'`) is rejected.

After validation, the query runs through `db.acquire(pool,
identity)` so the `SET LOCAL eidan.current_user_id` session
variable is set — RLS-plugin-installed deployments scope reads
automatically. The query body is wrapped as a subquery and capped
at 200 rows with a 5-second timeout:

```sql
SELECT * FROM (<user query>) AS _agent_q LIMIT 200
```

The response shape is `{ "columns": [...], "rows": [[...], ...],
"truncated": bool }`.

## 4. RLS compatibility

Every tool here calls `db.acquire(pool, identity)`, which issues
`SET LOCAL eidan.current_user_id = '<user.id>'` before yielding
the connection. The RLS plugin's policies (`docs/002 §5.2`)
gate reads on `current_setting('eidan.current_user_id')::uuid`,
so installing it does not require any code change here.

Without RLS, the structured helpers carry explicit
`WHERE user_id = $1` predicates. The `memory_query_sql` path
trusts the agent to write its own `WHERE user_id =
current_setting('eidan.current_user_id')::uuid` — the system
prompt for the tool nudges the model in that direction. A
query that omits it returns rows from *every* user in a
non-RLS deployment. **The recommendation is to always install
the RLS plugin in any multi-user deployment**; single-operator
deployments can skip it because there's only one user anyway.

## 5. Why this matters

Without these tools, the agent's only memory access is whatever
specific tools each plugin happens to expose. A useful personal
agent has to be able to ask its own questions — "did I capture
anything about X last week?", "what's my user_context say about
my goals?", "are any of my pending events overdue?". The
structured helpers cover the common cases; the `memory_query_sql`
escape hatch handles everything else without each new question
demanding a new plugin tool.

This is the cross-reverse-engineering capability the operator
identified in the 2026-05-19 audit (note #12): *"agent can make
queries cross-reverse-engineering various bits of own state and
analyse / fix / debug."*

## 6. Reserved for later

- Full-text search via `eidan.knowledge.body_tsv` (PG `to_tsvector`)
  when the indexer plugin lands. Until then `memory_recall` falls
  back to ILIKE.
- Vector / embedding search for "knowledge similar to this
  paragraph" — needs an embeddings plugin.
- Column-level read masking (e.g. blank out `body` on rows whose
  `source` is sensitive) — the §2 deny-list is table-grained today.
- Write-side equivalents (`memory_note`, `memory_event_create`)
  are deliberately not here; the capture plugin already owns those.
