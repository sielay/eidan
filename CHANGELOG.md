# Changelog

All notable changes to eidan are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); releases are cut by bumping
`package.json` and merging `next-release` → `main` (which tags `v<version>` and builds images).

## [Unreleased]

## [0.14.5] — 2026-06-29

### Added

- **Deployed-version indicator.** The desktop rail shows a compact version label (e.g. `v0.14.5` or
  `v0.14.5/0.14.4` when layers drift); click it for a modal breaking down the version + liveness of each
  layer — web (Vercel), Fly (cloud engine), Pi (kesha). Engine nodes report their version via
  `node_heartbeats.metadata.version` (telemetry); the web reads its own build version. Wide screens only.

## [0.14.4] — 2026-06-29

### Fixed

- **Agentic tool-loops no longer re-bill the full transcript every iteration.** The Anthropic adapter set
  its message cache breakpoint only when the second-to-last user turn ended in a `text` block — but in
  tool loops those turns end in `tool_result`, so caching was silently skipped and the whole growing
  transcript (mostly large tool results) was re-sent uncached on every step. The breakpoint now lands on
  `text | image | tool_result`. Separately, the OpenAI-compatible adapter gained opt-in `promptCaching`
  so OpenRouter calls to Anthropic models cache instead of re-billing the full prompt (enabled on the
  `openrouter` provider).
- **The LLM-call ledger now records agent runs.** Token/cost for agent fires, jobs, A2A, and Telegram
  turns were never written to `eidan.llm_calls` (only the chat surface logged), under-counting spend.
  All four paths now record usage.

### Added

- **Agents know the current time.** A small time-context block (ISO + owner-local time, IANA zone, day of
  week) is injected into every agent fire, computed once per fire so it stays cache-safe.
- **Per-trigger model selection for agents** — a single agent can run different models per trigger
  (`agent_schedule` / the trigger UI take an optional `model`; fire order is trigger → agent → node
  default). decision_gate relations can also override the model.
- **Model picker modal with a comparison table** in the agent UI.
- **ask_user human-in-the-loop prompts in web chat** (SSE prompt round-trip).
- **GFM tables in the WYSIWYG editor** + roomier markdown spacing.

## [0.14.3] — 2026-06-28

### Fixed

- **OCR no longer crashes the engine** — Google Drive image OCR ran Tesseract.js, which loads a WASM core
  + downloads ~15MB of language data + spawns workers at runtime and OOM-crashed the node *uncatchably*
  (it took the whole process down mid-turn). Image OCR is now disabled with a clear message pointing to
  vision (attach the image to chat) — more reliable + higher quality than OCR anyway.
- **PDF upload to chat now works** — the composer accepts PDFs, and the engine extracts their text
  (pdf-parse) and inlines it, since the provider adapter can only send a raw PDF as a name-only
  placeholder. (Scanned/image-only PDFs yield no text — attach as an image for vision instead.)

## [0.14.2] — 2026-06-28

### Changed

- **Prompts render as markdown too** — your message bubbles now render markdown (formatting + @-mention
  chips) the same way assistant replies do, instead of plain pre-wrapped text. Added docs/MENTIONS.md
  documenting the `[label](eidan:type:id)` reference syntax for authoring agents/prompts.

## [0.14.1] — 2026-06-28

### Added

- **Conversation readability + unread dots** — the sidebar list uses a larger title + readable timestamps
  (were 9px/dimmed), and conversations changed since you last opened them show an unread dot
  (metadata.last_read_at, cleared on open + after each turn).
- **Agent + trigger on the chat header** — opening an agent-originated thread now shows which agent it is
  and why it ran (scheduled / sensor / webhook / delegated-by / decision-gate / escalation-response).
- **Agent inspector lists the agent's conversations** — recent runs with status + links, in the org-chart
  detail panel.
- **Board cards: due dates** (#478, by sage) — a date on each card, shown on the card and sorted soonest-first.

### Fixed

- **⑂ Compare disclosure shows per-model token usage** (#479, by sage) — input/output tokens per candidate
  in the disclosure; judge briefing prefers complete answers. (The PR's stop-reason truncation flag needs
  a capability singleTurn doesn't expose yet, so that part is deferred.)

## [0.14.0] — 2026-06-28

### Added

- **Rich markdown editor with workspace @-mentions** — editing a markdown **file** (`/files/<path>`) and a
  **board prompt** now uses a real WYSIWYG editor (TipTap): a formatting toolbar (bold, italic, headings,
  lists) with live markdown round-trip, and type **`@`** to mention any **file, folder, agent, venture, or
  asset** from your workspace. A mention is inserted as a resolvable token (`[label](eidan:type:id)`) — it
  renders as a chip everywhere and the engine expands it into real context at turn time (e.g. a file's
  contents) when used in chat. Reusable `RichMarkdownEditor`; markdown files only (raw text/code keep the
  monospace editor so their bytes round-trip exactly).
  (Personas + the system prompt already had a rich editor; extending their @ to these entity types, and
  expanding mentions inside agent/board contexts, are the next steps.)

## [0.13.12] — 2026-06-27

### Fixed

- **Agents no longer act as orchestrators** — running under the same Eidan identity + full toolset as chat,
  capable models read their persona as a request to "Eidan the OS" and reached for agent_create /
  agent_schedule / agent_delegate / jobs / procedures — spinning up MORE agents and jobs instead of doing
  the task. Every agent turn now leads with firm framing pinning the model into the WORKER role (do the
  task yourself; do not create/schedule/delegate agents or create jobs/routines/procedures unless the task
  is explicitly about managing agents). (A stronger follow-up: deny those tools entirely during agent runs.)
- **LinkedIn integration** (#477, by sage) — drop the non-functional `linkedin_search` (LinkedIn has no
  public search API) and be honest about engagement metrics: `linkedin_list_feed` now returns
  `engagement_data_available: false` with a notice (likes/comments need the restricted r_member_social_feed
  permission / standard tier). Docs + tool descriptions updated.

## [0.13.11] — 2026-06-27

### Fixed

- **X (Twitter) profile fetch** (#476, by sage) — the X API v2 rejects `followers_count`/`following_count`
  as direct `user.fields` values (they live under `public_metrics`); the adapter now requests
  `public_metrics` and maps the counts back onto the flat profile. Tightened the merge to satisfy
  exactOptionalPropertyTypes.

## [0.13.10] — 2026-06-27

### Added

- **⑂ Compare shows each model's raw answer** — the candidate legs are now persisted onto the merged
  assistant message (metadata.fork) and rendered in a collapsible **⑂ Compared N models** disclosure below
  the answer, with a tab per model showing its full raw response (the verdict stays in the merge's
  "## Model comparison" section). Legs are also already in the cost trace (role=compare_leg, 0.13.7).
  (Live per-leg streaming — watching all models think at once — is a larger SSE change, still to come.)

## [0.13.9] — 2026-06-27

### Added

- **Tag / label files & folders** — same as conversations: a **Tag** action in the files select bar applies
  a label to the chosen fs items, and rows show their labels as chips. Tags live in fs_nodes.metadata.tags
  (no migration); `POST /api/fs {action:"tag", ids, add/remove}` + a `tag=` filter on the listing (the
  cross-folder tag-filter UI is a small follow-up). Artifacts/Drive items aren't labellable.

## [0.13.8] — 2026-06-27

### Fixed

- **Markdown spacing no longer collapses** — gaps after lists, before/after headings, and between
  paragraphs were cramped (and absent entirely in the file viewer + popup preview, which had no prose
  CSS). All markdown surfaces (chat, memory, file viewer, preview) now share a generous, consistent
  vertical rhythm using margin-top-only spacing so adjacent margins cannot collapse to nothing.

## [0.13.7] — 2026-06-27

### Added

- **Richer model picker** — catalogue rows now show the **full model name** plus a meta line with
  **parameter size** (parsed from the id, e.g. 70B / 8×7B / 480B-A35B), **context window**, and **pricing**
  ($/M in + out). The `/api/openrouter/models` proxy now also passes through `context_length`.

### Fixed

- **⑂ Compare legs now appear in the cost trace** — the parallel candidate models run outside the streamed
  turn (one-shot completions), so their token usage wasn't recorded in `eidan.llm_calls`; they're now
  logged with `role='compare_leg'`. (The per-conversation LLM-call inspector was otherwise working — its
  endpoint returns calls correctly; a Compare conversation simply had only the judge turn recorded.)

## [0.13.6] — 2026-06-27

### Removed

- **Retire the legacy `routines` feature** — superseded by agents (triggers) + procedures; the plugin is
  no longer in `CORE_PLUGINS`. Migration `0016` drops `eidan.routines` / `eidan.routine_runs` (idempotent).
  (Operator note: assorted Python-era orphan schemas — `plugin_gh/git/claude/sentry/sage`, `landing`,
  `potem` — were also dropped from the live DB; those are operator-specific cruft, not part of core.)

## [0.13.5] — 2026-06-27

### Changed

- **Procedures are now first-class** — they previously piggybacked on `eidan.knowledge` (skill=`procedure`),
  which made `recall` surface their JS source as "knowledge" and led agents to conflate them with the
  db/psql plugin. New `eidan.procedures` table (migration `0015`, migrates existing rows + retires the
  knowledge copies + repoints the executions FK); the procedure store + tool descriptions now point at the
  dedicated store and explicitly tell agents these are **not** knowledge and **not** SQL.

## [0.13.4] — 2026-06-27

### Added

- **Tag / label conversations** — building on bulk-select: a **Tag** action in the select bar applies a
  label to the chosen conversations, rows show their labels as chips, and a chip row **filters** the list
  by label (server-side). Tags live in `metadata.tags` (no migration); new `POST /api/conversations/tags`
  (bulk add/remove) + a `tag=` filter on the list. (Files tagging is the next step.)

## [0.13.3] — 2026-06-27

### Added

- **Create from the Memory UI** — a **New** button on Notes / Events / Knowledge (you could edit + delete
  but not create); `POST /api/notes`, `POST /api/knowledge` (upserts on skill+title like the agent tool),
  `POST /api/events` (reminder, optional due date). Body fields support markdown + **@-mention**.
- **Memory search** (the previously-dead toolbar button now filters the active tab) and a working **Pin**
  on notes (`PATCH /api/notes/[id]` `{pinned}`).
- **Mention chips render everywhere** — resolved `@`-mention tokens show as inline chips in the chat,
  the file/markdown viewer, and Memory (not just chat), via a shared renderer.

## [0.13.2] — 2026-06-27

### Added

- **@-mention files, folders, agents, ventures & assets** — type `@` in the chat composer or a markdown
  file editor to search and insert a **resolvable** reference (`[label](eidan:type:id)`). At turn time the
  engine **expands** each token into real context for the model — a file's contents, a folder listing, an
  agent's persona, a venture/asset descriptor — while the message keeps the readable @chip. New
  `GET /api/mentions/search`; owner-scoped; the ventures/assets sources degrade gracefully if that bundle
  isn't installed. (TipTap editors — agent persona — still mention tools only; entity types there are a
  follow-up.)

- **Memory gets delete + formatting + rich edit** — Notes, Events and Knowledge now render their bodies as
  **markdown** (GFM + mermaid) in the detail view instead of raw paragraphs, **delete** from the detail bar
  (notes/knowledge already had the API; **events** get a new `PATCH`/`DELETE /api/events/[id]`), and edit
  with **@-mention** support. Event **Mark done / Reopen** are wired (were dead stubs).

### Fixed

- **Non-markdown / agent files are now deletable** — agent-produced **artifacts** (often images, JSON,
  decks — anything not a local fs file) opened a preview with no delete and weren't bulk-selectable. They
  now have a **Delete** in the preview and join bulk-select; new `DELETE /api/artifacts/[id]` (soft-delete,
  falling through to the fs archive for fs-node ids).

### Changed

- **System prompt editor is now a rich markdown editor** (the same one agents use for personas) — toolbar
  formatting + `@`-mention support — instead of a plain monospace textarea.

## [0.13.1] — 2026-06-27

### Added

- **Run any model in chat + ⑂ Compare** — the model pickers (chat composer and the Compare multi-select)
  now search the **full OpenRouter catalogue**, not just configured providers. `POST /api/turn` resolves a
  pick that isn't a configured provider as an **OpenRouter model slug**, synthesizing a provider on the fly
  from an OpenRouter base profile (the same mechanism agents use). The "configured providers only" guardrail
  becomes catalogue-aware — an unrunnable slug still fails loudly rather than silently billing the default.
- **Bulk select + delete** on the conversation list and the file list — a **Select** toggle reveals
  checkboxes, an action bar shows the count with **Delete** (+ All / Cancel). Conversations soft-delete in
  parallel; files/folders archive recursively. Built as the base for later bulk actions (tag/label).
- **Create file + folder** in the files explorer — **New file** makes an empty markdown file and opens it in
  the editor (draft a prompt spec from scratch); **New folder** makes a folder in the current directory.

## [0.13.0] — 2026-06-27

### Added

- **⑂ Compare — run one prompt across models, a third judges & merges (fork-and-merge)** — the flagship.
  Pick 2+ models in the composer's branch menu; the prompt is raced against all of them in parallel
  (one-shot completions — no junk conversations), then your selected model **judges** the candidates and
  writes the single best **merged** answer plus a `## Model comparison` section. The user message stays
  the clean prompt and the assistant message is the merge — implemented with a one-shot `screen` hook
  that injects the candidates as ephemeral (never-persisted) context for the judge turn, so it reuses the
  whole normal streaming/persistence path. Accept by moving on, or reply to iterate. `compare: string[]`
  on `POST /api/turn`. (Candidate token usage isn't yet in the per-turn cost rollup.)
- **Files open at their own permalink with a markdown editor** — clicking a local file navigates to its
  `/files/<path>` URL (not a popup); markdown renders with GFM + **mermaid**/chart, and an **Edit** mode
  gives an inline editor with **Save** (`PUT /api/fs/file`) — so you can draft a prompt spec as a file
  and tweak it before pasting it into a chat. **Delete** + download from the same screen.
- **Mermaid diagrams in chat** — ` ```mermaid ` fenced blocks render as diagrams (lazy-loaded;
  malformed diagrams fall back to source). Reused by the upcoming file markdown viewer.
- **Delete a conversation** — from the row's kebab menu (soft-delete; messages kept for audit, the
  conversation drops out of every list; navigates away if it was open). `DELETE /api/conversations/:id`
  on the engine. **Agents** can do the same via two new memory-plugin tools — `conversation_list`
  (find the id) and `conversation_archive` (soft-delete it) — RLS-scoped to the owner.
- **Board permalinks / own screen** — the active board now lives in the URL (`<basePath>/<board-id>`,
  path not query), so every board is shareable + browser back/forward works, in both the standalone
  **Planner** (`/p/boards/<id>`) and a **venture's** boards (`/p/charles-ventures/<slug>/<id>`). Built
  via a `basePath` prop on the shared `BoardsPanel`. (Built, not yet released.)

## [0.12.4] — 2026-06-27

### Added

- **Board prompt** — every board (standalone in Planner, or scoped to a venture) can carry a **prompt /
  context** explaining what it's for, given to agents working its cards. Editable inline in the boards
  panel; new `board_set_prompt` tool. (Rename + delete already existed.)

### Changed

- **Agent org chart** layout tuned so linked clusters are readable: a **centering gravity** (nodes no
  longer fling to the edges), an **ideal-length spring** on edges (related agents settle a readable
  distance apart instead of collapsing into a blob), and stronger node separation.

## [0.12.3] — 2026-06-27

### Added

- **Agent relationships now execute** (the behaviour half). A new **`agent_delegate`** tool fires a
  target agent **immediately** with a delegated task — autonomous agent-to-agent chaining — bounded by
  a **depth + per-minute rate cap** as the runaway guard (`EIDAN_AGENT_DELEGATE_MAX_PER_MIN`, default
  30). Declaring a **`decision_gate`** now auto-wires the agent a `response` trigger, so it pauses on a
  decision escalation and resumes the moment you answer.

## [0.12.2] — 2026-06-27

### Added

- **First-class agent relationships** — `agent_to_agent` (one agent **delegates to / reviews /
  reports to / escalates to** another) and `decision_gate` (an agent **pauses for a decision** before
  proceeding) are now real `agent_triggers` types, declared with a new **`agent_relate`** tool. The
  **org chart** (Admin → Activity → Agents) renders them as labelled edges (indigo; gates dashed)
  instead of leaving relationships as prose in personas.

### Changed

- **sage escalations are formatted** — composed as markdown (a heading linking the PR, the items as
  bullets with their `file:line` refs) and **always end with a clear question**, instead of an
  unreadable semicolon-joined wall of review notes.

## [0.12.1] — 2026-06-27

### Fixed

- **Release web container image** build (broken since 0.10.0). `registry.generated.ts` imports the
  gitignored per-bundle frontend mirrors that `assemble` vendors at deploy time, but the image build
  never did — so `next build` died with `Module not found: '@/plugins/imap/Accounts'`. The image
  workflow now vendors the frontends on the runner before the build, and uses `fail-fast: false` so a
  web-image failure no longer cancels the engine image.

## [0.12.0] — 2026-06-27

### Added

- **Escalations v2** — bidirectional agent↔operator messaging: agents can be addressed, query, and
  respond; a new **`response` trigger** fires an agent the moment its escalation is answered. The
  operator **inbox** renders markdown, links reviewable refs, and shows **provenance** — which agent
  (avatar + name + link to the agent + the originating chat) or **sage** (with a link to the PR).
- **Agent graceful-restart continuation** — on `SIGTERM` (a deploy) an in-flight agent run is aborted,
  queued (`eidan.agent_restart_queue`), the user is notified, and it **resumes on next boot** as a
  continuation turn referencing the interrupted conversation.
- **Token usage & cost dashboards** — Admin → Activity → **Usage** (per provider / model / node, a
  time series, and recent calls), over the `llm_calls` ledger.
- **`db_query` introspection** — list schemas / tables / columns for autonomous schema discovery.
- **gdrive** PDF / DOCX / Excel / OCR reading (plus CSV/table parsing). OCR (`tesseract.js`) is an
  **optional, node-gated** dependency — installed on cloud nodes, skipped on the Pi.
- **Procedures UI** + a `procedures_action` tool; deep Drive/Mail **archaeology** procedures.
- **ask-user fallback** for non-interactive (agent/cron) contexts.
- **UI**: chat-list search/filtering, a mobile prompt-bar menu, an **agent org-chart**, a redesigned
  sidebar (integrations demoted to settings), and collapsible agent cards.

### Changed

- **sage** biases triage to **self-resolve** (fix/reply) rather than escalate code/CI to the operator;
  reads operator PR comments (not just Copilot threads); ships a pragmatic-default authoring persona.
- **CI** now typechecks `apps/web` (with frontend vendoring) and rejects backslash-escaped paths; the
  hard-won failure modes are lifted into `CLAUDE.md` so the same-model agents share that context.

### Removed

- **`packages/routines`** — superseded by agents; it lingered as a footgun (standing agents kept
  reaching for `routine_create` instead of doing their work).

## [0.11.0] — 2026-06-26

### Added

- **eidan virtual filesystem** (`@eidandev/fs`) — a DB-backed substrate with **local / S3 / Supabase /
  Google Drive** storage adapters and a **URL-routed file browser**; the agent uses one unified fs.
- **GitHub** per-user integration — a connection + agent tools, read/write scopes, org/repo allowlist
  (wildcards).
- **Glue** marketing adapter plugin (analytics / funnels / lists / campaigns) with a setup panel.
- **Boards** substrate and **Ventures v2** — recursive ventures, **slug routing + permalinks**,
  move/reparent (cycle-guarded), cascade delete, new resource kinds, an **`employment`** kind — plus
  **`charles-domains`** (a domains inventory with registrar import).
- **Chat attachments** (image/file) and inline chart/image rendering.
- **db** schema list/select tools; richer **memory** recall (`websearch_to_tsquery`); **telemetry**
  marks stale node heartbeats offline.

### Changed

- **routines → agents** migration; venture prompts use the WYSIWYG persona editor.

### Fixed / Security

- Glue MCP url resolves from the **vault**, not `process.env`; sage-panel CORS hardened (bearer, no
  cookies); sanitised interpolated values in plugin link hrefs (XSS-through-DOM); fs web-frontend type
  errors that broke the assembled build.

## [0.10.0] — 2026-06-25

### Added

- **Boards** — a new bundle-agnostic kanban/planning substrate **`@eidandev/boards`**. Boards scope to
  a context (a venture, or standalone); cards carry **typed references** (asset / venture / job / agent
  / domain / url), **status**, **labels/badges**, and an **activity log** with per-comment authors. A
  standalone **Planner** screen plus an embedded board on each venture; full agent toolset (`board_*`,
  `card_*`, `card_link`, `card_comment`).
- **Ventures v2** — boards + working items per venture; new resource kinds **github_repo / webpage /
  domain** (with canonical resolvers) and a **domain picker** from the domains inventory; venture
  **permalinks** (`?venture=`), **Move/reparent** (cycle-guarded), **delete** (cascade), and
  **resource → venture** link chips on the connections/domains lists; a new **`employment`** venture kind.
- **`@eidandev/charles-domains`** — a domains inventory (manual add + registrar import) with
  vault-sealed registrar keys and an engine-side import server (**GoDaddy**; cyberfolks left a
  documented stub — no public registered-domains API).
- **`@eidandev/fs`** — "eidan fs": a virtual filesystem substrate (folders, local blob storage, a web
  file browser, agent `fs_*` tools) with a pluggable StorageAdapter interface (cloud adapters to come).
- **`@eidandev/github`** — a per-user GitHub integration on the connections pattern (BYO PAT sealed in
  the vault) with agent tools: list/read repos + files, issues, pull requests, code search.
- **`@eidandev/glue`** — marketing adapter (analytics / funnels / lists / campaigns) over the operator's
  Glue MCP, with config resolved from the vault.
- **Avatars** — local **DiceBear** avatars (no CDN) across agents, boards and comments, **randomisable
  + pickable** per agent (seed + style in agent metadata).
- **Web artifact viewer** — open/preview/download agent-generated files (e.g. rendered decks) straight
  from tool results; decks render to HTML on the engine (marp).

### Changed

- **Routines retired → agents.** The prompt-only `@eidandev/routines` is folded into `@eidandev/agents`
  as the schedule trigger (one scheduler path); existing routines migrated to agents + schedule
  triggers; routines removed from the core plugin set.
- **Admin** trimmed to **dashboard · nodes · live** (log + live merged into one streaming, searchable
  view; jobs live at `/jobs`); removed dead conversations/triggers/routines/cursors panes; the nodes
  view now renders a node's tools + served kinds correctly.
- **Settings** — the global system-prompt editor is relabeled "System prompt / Custom instructions"
  (was the misleading "Agent persona"; per-agent personas live in the Agents view).

### Fixed

- **Memory recall** uses `websearch_to_tsquery` (quoted phrases / OR / `-term`).
- **Telemetry** marks stale `node_heartbeats` offline.
- Dropped dead tables (`behaviour_dlq`, `plugin_state`, `node_capability_overrides`).

## [0.9.0] — 2026-06-24

### Added

- **Social connections** — a real connection system for the `social-*` plugins on a new shared
  engine library **`@eidandev/connections-kit`** (account registry, OAuth protocol + per-platform
  adapters, a connect/reconnect/test server behind the AG-UI panel-proxy, transparent token refresh,
  and a `SocialConnections` lookup). Each platform now supports:
  - **Multiple accounts per platform**, BYO OAuth app, credentials sealed per-account in the vault
    (never shown to the model).
  - **Named OAuth apps** — register more than one app per provider (e.g. personal vs work), each with
    its own editable scopes and kind; connections pick which app to use.
  - **Test connection** (live probe), **Reauth/Reconnect**, and **Edit** (rename + a free-text
    *context* the agent reads), plus a `<platform>_list_accounts` tool.
  - Connected accounts are attachable as **Charles** venture resources (validated against the live
    registry).
  - Per-platform Connections admin screen, shared across all platforms.
- **LinkedIn** — member (Sign In + Share) and **organization/Page** connection types; per-app scopes
  matching the LinkedIn product (Community Management for Pages); **post as the organization** (org
  URN) or member; and a **post-connect Page picker** (choose which administered Page a connection
  targets). Reads the member identity via OpenID `userinfo` and org identity via `organizationAcls`.
- **Finance** — read-only `finance-xero` (OAuth via connections-kit) and `finance-stripe`
  (single-key) plugins.

### Changed

- `deploy/assemble.mjs` now vendors admin-screen frontends for **all** configured bundles (including
  sourceless folded-in AGPL bundles such as `charles-*` and `social-*`), which were previously
  silently dropped from the web build.
- `google` refactored onto `connections-kit` (its bespoke OAuth server + account store removed),
  preserving the `GoogleConnection` contract used by `gdrive`.

### Fixed

- LinkedIn read tools called non-existent endpoints (`/me`, `/feed`, `/search/posts`); now use the
  real APIs (`/v2/userinfo`, versioned `/rest/posts?q=author`) and the dead `linkedin_search` tool was
  removed (LinkedIn has no public post-search API).
- Instagram used the retired Basic Display flow ("Invalid platform app"); switched to the current
  *Instagram API with Instagram Login* (`www.instagram.com/oauth/authorize`, `instagram_business_*`).
- Web jobs board hides archived jobs (kanban semantics) (#441).

### Known limitations

- **Meta connectors (Facebook & Instagram) are experimental.** Account connection works, but posting
  targets (Facebook Page token/id, Instagram business-account media flow) are not yet fully wired —
  treat fb/ig as preview.
