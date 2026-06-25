# @eidandev/glue

Glue marketing adapter for Eidan: drive the operator's [Glue](https://github.com/sielay/potem/tree/main/apps/glue-web) marketing suite — **web/funnel analytics**, **conversion-funnel management**, **subscriber lists & topics**, and **bulk email campaigns** — straight from chat.

Eidan **consumes Glue over its MCP server** (JSON-RPC at `/api/mcp`) and stores nothing locally: every call is a live read/write against Glue (pull, don't duplicate). This is the first reference adapter for the marketing capability surface; a vendor-neutral interface can grow over it when a second provider appears.

## How it works

The plugin authenticates as the Glue **owner** via Glue's `X-MCP-Secret`, so it has full access to the operator's projects. Writes are still gated **server-side** by each Glue project's `agent_autonomy_level` (`none` → `draft` → `schedule` → `publish` → `full`); an autonomy denial comes back as a clear, actionable error telling you which level the action needs.

## Setup

Both settings live in the **vault** (Settings → **Glue marketing**), so they're stored once in the shared DB and reach every node — no per-node env, no `env-push`:

1. **`EIDAN_GLUE_MCP_URL`** — the Glue MCP endpoint, e.g. `https://glue.example.com/api/mcp`.
2. **`GLUE_MCP_SECRET`** — Glue's `MCP_GLUE_SECRET` (the `X-MCP-Secret` value).

   (The vault backend falls back to `process.env` when a key isn't in the DB, so seeding either via env still works — but the vault is the canonical source.)
3. **Enable the plugin** in `matbot.yaml` (and `eidan.deploy.json` `bundles` for deploys):
   ```yaml
   plugins:
     - ./packages/glue
   ```
4. **Restart** and look for: `[glue] plugin loaded`.

## Tools

Each tool is one capability area, taking an `action` discriminator (the matbot multi-action shape). Discovery first: `glue_analytics { action: "list_projects" }` returns the `project_id` / venture context the other tools need.

### `glue_analytics` — read-only

| action | args | returns |
| --- | --- | --- |
| `list_projects` | — | projects (ventures) owned by the operator |
| `web_metrics` | `project_id`, `days?` (7/30/90) | totals, daily timeseries, top pages/referrers/countries/…, engagement |
| `retention` | `project_id`, `max_cohorts?` | weekly cohort retention (w1/w2/w4/w8) |
| `funnel_metrics` | `funnel_id`, `days?`, `cohort_by?`, `split_by?` | per-step conversion %, drop-off, time-to-convert; `split_by=<event property>` for A/B |

### `glue_funnels` — reads open; writes need autonomy `draft`+

`list` · `get` · `create` · `update` · `delete` · `add_step` · `update_step` · `delete_step`. A step `filter` matches web events: `{ event_type (required), path_pattern? (* wildcard), properties_match? }`.

### `glue_lists` — subscribers & topics; writes need `draft`+ (opt-out always allowed)

`list_subscribers` · `get_subscriber` · `update_subscriber` · `list_topics` · `set_topic`. A topic is a mailing list / segment keyed by venture-defined `(type, id)`.

### `glue_campaigns` — bulk email

`list` · `get` · `create` (`draft`+) · `update` (scheduling needs `schedule`+) · `send_now` (**`publish`+**) · `cancel` (always allowed). `audience_filter` supports topics include/exclude, `attributes_match`, `segment_id`, or `manual_emails`.

## What it intentionally does not do

- **No local tables.** Analytics, funnels, subscribers, and campaigns all live in Glue; this plugin never mirrors them.
- **Transactional/per-recipient email** (password resets etc.) is Glue's venture HTTP API (`/api/ventures/send`), not this adapter — this is the owner/agent marketing surface.
