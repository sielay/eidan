# @eidandev/gdrive

The **Google Drive** integration — read-through Drive access over OAuth2. A
matbot plugin (part of the eidan-pro baseline bundle): it registers the
three Drive tools below. It owns no schema of its own.

Connection model: the tools resolve OAuth credentials from the shared
`GoogleConnection` service that the `google` (Gmail) plugin registers — the
per-account `plugin_google.accounts` registry plus the vaulted client id/
secret + refresh token. So a **single connected Google account serves both
Gmail and Drive**; the only requirement is that the consent grant also
carried the `drive.readonly` scope. When no account is connected, it falls
back to the legacy `EIDAN_GOOGLE_*` vault keys (declared to the Settings →
Connections catalog via `EidanSecrets`). Each call refreshes a short-lived
access token from the resolved refresh token, then calls the Drive v3 REST
API — read-only, nothing stored.

## Tools

| Tool | Purpose |
|------|---------|
| `gdrive_list_recent` | List the most recently modified files (id, name, type, modified time, owner, link). Folders and trashed files excluded. |
| `gdrive_search`      | Search Drive by file name and full-text content for `query`, newest first; returns file metadata. |
| `gdrive_read_file`   | Read one file as text by `file_id`. Docs/Slides export to plain text, Sheets to CSV, plain-text files download directly (capped 16k; binaries unsupported). |

## Example

> **You:** Find my Q3 planning doc and summarise it.
>
> → the agent calls `gdrive_search({ query: "Q3 planning" })`, then
> `gdrive_read_file({ file_id: "..." })` — reusing the Google account
> connected for Gmail (its consent grant includes `drive.readonly`),
> minting an access token from the vaulted refresh token per call.

## Layout

- `src/index.ts` — the `MatbotPluginSpec`; wires the tools to the shared `GoogleConnection.resolveCreds`, declares the legacy fallback section to `EidanSecrets`.
- `src/tools.ts` — the matbot `Tool[]`; resolves creds (shared connection first, then legacy `EIDAN_GOOGLE_*`), refreshes the access token per call.
- `src/drive.ts` — the Drive v3 read client (`fetch`-based): list/search + read-as-text with Google-native export.
- `src/oauth.ts` — OAuth2 refresh-token → access-token helper (duplicated from `google` in shape; collapses into a shared module once the connection registry lands on core).
- `src/vault.ts` — vault `secretOpt` helper.

## Schema

None — `gdrive` owns no tables. It reads the connected Google account via
the `google` plugin's `plugin_google.accounts` registry (through the shared
`GoogleConnection` service) or the legacy vault keys.

## Config

- `EIDAN_GOOGLE_CLIENT_ID` / `EIDAN_GOOGLE_CLIENT_SECRET` / `EIDAN_GOOGLE_REFRESH_TOKEN` — legacy fallback only; prefer connecting a Google account under Connections (Gmail). The refresh token's grant must include the `drive.readonly` scope (alongside `gmail.readonly` if Gmail is also used).
