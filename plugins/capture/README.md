# capture — core plugin

Write-side companion to the `learn` plugin. Registers three tools the
agent uses to put information INTO eidan's memory tables:

| Tool       | Lands in                | Use when                                                |
|------------|-------------------------|---------------------------------------------------------|
| `remember` | `eidan.knowledge`       | the user asks the agent to remember something durable; the fact is worth re-reading later. |
| `note`     | `eidan.notes`           | working memory anchored to the current conversation; ephemeral or summarisable. |
| `event`    | `eidan.events`          | something happens at a known time — meeting, reminder, observation. |

## Why three tools instead of one

Each table has different operational semantics:

- **`knowledge`** is curated and skill-tagged; the GIN tsvector index
  makes it fast to retrieve via `learn`. Replaces an existing entry
  on `(skill, title)` conflict so an agent can refine without
  duplicating.
- **`notes`** is cheap working memory; the agent_loop is encouraged
  to drop them during a turn. Anchored to the current conversation
  by default.
- **`events`** is the calendar-shaped store with both `due_at`
  (future) and `occurred_at` (past) timestamps. The table refuses
  rows with neither — every event has at least one clock.

## Identity

Tool handlers read identity from the loop's ambient
`current_identity` contextvar. Forward-compatible with multi-user;
the same plugin instance services every identity the loop routes
to it.

## `notes.agent_id` workaround

`eidan.notes` requires `agent_id NOT NULL` (per `docs/003 §6`).
The agent loop doesn't yet provision a default `agent_context` row
for the operator at startup; this plugin lazily upserts a sentinel
`capture-default` agent on the first `note` call so the write
doesn't fail. When the loop ships a proper agent-context lifecycle
this helper becomes a no-op and the loop's real `agent_id` flows
through instead.

## Out of scope

- Reverse / undo. `eidan.knowledge` upserts on `(skill, title)`, so
  the agent can refine; outright deletion is a separate operator
  action (`docs/003 §1.3` soft delete).
- Recurrence expansion for `event.recurrence`. The DDL accepts an
  RFC 5545 RRULE string but expansion to concrete occurrences is
  an agent / loop concern (`docs/003 §4` notes).
- External imports (Google Calendar, IMAP, Obsidian). Each is its
  own connector plugin.

The plugin is loaded automatically by the host's plugin loader at
startup — once `make migrate` has run and `make repl` boots, the
three tools appear in the agent loop's tool surface and the model
can invoke them when appropriate.
