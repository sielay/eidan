# @eidandev/vault-postgres

eidan's **encrypted secrets vault** — the matbot `Vault` backend over
`eidan.secrets_vault`. It replaces the default env-only vault so every
`ctx.vault.resolve('${NAME}')` reads a per-user, encrypted-at-rest store, with
`process.env` kept as the static fallback tier (operator/provider keys like
`ANTHROPIC_API_KEY`, `EIDAN_AUTH_MASTER_KEY`).

The plugin registers two **services** plus one value-free chat tool. The
secret-management surface (`EidanSecrets`) is a service consumed by other
plugins and by the HTTP write path (`@eidandev/secrets-api`); the lone agent
tool (`secret`) is documented below because it never touches a secret value.

## What it provides

- **`Vault` service** (`PostgresVault`) — swapped in via `register('Vault', …)`.
  `resolve(ref)` expands `${NAME}` refs: encrypted vault first (user-scoped row
  via the ambient `Principal` preferred, instance-wide `user_id IS NULL`
  fallback), then `process.env`; a miss throws `MissingSecretError`. Also
  implements `scrub` (redacts resolved values from model-facing text via an
  in-memory cache), `hasKey`, `findByValue`, `writeSecret`/`deleteSecret`,
  `createSecret` (dedup-aware).
- **`EidanSecrets` service** (`EidanSecretsImpl`) — the richer eidan surface:
  `declareSection`/`catalog` (plugins declare the secret fields they need for
  the Settings UI), `setSecret`/`deleteSecret`, and `listMetadata` (names +
  `you`/`instance` scope + `updatedAt`, **never values**).

## Tools

| Tool | Purpose |
|------|---------|
| `secret` | Help the user manage their own integration secrets **without ever handling a value**. Actions: `list` (metadata only), `delete` (by `name`), `request` (returns a structured `secure_entry` prompt the frontend renders as a masked field that PUTs the value straight to the secrets API). Actual writes never pass through the LLM. |

## Example

> **You:** Connect my work calendar feed.
>
> → the agent calls `secret({ action: 'request', name: 'EIDAN_ICAL_FEED_URLS', reason: 'to read your calendar' })`, the UI shows a secure field, and the value is PUT to `/api/me/secrets/EIDAN_ICAL_FEED_URLS` server-side — the assistant never sees it.

## Layout

- `src/index.ts` — the `MatbotPluginSpec`; builds `Db`, registers `Vault` +
  `EidanSecrets`, and the `secret` tool. Requires `EIDAN_AUTH_MASTER_KEY`.
- `src/vault.ts` — `PostgresVault`: resolution order, scrub cache, write path.
- `src/secrets-service.ts` — `EidanSecrets` interface + impl (catalog/metadata).
- `src/tools.ts` — the value-free `secret` tool.
- `src/crypto.ts` — Fernet at-rest (AES-128-CBC + HMAC-SHA256), key via
  HKDF-SHA256 from `EIDAN_AUTH_MASTER_KEY`; byte-compatible with the Python
  `vault_crypto.py` so ciphertext interchanges. Tested in `crypto.test.ts`.
- `src/secret-key.ts` — pure `scope.subkey` namespacing (`secret-key.test.ts`).
- `src/db.ts` — pg wrapper for `eidan.secrets_vault`; stamps the principal GUC.

## Schema

`eidan.secrets_vault` — `(user_id, scope, key, value_enc bytea, expires_at, …)`,
unique on `(user_id, scope, key)`; a flat name like `EIDAN_IMAP_PASSWORD` lands
in scope `core`, `slack.bot_token` → scope `slack`. Applied by the core migrate
runner (`migrations/sql/*.sql`), not per-plugin.

## Config

- `EIDAN_DATABASE_URL` (or `DATABASE_URL`) — Postgres connection (**required**).
- `EIDAN_AUTH_MASTER_KEY` — the KEK that seals secrets at rest (**required**;
  must be identical across nodes sharing the vault).
