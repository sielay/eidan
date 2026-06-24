# @eidandev/connections-kit

Shared **engine-side** machinery for BYO-client OAuth integrations. The `google` and `social-*`
plugins are thin consumers; the kit owns the parts that are identical across every platform.

## What it provides

- **`Registry`** — a per-plugin account registry over `plugin_<name>.accounts` (multi-account,
  optional per-host). `ensureSchema()` is additive (create-if-not-exists + `add column if not exists`
  + back-fill `external_handle` from a legacy `email` column), so it evolves an existing table with
  no migration. Principal-stamped (`eidan.current_user_id`) for RLS.
- **`OAuthAdapter`** — the *only* per-platform surface: `flavor`
  (`oauth2` | `oauth2_pkce` | `dynamic_app` | `app_password`), scopes, endpoints, `fetchIdentity`,
  and optional `registerApp` (per-host / Mastodon) + `tokenAuthStyle` (X uses HTTP Basic).
- **`startOAuthServer`** — the loopback connect/reconnect HTTP server behind the AG-UI panel-proxy:
  `/start` (build consent URL, generate+stash a PKCE verifier, register a per-host app) and `/finish`
  (exchange the code, seal tokens, probe identity, activate). One per OAuth-capable plugin.
- **`resolveAccessToken`** — per-call token resolution for the agent tools: pick the selected account,
  read its token, and transparently refresh + re-seal an expired one (under the caller's Principal).
- **`registerSocialConnection`** — registers a provider's connected-account lookup into a shared
  `SocialConnections` service so Charles can validate a handle without importing the plugin's DB.
- **`keys`** — `slugify`, `normalizeHost`, and the per-account vault key derivation.

The React Connections dashboard is **not** here — it lives in `apps/web/src/plugins/_shared/`
(`SocialConnections.tsx`, `SocialCallback.tsx`, `socialAccountsRoute.ts`, `social.css`), because the
web layer imports apps/web aliases and is vendored per-plugin by the deploy assembly.

## Secrets never reach the model

Client id/secret, access tokens and refresh tokens live only in the vault (Fernet-at-rest, KEK in
env). Tools resolve a token into a local variable handed to the platform client; tool *results*
surface handles/ids/URLs only. The accounts API returns just
`{id,name,slug,host,external_handle,status,token_expires_at}` — the client secret is POSTed once to
seal it and is never read back.

## Forward-compat: sharing a connection later

Connections are **user-scoped today** (the `accounts.user_id` column + RLS), but the design keeps a
future move to venture-scoped or shared connections to an RLS/policy change, not a rewrite:

- **Vault keys are keyed by `(provider, slug)`, never by `user_id`.** The vault is already user-scoped
  by *storage* (`eidan.secrets_vault` stamps the principal), so widening ownership doesn't require
  renaming any key.
- **`external_ref` is a public handle**, never a secret — already shareable (this is what surfaces to
  Charles as a `venture_resources` asset).
- Adding an `owner_scope`/`shared` dimension is an additive column + a policy change; the registry,
  OAuth server, and resolver are agnostic to who owns the row.
