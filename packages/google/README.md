# @eidandev/google

The **Google / Gmail** integration — read-through Gmail access over OAuth2.
A matbot plugin (part of the eidan-pro baseline bundle): it registers the
two Gmail tools below over the `plugin_google.*` schema, and publishes a
shared `GoogleConnection` service so sibling plugins (e.g. `gdrive`) reuse
one connected account.

Connection model: the operator connects one or more Gmail accounts in the
**Connections** screen (the plugin's frontend manifest). Per account, the
OAuth client id/secret (sealed as JSON under `client_vault_key`) and the
durable refresh token (under `refresh_vault_key`) live in the **vault**
(`eidan.secrets_vault`); the registry rows live in `plugin_google.accounts`.
Each call mints a short-lived access token from the stored refresh token,
then calls the Gmail API — read-only, nothing stored beyond the registry.
Because the web is a *write-only* vault client (it can seal an OAuth client
but never read it back), the engine runs a small authenticated OAuth
reconnect server (`oauth-server.ts`, behind the AG-UI panel-proxy) that
rebuilds the consent URL and exchanges the auth code under the caller's
Principal. A legacy single env account (`EIDAN_GOOGLE_*`, declared to the
Settings → Connections catalog via `EidanSecrets`) is the fallback when no
account is connected.

## Tools

| Tool | Purpose |
|------|---------|
| `gmail_list_recent` | List recent Gmail messages (id, from, subject, date, snippet), optionally filtered by a Gmail search `query` (e.g. `from:alice is:unread`). |
| `gmail_read`        | Read one message in full (headers + plain-text body, capped 8k) by `message_id`. |

## Example

> **You:** Any unread mail from my accountant?
>
> → the agent calls `gmail_list_recent({ query: "from:accountant is:unread" })`,
> then `gmail_read({ message_id: "..." })` — resolving the connected
> account's refresh token from the vault and minting an access token per call.

## Layout

- `src/index.ts` — the `MatbotPluginSpec`; optionally builds `Db` from `EIDAN_DATABASE_URL`, registers the tools, publishes the `GoogleConnection` service, declares the legacy section to `EidanSecrets`, and starts the OAuth reconnect server.
- `src/tools.ts` — the matbot `Tool[]`; `resolveFromRegistry` (the shared connected-account resolver) + legacy `EIDAN_GOOGLE_*` fallback.
- `src/gmail.ts` — the Gmail API client (`fetch`-based).
- `src/oauth.ts` — OAuth2 protocol helpers: refresh access token, build consent URL, exchange code, fetch the connected email, scopes.
- `src/oauth-server.ts` — authenticated server-side reconnect endpoints (panel-proxy), all owner-scoped via `runAs`.
- `src/vault.ts` — vault `secretOpt` helper.
- `src/db.ts` — owns `plugin_google.*`; principal-stamped helper; account status lifecycle (`pending` → `active`); `ensureSchema` (idempotent).

## Schema

`plugin_google.accounts` — per-user registry: name, slug, connected `email`,
the `client_vault_key` / `refresh_vault_key` vault refs, and `status`
(`pending` during an in-flight connect, then `active`; archived rows free
the slug). No tokens land here. Created idempotently on first boot.

## Config

- `EIDAN_DATABASE_URL` (or `DATABASE_URL`) — Postgres connection. Without it the plugin still loads but serves only the legacy single-account env path (no registry, no OAuth screen).
- `EIDAN_GOOGLE_CLIENT_ID` / `EIDAN_GOOGLE_CLIENT_SECRET` / `EIDAN_GOOGLE_REFRESH_TOKEN` — legacy single-account fallback (refresh token obtained via the consent flow with the `gmail.readonly` scope).
- `MATBOT_GOOGLE_OAUTH_PORT` — OAuth reconnect server port (default 8094).
