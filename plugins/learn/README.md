# learn — core plugin

Surveys the operator's existing memory for what they already know
about a topic, and returns a structured payload the primary call
uses to compose a user-facing learning plan.

This is the Phase 1 slice of [issue #50](https://github.com/sielay/eidan/issues/50)
("Add core plugin: `/learn` command with research and planning
capability").

## What it ships

A single registered tool:

| Tool       | Input                                | Output                                                    |
|------------|--------------------------------------|-----------------------------------------------------------|
| `learn`    | `{ topic: str, depth?: shallow\|deep }` | JSON survey: knowledge / notes / messages + suggested questions |

The model invokes the tool when the user asks to research, plan, or
learn about a topic. The tool's output is plain JSON the model
parses and renders.

## How the survey works

Three queries fire in parallel against the user's eidan-schema rows:

1. **`eidan.knowledge`** — full-text search via the stored `body_tsv`
   GIN index, ranked by `ts_rank` then recency. Capped at 5 hits.
2. **`eidan.notes`** — `ILIKE` body match, ordered by recency.
   Capped at 5 hits.
3. **`eidan.messages`** — `ILIKE` content match on user / assistant
   turns from the last several conversations. Capped at 8 hits.

Each surface returns a short snippet (≤ 280 chars per row) so the
combined response stays prompt-budget-friendly.

A small deterministic stub generates suggested clarifying questions
based on how much signal the surveys found — they're a skeleton, not
the final questions; the model elaborates when rendering.

## Identity

The plugin captures `ctx.identity.user_id` at `on_activate` time
and closes over it in the tool handler. Every query filters on it.
Multi-user / RLS deployments will route identity per call when that
surface lands; the contract here is forwards-compatible.

## What's deferred to Phase 2

- **MCP outbound connectors** — surveys across other agent stacks
  (`docs/013 §4`). The plugin contract for MCP connector wiring is
  not yet in place.
- **External APIs** — web search, documentation lookups. Each
  needs its own adapter design.
- **Obsidian / Notion / Google Drive** — separate per-vendor
  connector plugins; the cataloging shape will mirror this one's.
- **Slash-command routing** (`/learn <topic>`) — needs the command
  registry from [docs/019](../../docs/019_PLUGIN_COMMANDS.md) /
  issue #26. Until then the model invokes the tool via `tool_use`;
  the user phrases the request naturally.

## Acceptance for Phase 1

- The `learn` tool is registered with the host's tool registry
  after `on_activate` runs with an authenticated identity.
- A turn whose primary call invokes the tool with a valid topic
  receives the JSON survey in the `tool_result` block.
- Empty topics, missing topics, or pre-activation calls raise
  `ToolError` cleanly — the loop surfaces them as error blocks
  rather than aborting the turn.

The plugin is loaded automatically by the host's plugin loader at
startup; no manual registration step.
