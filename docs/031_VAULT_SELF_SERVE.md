# 031 — Vault self-serve: closing the docs/012 implementation gap

Status: Plan (2026-06-09)
Owner: Core
Related: [012 SECRETS](./012_SECRETS.md) (the architecture this implements),
[001 PLUGINS](./001_PLUGINS.md) (§1.1 manifest `vault:`, §2.2 PluginContext),
[011 AUTH FLOW](./011_AUTH_FLOW.md) (master key, JWT identity),
[030 A2A SECURITY SCHEMES](./030_A2A_SECURITY_SCHEMES.md).

## TL;DR

**docs/012 already specifies a per-user, self-serve secrets vault.** The
crypto and the read path are built and strong; the *write side and the
per-user dimension are spec'd but unimplemented*. "Strong vault → easy
self-serve" is therefore a finishing job, not a green-field one. This doc is
the gap analysis and the phased build that takes the partial implementation to
the self-serve vault 012 describes.

## 1. Spec (012) vs built

| 012 says | Built today | Gap |
|---|---|---|
| `secrets_vault(id, user_id FK users NULL=system, scope, key, value_enc, expires_at, …)`, unique `(user_id, scope, key)` (§4.1) | `secrets_vault(id, scope, key, value_enc)`, conflict on `(scope, key)` | **no `user_id`, no `expires_at`** — vault is instance-global (`id` PK already exists) |
| `SecretAccessor` Protocol: `__call__`(read) + `write` + `delete` (§5) | Protocol declares only `__call__`; impl is a bare read coroutine ("Phase 4 stubs the surface") | **no `write`/`delete` on `ctx.secret`** |
| `secrets.read/write/delete(pool, …)` module API (§5.1–5.3) | only private read helpers + `make_secret_accessor`; writes hand-rolled in `api_keys`/`a2a_vault`/`mfa` via `encrypt_value`+upsert | **no canonical write/delete; three copies of the upsert** |
| `secrets_audit` read/write/delete/denied (§8) | — | **no audit trail** |
| Admin UI + self-serve "Connect" linking flows (§9.2–9.3) | no HTTP route touches secrets | **no self-serve front door** |
| Declared-access only; `UndeclaredAccessError` on undeclared read/write (§6.1) | `validate_required_secrets` checks *required* keys at activation only; runtime returns `None` for anything | **no runtime access enforcement** |
| TTL sweep (§5.4); master-key rotation (§10) | — | hardening, deferred |
| Crypto: Fernet ← HKDF(`EIDAN_AUTH_MASTER_KEY`) (§4.2) | **built, exactly as spec'd** | — |
| Read accessor: per-agent override → env → vault | **built** (richer than 012) — but the per-agent tier reads **plaintext** `agent_context.user_overrides.secrets`, not the encrypted per-user vault | **per-user secrets aren't encrypted at rest** |

The last row is the crux for self-serve: per-user secrets *exist* today, but
only in the unencrypted per-agent-override tier. The encrypted vault is
instance-global. Self-serve needs **encrypted, per-user** secrets — i.e. the
`user_id` column 012 already specifies.

## 2. Decisions the build must make (where 012 underspecifies for multi-tenant)

1. **`user_provided` manifest flag.** A `vault[]` entry today is either
   operator-supplied (env/CLI) or absent. Self-serve adds a third origin: the
   *end user* supplies it (their Stripe key). Add `user_provided: true` to the
   manifest `vault[]` grammar. `validate_required_secrets` **skips**
   `user_provided` keys at activation (no user exists yet); the HTTP API (Phase
   2) is the only writer for them, scoped to the authenticated user.
2. **Write authorization.** The self-serve endpoint writes a **user-scoped**
   row (`user_id` = caller) only for keys a loaded plugin declared
   `user_provided`. No cross-user writes; no writes to `system`/`core` scope
   over the API (those stay CLI/operator). Enforced by `UndeclaredAccessError`.
3. **Fold the per-agent tier into the encrypted vault.** Migrate
   `agent_context.user_overrides.secrets` reads to the `user_id`-scoped vault so
   per-user secrets are encrypted at rest. Keep the read precedence (per-user →
   env → instance-vault); just change where the per-user value comes from.
4. **One KEK now, per-tenant later.** Keep the single `EIDAN_AUTH_MASTER_KEY`
   for v1 (correct for single-operator self-host). Hosted multi-tenant
   isolation = derive a per-tenant key via HKDF `info = b"…/" + tenant_id`
   (the primitive is already there) + the §10 rotation procedure. Phase 4.

## 3. Phased build

**Phase 1 — Foundation (per-user vault + canonical accessor).** Pure core, no
behaviour change to existing reads.
- Migration: add `user_id` (FK `users`, NULL = instance) + `expires_at` to
  `secrets_vault` (`id` PK already exists); switch uniqueness to a named
  `(user_id, scope, key)` constraint per §4.1.
- Implement `secrets.read/write/delete(pool, key, *, user_id=None, …)` (§5),
  wrapping `vault_crypto.encrypt_value`/`decrypt_value`. Refactor
  `api_keys`/`a2a_vault`/`mfa` onto them (kills the three upsert copies).
- Extend `SecretAccessor` Protocol + `make_secret_accessor` to expose
  `write`/`delete`, user-scoped via the `current_agent_id`/user contextvar.
- Add `secrets_audit` (§8); write a row on every read/write/delete/denied.
- *Unblocks:* `ctx.secret.write(...)` per-user, encrypted.

**Phase 2 — Self-serve API + manifest. ✅ built.**
- `user_provided` manifest flag (`VaultItem.user_provided`) + `validate_required_secrets`
  skips it at activation. (Runtime `UndeclaredAccessError` enforcement on *reads*
  stays Phase 4 — today the accessor still degrades to `None`.)
- Authenticated `GET/PUT/DELETE /api/me/secrets[/{key}]` (`http/secrets.py`):
  **write-only** (never returns a value), `GET` lists *metadata* (which keys are
  set, when), `user_id` = JWT subject, a write gated by the `user_provided`
  declaration across loaded plugins (`secrets.user_provided_keys`). Writes/deletes
  audit via the canonical accessor.
- *Unblocks:* a customer can store their own credential via the API.

**Phase 3 — UI (the front door). ✅ built.**
- A **Connections** panel on the settings page (`ConnectionsSection`): lists
  every `user_provided` key declared across loaded plugins, paste-a-value form
  → Phase 2 API, "set"/"not set" chips, remove. Values never shown back.
  (`GET /api/me/secrets` returns the catalogue: declared keys + configured/expiry.)
- *Follow-ups:* a per-plugin slot rendering (vs the one core panel) via the #286
  frontend registry, and the OAuth "Connect" linking flows (§9.3) writing the
  same way.

**Phase 4 — Hardening.**
- TTL sweep (§5.4); per-tenant KEK derivation + master-key rotation (§10);
  full undeclared-access enforcement; admin secrets UI (§9.2).

## 4. What this unblocks

- **Charles financials** (docs/003): Stripe/Xero/D2D per-account keys live
  encrypted, per-user — the blocker called out there.
- **Every integration**: read `ctx.secret(key)` (per-user), store via the API.
- **Hosted multi-tenant self-serve**: each customer brings their own creds;
  one deployment, many users, isolated secrets. The platform unlock.

## 5. Recommended first PR

**Phase 1 only.** It's the smallest safe core change — additive schema +
canonical `read/write/delete` + accessor extension + audit — with **no change
to existing read behaviour** (new columns are nullable; instance-scoped reads
are `user_id IS NULL`). Everything else (API, UI, multi-tenant KEK) builds on
it, and it already lets host + plugin code write per-user encrypted secrets.
Ship it, then layer Phase 2's front door.
