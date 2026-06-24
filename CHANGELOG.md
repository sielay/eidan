# Changelog

All notable changes to eidan are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); releases are cut by bumping
`package.json` and merging `next-release` → `main` (which tags `v<version>` and builds images).

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
