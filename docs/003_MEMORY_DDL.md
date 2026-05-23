# 003 — Memory model DDL

Status: Draft

Owner: Core

Related: [ARCHITECTURE](./ARCHITECTURE.md) (Memory model, Token tracking), [MIGRATIONS](./002_MIGRATIONS.md) (core tier, no RLS in core)

This document specifies the concrete SQL DDL for the **core memory
schema** of Eidan. All objects live in the shared `eidan` schema
(`002_MIGRATIONS.md §1`). Per `002_MIGRATIONS.md §5`, core defines
the tables and does **not** enable row-level security; RLS is
layered on top by the RLS plugin via the host-schema migration
extension point (`docs/018 §7`).

The schema covers seven first-class concepts plus a `conversations`
table that the others FK into:

| Table             | Purpose                                                  |
|-------------------|----------------------------------------------------------|
| `conversations`   | The container threads that messages and notes belong to. |
| `messages`        | Append-only log of model/tool/user turns, tree-shaped.   |
| `events`          | Calendar-like items: due, occurred, recurring, status.   |
| `knowledge`       | Skill-tagged markdown with source attribution.           |
| `notes`           | Working memory written by an agent in a conversation.    |
| `agent_context`   | Per-agent identity: code-shipped defaults + user overrides. |
| `user_context`    | Durable user facts: identity, goals, constraints, prefs. |
| `llm_calls`       | Per-provider-call telemetry: tokens, cost, latency, error. |
| `node_heartbeats` | Per-process liveness UPSERT, host-global. See [024](./024_NODE_TELEMETRY.md). |
| `node_events`     | Per-node activity stream (append-only). See [024](./024_NODE_TELEMETRY.md). |

`eidan.users(id)` is assumed to exist already, owned by an earlier
core migration (`migrations/versions/<ts>_init_users.py`, per
`002_MIGRATIONS.md §1`). Every *user-scoped* memory table FKs into
it; the two host-global telemetry tables (`node_heartbeats`,
`node_events`) deliberately don't, because node identity belongs
to the *process*, not the user (see [024](./024_NODE_TELEMETRY.md)).

---

## 1. Conventions

The following conventions apply uniformly unless a section says
otherwise.

### 1.1 Identifiers

- Primary keys are `uuid`, defaulted to `gen_random_uuid()`. The
  init migration ensures `pgcrypto` is available:

  ```sql
  CREATE EXTENSION IF NOT EXISTS pgcrypto;
  ```

  (Postgres 13+ provides `gen_random_uuid()` in core; the extension
  is requested defensively for older instances and to surface the
  intent.)

- All foreign keys use `uuid` and declare an explicit `ON DELETE`
  action — never the default. Cascades are spelled out in each
  table.

### 1.2 Timestamps

- Every timestamp column is `timestamptz`.
- `created_at timestamptz NOT NULL DEFAULT now()` on every table.
- `updated_at timestamptz NOT NULL DEFAULT now()` on tables that
  carry mutable state. A single trigger keeps it honest:

  ```sql
  CREATE OR REPLACE FUNCTION eidan.set_updated_at()
  RETURNS trigger
  LANGUAGE plpgsql
  AS $$
  BEGIN
    NEW.updated_at := now();
    RETURN NEW;
  END;
  $$;
  ```

  Each table that needs it attaches a `BEFORE UPDATE` trigger:

  ```sql
  CREATE TRIGGER trg_<table>_updated_at
  BEFORE UPDATE ON eidan.<table>
  FOR EACH ROW EXECUTE FUNCTION eidan.set_updated_at();
  ```

### 1.3 Soft deletes

Tables that represent **curated or user-visible state** carry
`deleted_at timestamptz NULL`. Reads default-filter on
`deleted_at IS NULL`. Indexes used by the read path are partial on
the same predicate so the soft-deleted rows do not pay for the live
queries.

Tables with soft-delete: `conversations`, `messages`, `events`,
`knowledge`, `notes`, `user_context`.

Tables **without** soft-delete (hard-only or immutable):

- `llm_calls` — immutable audit/telemetry. Retention is handled by
  a separate purge job, not by `deleted_at`.
- `agent_context` — configuration. Removing an agent is a config
  action; rows are deleted outright (cascading user_overrides go
  with them).

### 1.4 JSON

Structured columns use `jsonb`, never `json`. Defaults are
`'{}'::jsonb` for object-shaped columns and `'[]'::jsonb` for array-
shaped columns, so application code never has to special-case NULL.

### 1.5 Naming

- Table names are plural snake_case.
- Index names are `idx_<table>_<cols>[_partial]`.
- Constraint names are `<table>_<purpose>_chk` / `_uq` / `_fk`.

---

## 2. `eidan.conversations`

The thread a sequence of messages belongs to. Required so that
`messages`, `notes`, and `llm_calls` have a stable FK target.

```sql
CREATE TABLE eidan.conversations (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid        NOT NULL
                              REFERENCES eidan.users(id)
                              ON DELETE CASCADE,
  title           text,
  agent_id        uuid        REFERENCES eidan.agent_context(id)
                              ON DELETE SET NULL,
  metadata        jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz
);

CREATE INDEX idx_conversations_user_recent
  ON eidan.conversations (user_id, created_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX idx_conversations_agent
  ON eidan.conversations (agent_id)
  WHERE deleted_at IS NULL;

CREATE TRIGGER trg_conversations_updated_at
  BEFORE UPDATE ON eidan.conversations
  FOR EACH ROW EXECUTE FUNCTION eidan.set_updated_at();
```

`agent_id` is nullable: a conversation may be started directly by
the user with no specific agent attached, and the binding can be
deferred.

The `agent_context` FK is forward-declared here for readability;
the actual `agent_context` table is defined in §7. The init
migration creates `agent_context` before `conversations` so the FK
resolves at apply time.

---

## 3. `eidan.messages`

Append-only log of turns inside a conversation. The tree shape is
encoded by `parent_message_id`, which is the self-FK that captures
**subagent subtrees**: when an agent spawns a subagent, the
subagent's first message points at the parent message that
triggered the invocation, even if the subagent lives in a
different `conversation_id`.

```sql
CREATE TABLE eidan.messages (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             uuid        NOT NULL
                                  REFERENCES eidan.users(id)
                                  ON DELETE CASCADE,
  conversation_id     uuid        NOT NULL
                                  REFERENCES eidan.conversations(id)
                                  ON DELETE CASCADE,
  parent_message_id   uuid        REFERENCES eidan.messages(id)
                                  ON DELETE SET NULL,
  agent_id            uuid        REFERENCES eidan.agent_context(id)
                                  ON DELETE SET NULL,

  role                text        NOT NULL,
  content             text,
  tool_calls          jsonb       NOT NULL DEFAULT '[]'::jsonb,
  tool_results        jsonb       NOT NULL DEFAULT '[]'::jsonb,

  provider            text,
  model               text,

  metadata            jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at          timestamptz NOT NULL DEFAULT now(),
  deleted_at          timestamptz,

  CONSTRAINT messages_role_chk CHECK (
    role IN ('user', 'assistant', 'system', 'tool')
  )
);

CREATE INDEX idx_messages_conversation_created
  ON eidan.messages (conversation_id, created_at)
  WHERE deleted_at IS NULL;

CREATE INDEX idx_messages_parent
  ON eidan.messages (parent_message_id)
  WHERE parent_message_id IS NOT NULL;

CREATE INDEX idx_messages_user_recent
  ON eidan.messages (user_id, created_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX idx_messages_agent_recent
  ON eidan.messages (agent_id, created_at DESC)
  WHERE agent_id IS NOT NULL AND deleted_at IS NULL;
```

Notes on shape:

- `content` is plain text. Models that return multi-block content
  (text + tool_use + tool_result) split into `content` for the text
  part and `tool_calls` / `tool_results` for the structured blocks.
  Storing both keeps a one-row-per-turn shape while preserving the
  block structure for replay.
- `provider` and `model` are recorded **on the message**, not only
  on `llm_calls`, so a message replayed offline still knows what it
  came from after retention has trimmed `llm_calls`.
- There is no `updated_at`. Messages are append-only; corrections
  happen as new messages, not by editing prior ones.

---

## 4. `eidan.events`

Calendar-like records the agent reasons about: meetings, reminders,
deadlines, recurring routines. Both **scheduled** (`due_at`) and
**post-hoc** (`occurred_at`) shapes are first-class so the agent
can answer "what's coming up?" and "what happened recently?"
without two different tables.

```sql
CREATE TABLE eidan.events (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid        NOT NULL
                              REFERENCES eidan.users(id)
                              ON DELETE CASCADE,

  type            text        NOT NULL,
  title           text        NOT NULL,
  body            text,

  due_at          timestamptz,
  occurred_at     timestamptz,
  duration_s      integer,

  status          text        NOT NULL DEFAULT 'pending',
  recurrence      text,
  external_ref    text,

  metadata        jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz,

  CONSTRAINT events_status_chk CHECK (
    status IN ('pending', 'in_progress', 'done', 'cancelled', 'missed')
  ),
  CONSTRAINT events_time_chk CHECK (
    due_at IS NOT NULL OR occurred_at IS NOT NULL
  )
);

-- Heads-up: "what is coming up for this user soon?"
CREATE INDEX idx_events_user_due_pending
  ON eidan.events (user_id, due_at)
  WHERE status = 'pending'
    AND deleted_at IS NULL
    AND due_at IS NOT NULL;

-- Typed heads-up: "next meeting", "next reminder"
CREATE INDEX idx_events_user_type_due
  ON eidan.events (user_id, type, due_at)
  WHERE deleted_at IS NULL
    AND due_at IS NOT NULL;

-- History: "what happened last week?"
CREATE INDEX idx_events_user_occurred
  ON eidan.events (user_id, occurred_at DESC)
  WHERE deleted_at IS NULL
    AND occurred_at IS NOT NULL;

-- Recurring scan: agent ticks once a minute looking for cron-like rules
CREATE INDEX idx_events_recurrence
  ON eidan.events (user_id)
  WHERE recurrence IS NOT NULL
    AND status = 'pending'
    AND deleted_at IS NULL;

CREATE TRIGGER trg_events_updated_at
  BEFORE UPDATE ON eidan.events
  FOR EACH ROW EXECUTE FUNCTION eidan.set_updated_at();
```

Notes:

- `recurrence` is an RFC 5545 RRULE string when set. Expansion to
  concrete occurrences is done by the agent, not by the DB.
- `external_ref` carries a stable identifier from an external
  source (Google Calendar event id, an iCal UID) when the event was
  imported. There is no FK to a calendar-provider table in core;
  that lives in a plugin.
- The `events_time_chk` constraint forbids an event with neither a
  `due_at` nor an `occurred_at` — that would be a typeless note,
  which belongs in `notes` or `knowledge`.

---

## 5. `eidan.knowledge`

Curated, skill-tagged markdown the agent can recall later — the
"things the agent knows about a topic" store. Distinct from
`notes` (working memory) by the editorial bar: knowledge entries
are intended to be re-read; notes are intended to be summarised
and dropped.

```sql
CREATE TABLE eidan.knowledge (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid        NOT NULL
                              REFERENCES eidan.users(id)
                              ON DELETE CASCADE,

  skill           text        NOT NULL,
  title           text        NOT NULL,
  body            text        NOT NULL,

  source          text,
  source_type     text,

  body_tsv        tsvector    GENERATED ALWAYS AS (
                                to_tsvector(
                                  'english',
                                  coalesce(title, '') || ' ' || coalesce(body, '')
                                )
                              ) STORED,

  metadata        jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz,

  CONSTRAINT knowledge_source_type_chk CHECK (
    source_type IS NULL
    OR source_type IN ('url', 'file', 'chat', 'manual', 'imported')
  )
);

-- One live entry per (user, skill, title). Soft-deleted rows are
-- excluded so a new entry can replace a tombstoned one.
CREATE UNIQUE INDEX uq_knowledge_user_skill_title
  ON eidan.knowledge (user_id, skill, title)
  WHERE deleted_at IS NULL;

CREATE INDEX idx_knowledge_user_skill
  ON eidan.knowledge (user_id, skill)
  WHERE deleted_at IS NULL;

CREATE INDEX idx_knowledge_body_tsv
  ON eidan.knowledge USING GIN (body_tsv)
  WHERE deleted_at IS NULL;

CREATE TRIGGER trg_knowledge_updated_at
  BEFORE UPDATE ON eidan.knowledge
  FOR EACH ROW EXECUTE FUNCTION eidan.set_updated_at();
```

Notes:

- `skill` is a free-text tag (e.g. `python`, `gardening`,
  `home-network`). The cardinality is small per user; no separate
  `skills` table in core. A plugin may introduce one with its own
  reference table if it wants editorial control.
- `body_tsv` is a stored generated column so the GIN index does not
  need a trigger to stay in sync.
- Full-vector / embedding-based recall is out of scope here. A
  pgvector-backed companion table is a follow-up (§10).

---

## 6. `eidan.notes`

Working memory written by an agent during a conversation. Cheap,
ephemeral, summarisable.

```sql
CREATE TABLE eidan.notes (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           uuid        NOT NULL
                                REFERENCES eidan.users(id)
                                ON DELETE CASCADE,
  agent_id          uuid        NOT NULL
                                REFERENCES eidan.agent_context(id)
                                ON DELETE CASCADE,
  conversation_id   uuid        REFERENCES eidan.conversations(id)
                                ON DELETE SET NULL,

  content           text        NOT NULL,

  metadata          jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  deleted_at        timestamptz
);

CREATE INDEX idx_notes_user_recent
  ON eidan.notes (user_id, created_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX idx_notes_agent_recent
  ON eidan.notes (agent_id, created_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX idx_notes_conversation
  ON eidan.notes (conversation_id, created_at)
  WHERE conversation_id IS NOT NULL AND deleted_at IS NULL;

CREATE TRIGGER trg_notes_updated_at
  BEFORE UPDATE ON eidan.notes
  FOR EACH ROW EXECUTE FUNCTION eidan.set_updated_at();
```

`conversation_id` is nullable so an agent can record a note outside
the context of any specific thread (e.g. a background tick noticing
something worth remembering). `agent_id` is required: every note
has an author.

---

## 7. `eidan.agent_context`

Per-agent identity, split into **code defaults** (whatever the
running plugin/agent code ships) and **user overrides** (the user's
edits). The effective config is `code_defaults || user_overrides`
(jsonb concat, right-hand wins).

```sql
CREATE TABLE eidan.agent_context (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid        NOT NULL
                              REFERENCES eidan.users(id)
                              ON DELETE CASCADE,

  agent_slug      text        NOT NULL,
  display_name    text        NOT NULL,
  description     text,

  code_defaults   jsonb       NOT NULL DEFAULT '{}'::jsonb,
  user_overrides  jsonb       NOT NULL DEFAULT '{}'::jsonb,

  enabled         boolean     NOT NULL DEFAULT true,

  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT agent_context_slug_chk CHECK (
    agent_slug ~ '^[a-z0-9][a-z0-9_-]*$'
  ),
  CONSTRAINT agent_context_user_slug_uq UNIQUE (user_id, agent_slug)
);

CREATE INDEX idx_agent_context_user_enabled
  ON eidan.agent_context (user_id)
  WHERE enabled = true;

CREATE TRIGGER trg_agent_context_updated_at
  BEFORE UPDATE ON eidan.agent_context
  FOR EACH ROW EXECUTE FUNCTION eidan.set_updated_at();
```

Lifecycle:

- On host start (or plugin upgrade), the host writes `code_defaults`
  for each agent shipped in code. `user_overrides` is **never**
  touched by this path, so user edits survive upgrades.
- The agent reads `code_defaults || user_overrides` at the start of
  each session. Schema validation of that effective object lives in
  application code, not in the DB.

No soft-delete: turning an agent off is `enabled = false`, removing
an agent is a hard delete (and the FK cascades from `conversations`
/ `messages` / `notes` clean it up via `ON DELETE SET NULL` for
references, `ON DELETE CASCADE` for `notes` where the note has no
meaning without the author).

---

## 8. `eidan.user_context`

Durable, categorised facts about the user that should outlive any
single conversation. Stored key/value so the agent can read a
narrow slice (e.g. "give me everything in `constraints`") without
parsing one big blob.

```sql
CREATE TABLE eidan.user_context (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid        NOT NULL
                              REFERENCES eidan.users(id)
                              ON DELETE CASCADE,

  category        text        NOT NULL,
  key             text        NOT NULL,
  value           jsonb       NOT NULL,

  source          text,
  confidence      real,

  metadata        jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz,

  CONSTRAINT user_context_category_chk CHECK (
    category IN ('identity', 'goals', 'constraints', 'preferences', 'projects')
  ),
  CONSTRAINT user_context_confidence_chk CHECK (
    confidence IS NULL OR (confidence >= 0.0 AND confidence <= 1.0)
  )
);

-- One live entry per (user, category, key); a re-assertion is an UPSERT.
CREATE UNIQUE INDEX uq_user_context_user_cat_key
  ON eidan.user_context (user_id, category, key)
  WHERE deleted_at IS NULL;

CREATE INDEX idx_user_context_user_category
  ON eidan.user_context (user_id, category)
  WHERE deleted_at IS NULL;

CREATE TRIGGER trg_user_context_updated_at
  BEFORE UPDATE ON eidan.user_context
  FOR EACH ROW EXECUTE FUNCTION eidan.set_updated_at();
```

Notes:

- `category` is a fixed enumeration so the agent can rely on five
  stable buckets without scanning an open vocabulary. Extending the
  enumeration is a core migration, not an application-level change.
- `source` is free-text describing where the fact came from
  (`user-direct`, `inferred:onboarding`, `imported:linkedin`).
  `confidence` is optional; agent-inferred facts populate it, user-
  asserted facts leave it NULL (and read as "trusted").
- Updating an existing key is an UPDATE on the live row, not an
  insert-and-tombstone. History is reconstructed from `llm_calls` /
  `messages` audit trails, not from `user_context` itself.

---

## 9. `eidan.llm_calls`

One row per provider call. The cost / latency / token ledger.
Immutable: written once, never edited, no soft-delete. Retention is
handled out of band by a purge job (e.g. older than N days, kept
indefinitely if attached to a starred conversation).

```sql
CREATE TABLE eidan.llm_calls (
  id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               uuid        NOT NULL
                                    REFERENCES eidan.users(id)
                                    ON DELETE CASCADE,

  conversation_id       uuid        REFERENCES eidan.conversations(id)
                                    ON DELETE SET NULL,
  message_id            uuid        REFERENCES eidan.messages(id)
                                    ON DELETE SET NULL,
  agent_id              uuid        REFERENCES eidan.agent_context(id)
                                    ON DELETE SET NULL,

  role                  text        NOT NULL,
  provider              text        NOT NULL,
  model                 text        NOT NULL,

  input_tokens          integer     NOT NULL DEFAULT 0,
  output_tokens         integer     NOT NULL DEFAULT 0,
  cache_read_tokens     integer     NOT NULL DEFAULT 0,
  cache_creation_tokens integer     NOT NULL DEFAULT 0,

  cost_usd              numeric(12, 6) NOT NULL DEFAULT 0,
  latency_ms            integer,

  error                 text,
  error_type            text,

  started_at            timestamptz NOT NULL,
  finished_at           timestamptz,

  request_id            text,
  metadata              jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at            timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT llm_calls_role_chk CHECK (
    role IN ('primary', 'subagent', 'summariser', 'tool_synthesis', 'embed', 'other')
  ),
  CONSTRAINT llm_calls_tokens_chk CHECK (
    input_tokens >= 0
    AND output_tokens >= 0
    AND cache_read_tokens >= 0
    AND cache_creation_tokens >= 0
  )
);

-- Recent activity / cost dashboard per user
CREATE INDEX idx_llm_calls_user_created
  ON eidan.llm_calls (user_id, created_at DESC);

-- Per-conversation cost rollup
CREATE INDEX idx_llm_calls_conversation
  ON eidan.llm_calls (conversation_id, created_at)
  WHERE conversation_id IS NOT NULL;

-- Per-message attribution (one message can drive several calls)
CREATE INDEX idx_llm_calls_message
  ON eidan.llm_calls (message_id)
  WHERE message_id IS NOT NULL;

-- Per-model accounting
CREATE INDEX idx_llm_calls_provider_model_created
  ON eidan.llm_calls (provider, model, created_at DESC);

-- Error monitoring: usually empty
CREATE INDEX idx_llm_calls_errors
  ON eidan.llm_calls (user_id, created_at DESC)
  WHERE error IS NOT NULL;
```

Notes:

- The four token columns map directly onto the Anthropic API
  shape: `input_tokens`, `output_tokens`,
  `cache_read_input_tokens`, `cache_creation_input_tokens`. Other
  providers populate the subset that applies and leave the rest at
  `0`.
- `cost_usd` is computed by the host (rate table × tokens) and
  stored, so historical reporting does not need to know past
  pricing.
- `role` is the role of the call *inside the agentic loop* — not
  the chat role on the message. A single user message can fan out
  to a `primary` call plus several `subagent` calls plus a final
  `summariser` call.
- FKs to `messages` / `conversations` / `agent_context` are
  `ON DELETE SET NULL` rather than `CASCADE` because the call
  record is a financial / audit artifact and should outlive the
  thing it referenced.

---

## 10. Index summary

For convenience, the indexes called out above, grouped by access
pattern:

**Per-user recent feed**

- `idx_conversations_user_recent (user_id, created_at DESC)`
- `idx_messages_user_recent (user_id, created_at DESC)`
- `idx_notes_user_recent (user_id, created_at DESC)`
- `idx_llm_calls_user_created (user_id, created_at DESC)`

**Conversation walk**

- `idx_messages_conversation_created (conversation_id, created_at)`
- `idx_notes_conversation (conversation_id, created_at)`
- `idx_llm_calls_conversation (conversation_id, created_at)`

**Message tree**

- `idx_messages_parent (parent_message_id)`

**Heads-up / calendar**

- `idx_events_user_due_pending (user_id, due_at) WHERE pending`
- `idx_events_user_type_due (user_id, type, due_at)`
- `idx_events_user_occurred (user_id, occurred_at DESC)`
- `idx_events_recurrence (user_id) WHERE recurrence IS NOT NULL`

**Recall**

- `uq_knowledge_user_skill_title (user_id, skill, title)`
- `idx_knowledge_user_skill (user_id, skill)`
- `idx_knowledge_body_tsv USING GIN (body_tsv)`

**Identity**

- `uq_user_context_user_cat_key (user_id, category, key)`
- `idx_user_context_user_category (user_id, category)`
- `agent_context_user_slug_uq (user_id, agent_slug)`
- `idx_agent_context_user_enabled (user_id) WHERE enabled`

**Cost / telemetry**

- `idx_llm_calls_provider_model_created (provider, model, created_at DESC)`
- `idx_llm_calls_message (message_id)`
- `idx_llm_calls_errors (user_id, created_at DESC) WHERE error IS NOT NULL`

Every recent-feed and tree-walk index is partial on
`deleted_at IS NULL` so soft-deleted rows do not bloat the live
read path.

---

## 11. Migration packaging

Per `002_MIGRATIONS.md §2`, core migrations live under
`migrations/versions/` and use Alembic. This schema is delivered as
a single core migration:

```
migrations/versions/<UTC-timestamp>_init_memory_model.py
```

Apply order inside the migration's `upgrade()`:

1. `CREATE EXTENSION IF NOT EXISTS pgcrypto;`
2. `CREATE OR REPLACE FUNCTION eidan.set_updated_at() ...`
3. `agent_context` (no FK dependencies on memory tables)
4. `user_context`
5. `conversations` (FKs `agent_context`)
6. `messages` (FKs `conversations`, `agent_context`, self)
7. `events`
8. `knowledge`
9. `notes` (FKs `agent_context`, `conversations`)
10. `llm_calls` (FKs `conversations`, `messages`, `agent_context`)

`downgrade()` reverses this order. Per `002_MIGRATIONS.md §6.1`,
the downgrade exists for the dev / test path and is not used in
production.

The RLS plugin will later, via the host-schema migration
extension point (`docs/018 §7`):

- `ENABLE ROW LEVEL SECURITY` on every table here,
- add the `rls_<table>_<intent>` policies described in
  `002_MIGRATIONS.md §5`,
- key isolation off `current_setting('eidan.current_user_id')`.

Core code does not branch on whether those policies exist.

---

## 12. Reserved for later specs

Out of scope here, deferred to follow-ups:

- **Knowledge linking (graph traversal)**: pinned in
  `017_KNOWLEDGE_LINKING.md`. Adds a `slug` column to
  `eidan.knowledge` and a new `eidan.knowledge_links` index table
  for wikilink / `knowledge://` references, plus the traversal
  tool the agentic loop uses to widen recall laterally. Delivered
  as an additive core migration after the init migration in §11
  (rationale: `017 §9`).
- **Embeddings / vector recall**: a companion table
  `eidan.memory_embeddings` keyed by `(source_table, source_id)`
  with pgvector, plus the ANN index strategy.
- **Per-message attachments**: blob storage, content addressing,
  retention.
- **Tool-invocation table**: lifting `messages.tool_calls` /
  `tool_results` into a first-class `eidan.tool_invocations` table
  with status, retry count, and outcome.
- **Retention / purge policy**: how long `llm_calls` and
  soft-deleted rows are kept before hard deletion.
- **Audit log**: who-changed-what on `user_context` and
  `agent_context.user_overrides`.
