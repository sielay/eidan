<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
# @eidandev/journal

Drop a text or voice note; the journal **categorises** it, **logs it structurally**,
and **routes** it — so a passing thought becomes durable, actionable state instead
of scrolling out of a chat.

Voice needs nothing extra: [`@eidandev/transcribe`](../transcribe) turns a
Telegram/chat voice note into text *before* the turn, so a note arrives as an
ordinary message. Say (or type) *"built the journal facility in eidan today; found
a scoring bug in mathgame → sielay/mathgame"* and it becomes two entries — a
`devlog` on `eidan` and a `bug` on `mathgame` that opens a sage code job.

## How it works

1. **Direction prompt** — a single editable instruction (per user) tells the model
   how to categorise and route. Read/replace it with `journal_direction`; the seed
   is in [`src/types.ts`](src/types.ts).
2. **Capture** — the assistant calls `journal_capture` once per distinct item,
   storing a structured row in `plugin_journal.entries` (project, entry_type,
   summary, body, target_repo).
3. **Route** — the one deterministic auto-action: a `bug`/`task` naming a routable
   `owner/name` repo opens a `code` job on `eidan.jobs` (`surface='journal'`), which
   the sage worker claims and turns into a PR. Anything else is just logged.
4. **Plan** — scheduled [`@eidandev/agents`](../agents) read the journal via
   `journal_query` and use their own tools to draft blog/journey content and groom
   a content board. (The journal never writes another plugin's schema.)

## Tools

| Tool | What it does |
|---|---|
| `journal_capture` | Record one item `{ project, entry_type, summary, body?, target_repo?, source? }`; persists + routes. `entry_type ∈ devlog \| bug \| task \| idea \| content_seed`. |
| `journal_query` | Read recent entries filtered by `project` / `entry_type` / `since` — the planning-agent read API. |
| `journal_list` | Quick scan of the latest entries. |
| `journal_direction` | Get the direction prompt, or set a new one. |

## Config

- `EIDAN_DATABASE_URL` (or `DATABASE_URL`) — required; owns the `plugin_journal`
  schema (created idempotently on setup).
- `EIDAN_JOURNAL_NUDGE` — set to `0` to disable the one-sentence `screen` nudge and
  journal only on an explicit "journal this". Default: on (fires at most once per
  human turn).

Owner-scoped throughout via the ambient principal (RLS stamp); entries soft-delete
with `deleted_at`.
