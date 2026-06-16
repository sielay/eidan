<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# 0009 — Secrets vault (encrypted, per-user, capture-safe)

Status: **Shipped** — `@eidandev/vault-postgres` + `@eidandev/secrets-api`.

## Goal

Hold third-party credentials (API keys, OAuth tokens, mail passwords) so the agent can **use** them
without ever **seeing** them. Secrets are encrypted at rest, scoped per user, and resolved by
reference (`${NAME}`) inside plugin code — never pasted into a prompt or handed to a model.

## The two halves

- **`@eidandev/vault-postgres`** — swaps matbot's default env vault for an **encrypted Postgres
  backend** via `services.register('Vault', …)`. After it loads, every `ctx.vault.resolve('${NAME}')`
  reads `eidan.secrets_vault` (decrypting at read time), falling back to env. It also registers the
  `EidanSecrets` service and a **value-free `secret` chat tool** (the agent can list/clear keys, but
  the tool never carries a value).
- **`@eidandev/secrets-api`** — the **LLM-free write path** (`:8092`, exposed via `PanelProxy` at
  `/api/me/secrets`). The Settings UI's masked field PUTs a value here server-side, so it reaches the
  encrypted store **without passing through a model turn**. `GET /api/me/secrets` (metadata — which
  keys are set) + `/catalog` (plugin-declared fields, no values); `PUT`/`DELETE /api/me/secrets/:name`.
  All under the Bearer-resolved `Principal`.

## Encryption (`crypto.ts`)

- **Fernet** (AES-128-CBC + HMAC-SHA256, urlsafe-base64 envelope) — a byte-for-byte TS port of the
  Python implementation, so `value_enc` rows are **interchangeable** between the two stacks.
- The key is `HKDF-SHA256(EIDAN_AUTH_MASTER_KEY)` → 32 bytes (16 sign + 16 AES). The HKDF salt/info
  are fixed + public by design (HKDF needs no secret salt). **`EIDAN_AUTH_MASTER_KEY` is the only
  secret that lives in the deploy env** and never in the DB.
- `decryptValue` throws on tamper / wrong key (HMAC mismatch) — callers treating a secret as optional
  must catch and degrade, never silently fall back to plaintext.

## Key namespacing

A key is `scope.subkey` (`secret-key.ts#splitSecretKey`): a flat name with no dot
(`EIDAN_IMAP_PASSWORD`) lands in scope `core`; `slack.bot_token` → scope `slack`, subkey `bot_token`.
The read path and the write tool share this one parser so a value is always found by the key it was
set under.

## Per-user scoping

Writes encrypt under the **ambient `Principal`**; reads prefer the caller's user row and fall back to
the instance-wide `user_id IS NULL` row. The query also stamps `eidan.current_user_id` so Postgres
**RLS** isolates per-user secrets when the runtime connects as a non-superuser app role.

## Config

| Env | Meaning |
|---|---|
| `EIDAN_DATABASE_URL` | the `eidan.secrets_vault` store. |
| `EIDAN_AUTH_MASTER_KEY` | the KEK that seals every secret at rest (generate: `node -e "console.log(require('crypto').randomBytes(36).toString('base64url'))"`). The plugin refuses to start without it. |

Load `vault-postgres` **early** (before plugins that resolve `${NAME}`), and `secrets-api` after
`auth` + `frontend-agui` (it needs the principal resolver + the front-door proxy).

## Files of record

- `packages/vault-postgres/src/crypto.ts` — Fernet encrypt/decrypt + HKDF key derivation.
- `packages/vault-postgres/src/secret-key.ts` — `splitSecretKey` (scope/subkey).
- `packages/vault-postgres/src/{vault,db,secrets-service,index}.ts` — Vault backend, store, `EidanSecrets`, wiring.
- `packages/secrets-api/src/server.ts` — the authenticated HTTP write path (values never reach the LLM).
