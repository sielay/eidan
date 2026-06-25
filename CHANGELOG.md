# Changelog

All notable changes to eidan are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); releases are cut by bumping
`package.json` and merging `next-release` → `main` (which tags `v<version>` and builds images).

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
