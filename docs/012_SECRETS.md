# 012 — Secrets architecture (env vars + native vault)

Status: Draft (2026-05-21 — replaces the Supabase-Vault-pinned earlier
revision)

Owner: Core

Related: [ARCHITECTURE](./ARCHITECTURE.md), [PLUGINS](./001_PLUGINS.md)
(§1.1 manifest `env:` / `vault:`, §2.2 PluginContext, §8.1 install
validation), [MIGRATIONS](./002_MIGRATIONS.md), [MEMORY DDL](./003_MEMORY_DDL.md),
[AGENTIC LOOP](./005_AGENTIC_LOOP.md), [PROVIDER ABSTRACTION](./007_PROVIDER_ABSTRACTION.md)
(§7 keys), [AUTH FLOW](./011_AUTH_FLOW.md) (§5.2 keypair sealing).

Eidan handles secrets across **two tiers**:

- **Static** — env vars set at deploy time. Immutable for the life of
  the process.
- **Dynamic** — rows in `eidan.secrets_vault`, encrypted at rest with
  a Fernet key derived from `EIDAN_AUTH_MASTER_KEY`. Mutable at
  runtime by plugin code.

Both tiers are owned by the host. Plugins request typed access via
their `plugin.yaml` manifest and reach values through
`PluginContext.secret(...)`. The host refuses reads / writes that
weren't declared.

Out of scope:

- Hardware-token / passkey storage.
- Per-secret per-plugin RBAC beyond the manifest's `vault.*`
  declarations (a richer scope grammar is deferred to a paid
  plugin).
- Encryption of static env vars at rest in the operator's
  environment.

---

## 1. Vocabulary

| Term                | Meaning                                                                                                       |
|---------------------|---------------------------------------------------------------------------------------------------------------|
| **Static tier**     | Secrets supplied via process environment variables. Declared in `plugin.yaml` `env:`.                         |
| **Dynamic tier**    | Secrets stored in `eidan.secrets_vault`, encrypted with a Fernet key derived from the master key.            |
| **Master key**      | `EIDAN_AUTH_MASTER_KEY` env var. HKDF-SHA256-derives a Fernet key used to seal vault rows + auth artifacts.   |
| **Vault key**       | A dotted identifier `<scope>.<name>` (e.g. `plugin_gmail.oauth.refresh_token`, `core.smtp_password`).        |
| **Scope**           | The owner namespace — `core`, `plugin_<slug>`, or `system`. Plugins are restricted to their own scope.       |
| **Subject**         | The user the secret belongs to (`eidan.users.id`). `system` and `core` scopes use the deployment's "system" subject. |
| **PluginContext.secret** | The accessor surface plugins use: `await ctx.secret.get("oauth.refresh_token")`.                            |

---

## 2. The two-tier model

| Tier      | Owner          | Subject     | Mutable at runtime | Survives restart | Set by                              | Example                                  |
|-----------|----------------|-------------|--------------------|------------------|-------------------------------------|------------------------------------------|
| Static    | Host / plugin  | Deployment  | No                 | Yes              | Operator (env, `.env`, secret mgr)   | `ANTHROPIC_API_KEY`, `EIDAN_SMTP_PASSWORD` |
| Dynamic   | Host / plugin  | A user      | Yes                | Yes              | Plugin code, admin UI, OAuth flows  | `plugin_gmail.oauth.refresh_token`       |

**Rule of thumb.** A secret that the operator sets once and forgets is
static. A secret that code rotates, that one user has and another
doesn't, or that the host generates on the fly is dynamic.

### 2.1 What is NOT a secret

- Plugin manifest values like `display_name`, `behaviours[]`, or
  `mcp.tools[]`. Public config; lives in `plugin.yaml`.
- The user's email (`EIDAN_AUTH_ALLOWED_EMAIL`). Sensitive-ish but
  surfaced via the public `/api/auth/config` for UI pre-fill, so it
  is not held as a secret.
- The RS256 public PEM (`011 §5.2`). Public by design.

---

## 3. Static tier (env vars)

### 3.1 Where declared

In `plugin.yaml`:

```yaml
env:
  - key: EXAMPLE_NOTES_BASE_URL
    required: true
  - key: EXAMPLE_NOTES_API_KEY
    required: true
    secret: true       # marks the value as "do not log"
```

Core's own env vars (`DATABASE_URL`, `ANTHROPIC_API_KEY`,
`EIDAN_AUTH_MASTER_KEY`, …) are not declared in any plugin — they
live in `.env.example` and are validated at backend startup.

### 3.2 Naming convention

- Plugin env vars: `<PLUGIN_SLUG_UPPER>_<NAME>`, e.g.
  `EXAMPLE_NOTES_API_KEY`.
- Core env vars: `EIDAN_<NAME>`.
- Provider keys: the SDK's own conventional name (`ANTHROPIC_API_KEY`,
  `OPENAI_API_KEY`) — these aren't Eidan-namespaced because the
  upstream SDKs read them directly.

### 3.3 Validation at startup

`backend bootstrap` checks every declared `env:` entry before any
plugin loads. A missing `required: true` value fails the boot loudly
with a message naming the plugin and the offending key.

`secret: true` flips two switches:

- The value is redacted in any log line that mentions it (the
  redactor matches by value, not by name).
- The CLI's `eidan admin doctor` prints `<set>` / `<unset>` instead
  of the raw value.

### 3.4 What plugins see

`PluginContext.env(key)` returns the env var's string value or
raises `MissingEnvVar` when the operator didn't set it. The host
refuses access to env vars that aren't declared in the plugin's
manifest — even if they are otherwise present in the process
environment.

---

## 4. Dynamic tier (native vault)

### 4.1 Backing store

`eidan.secrets_vault`:

| Column        | Type         | Notes                                                                  |
|---------------|--------------|------------------------------------------------------------------------|
| `id`          | uuid PK      |                                                                        |
| `user_id`     | uuid         | FK to `eidan.users(id)`. NULL for `system` / `core` scope.             |
| `scope`       | text         | `core` / `plugin_<slug>` / `system`. Plugin scope is plugin-slug-pinned.|
| `key`         | text         | The dotted suffix after the scope (e.g. `oauth.refresh_token`).         |
| `value_enc`   | bytea        | Fernet-sealed ciphertext.                                              |
| `expires_at`  | timestamptz  | NULL = no TTL.                                                         |
| `created_at`  | timestamptz  | row insert.                                                            |
| `updated_at`  | timestamptz  | trigger-maintained on update.                                          |

Uniqueness is `(user_id, scope, key)` — a user's GitHub OAuth token
and another user's GitHub OAuth token coexist; one user can't have
two values under the same scope.key.

### 4.2 Encryption

```
EIDAN_AUTH_MASTER_KEY  ──HKDF-SHA256──▶  Fernet key  ──▶  Fernet.encrypt(plaintext)
   (env var)                                                           │
                                                                       ▼
                                                              eidan.secrets_vault.value_enc
```

The HKDF parameters are fixed in code (`auth_native/vault_crypto.py`):

- `salt = b"eidan-auth-master-key/v1"`
- `info = b"eidan vault encryption"`

Changing either parameter is a hard cut — all existing rows become
undecryptable.

The Fernet ciphertext binds the IV, MAC, and timestamp, so a stolen
row cannot be replayed past `expires_at` (Fernet has its own TTL
mechanism layered on top of the explicit `expires_at` column).

### 4.3 Scope taxonomy

| Scope             | Subject               | Who reads / writes                           |
|-------------------|-----------------------|-----------------------------------------------|
| `core`            | deployment            | Host code (e.g. SMTP password rotation).      |
| `plugin_<slug>`   | a user or deployment  | The plugin whose slug matches.                |
| `system`          | deployment            | Host code (e.g. cross-plugin shared infra).   |

Plugins **never** read or write outside `plugin_<slug>`. Attempts
to do so raise `ScopeDenied` and emit a WARN log line.

### 4.4 Address grammar

The accessor takes a dotted address that the host splits on the
first `.`:

```
plugin_gmail.oauth.refresh_token   →  scope="plugin_gmail",  key="oauth.refresh_token"
core.smtp_password                  →  scope="core",          key="smtp_password"
oauth.refresh_token                 →  scope="core",          key="oauth.refresh_token"
                                       (the bare form falls into core)
```

The grammar matches `secrets._read_native_vault` in the backend.

---

## 5. Backend accessor API

`eidan_backend.secrets`:

```python
async def read(pool, key: str)            -> str | None
async def write(pool, key: str, value: str, *, ttl_seconds: int | None = None) -> None
async def delete(pool, key: str)          -> None
```

The host module is what `PluginContext.secret` wraps; the plugin
surface (§6) is the stable contract. Host code reaches the bare
module for its own work (the SMTP password rotation, the keypair
seal in `auth_native/keys.py`, …).

### 5.1 `read`

Returns the decrypted plaintext or `None` when the row is missing
or `expires_at < now`. Expired rows are not deleted on read; the
TTL sweep (§5.4) handles cleanup.

### 5.2 `write`

Encrypts the plaintext and upserts the row. The Fernet output is
non-deterministic — two writes of the same plaintext produce
different `value_enc` ciphertexts.

### 5.3 `delete`

Idempotent hard delete. A missing row is a successful no-op.

### 5.4 TTL sweep

A scheduled task (cron, every 5 min) deletes rows where
`expires_at < now()`. The sweep is best-effort; reads already filter
on the same predicate, so a missed sweep only means stale rows
linger in the table.

### 5.5 Concurrency

Postgres row-level locks. Two concurrent writes against the same
`(user_id, scope, key)` serialise; the latest write wins. There is
no compare-and-swap surface — OAuth refresh-token rotation handles
contention by re-reading inside the same transaction (see §7).

---

## 6. Plugin access surface

`PluginContext.secret` is a `PluginSecretAccessor` instance scoped
to the calling plugin. The plugin slug is baked in at activation
time; the plugin cannot read or write outside its own scope.

```python
async def example_oauth_callback(ctx: PluginContext, code: str) -> None:
    tokens = await exchange_code(code)
    await ctx.secret.write("oauth.access_token",  tokens.access_token, ttl_seconds=tokens.expires_in)
    await ctx.secret.write("oauth.refresh_token", tokens.refresh_token)

async def example_api_call(ctx: PluginContext) -> None:
    refresh = await ctx.secret.read("oauth.refresh_token")
    if refresh is None:
        raise NotConnected("plugin not yet linked")
    ...
```

### 6.1 Declared access only

The manifest's `vault:` block enumerates every key the plugin may
touch:

```yaml
vault:
  - key: oauth.refresh_token
    description: "OAuth2 refresh token for the operator's account"
  - key: oauth.access_token
    description: "Short-lived OAuth2 access token"
    rotates: true
    ttl_default: 3600
```

`rotates: true` is informational — it tells the host the value
churns frequently; the audit table (§8) and the operator surfaces
(§9) suppress noisy notifications on rotates-marked keys.

`ttl_default` is the default the host applies when `ttl_seconds` is
omitted on `write`.

### 6.2 What plugins do NOT get

- A list of other plugins' keys.
- A wildcard read across the whole vault.
- The raw `secrets_vault` table — no plugin code touches it
  directly.
- A subject other than the calling turn's identity. Background
  behaviour ticks inherit the spawning turn's identity (`005 §5.10`);
  a tick with no turn raises.

---

## 7. Rotation: OAuth refresh tokens

OAuth providers (Gmail, GitHub, …) emit a short-lived access token
and a long-lived refresh token. The dominant write path is "use the
refresh to mint a new access".

Pattern (in plugin code):

```python
async def access_token(ctx: PluginContext) -> str:
    access = await ctx.secret.read("oauth.access_token")
    if access is not None:
        return access

    refresh = await ctx.secret.read("oauth.refresh_token")
    if refresh is None:
        raise NotConnected("plugin not yet linked")

    new_access, new_refresh, expires_in = await refresh_with_provider(refresh)
    await ctx.secret.write("oauth.access_token",  new_access, ttl_seconds=expires_in - 60)
    if new_refresh and new_refresh != refresh:
        await ctx.secret.write("oauth.refresh_token", new_refresh)
    return new_access
```

The 60-second slack on `expires_in` keeps the cached token usable
for a full subsequent call.

When the provider rotates the refresh token on each use (Google's
shape), the plugin MUST persist the new value or the next refresh
fails permanently — every Google integration has lost a user at
least once this way.

---

## 8. Audit trail

`eidan.secrets_audit` records every read, write, and delete:

| Column         | Type        | Notes                                              |
|----------------|-------------|----------------------------------------------------|
| `id`           | bigserial   |                                                    |
| `actor`        | text        | `core`, `plugin_<slug>`, or `cli`.                 |
| `subject_user` | uuid        | NULL for `core` / `system`.                        |
| `scope`        | text        | the row's scope                                    |
| `key`          | text        | the row's key                                      |
| `action`       | text        | `read` / `write` / `delete` / `denied`             |
| `outcome`      | text        | `ok` / `not_found` / `denied` / `error`            |
| `request_id`   | text        | matches the inbound request's `X-Request-Id`       |
| `created_at`   | timestamptz |                                                    |

What is **not** recorded:

- The plaintext value.
- The ciphertext.
- IP / user-agent — those land on `eidan.auth_sessions`, not here.

The table is append-only and purged by a separate retention job
(`eidan_admin_audit_purge`), default 90 days.

---

## 9. Operator surfaces

### 9.1 CLI

```
eidan admin secrets list                       # all rows, scoped to invoking user
eidan admin secrets get <scope>.<key>          # decrypted value (stdin-piped → file)
eidan admin secrets set <scope>.<key>          # prompts for value, never argv
eidan admin secrets delete <scope>.<key>       # hard delete
eidan admin secrets audit --tail               # follow the audit table
```

### 9.2 Admin UI

The settings page under `/settings/integrations` lists each plugin
with declared `vault:` keys and their `<set>` / `<unset>` state.
Linking flows (Gmail "Connect" button, etc.) write through the
same plugin code path; the UI never holds a plaintext.

### 9.3 First-time provisioning

On first boot the operator MUST set `EIDAN_AUTH_MASTER_KEY` in
`.env`. Without it:

- The lifespan fails fast with an actionable error pointing at the
  generation command (`python -c "import secrets; print(secrets.token_urlsafe(48))"`).
- No request can be served — the middleware refuses with
  `auth.invalid_signature` because there is no keypair to verify
  against.

---

## 10. Master-key rotation

There is no online master-key rotation. The procedure:

1. Generate a new master key.
2. Stop every backend instance.
3. In `psql`:
   ```sql
   DELETE FROM eidan.auth_keypair;
   DELETE FROM eidan.auth_mfa_totp;
   DELETE FROM eidan.secrets_vault;
   ```
4. Set the new `EIDAN_AUTH_MASTER_KEY` in `.env`.
5. Restart. The lifespan re-mints the keypair; the operator re-seeds
   plugin secrets via the admin UI.

Surviving the rotation without losing data is a roadmap item — it
needs a key-version column on every encrypted table and a re-seal
job. Single-operator installs accept the manual procedure today.

---

## 11. Error responses

| Code                    | HTTP | When                                                      |
|-------------------------|-----:|-----------------------------------------------------------|
| `secret.not_found`      | 404  | `read` against a missing or expired row.                  |
| `secret.scope_denied`   | 403  | Plugin attempted to address a scope outside its own slug. |
| `secret.master_missing` | 500  | `EIDAN_AUTH_MASTER_KEY` unset at boot.                    |
| `secret.decrypt_failed` | 500  | Fernet decryption raised — likely a master-key mismatch.  |

The envelope shape is the standard `{error: {code, message, request_id}}`
from `011 §10.1`.

---

## 12. Observability

Every secret access logs a single line at INFO with the
`request_id`, actor, scope, key, and outcome — never the value:

```
[secrets] read   actor=plugin_gmail key=plugin_gmail.oauth.refresh_token outcome=ok
[secrets] write  actor=plugin_gmail key=plugin_gmail.oauth.access_token   outcome=ok ttl=3600
[secrets] denied actor=plugin_gmail key=plugin_other.api_key              outcome=denied
```

`eidan admin secrets audit --tail` queries `eidan.secrets_audit` and
formats it identically so an operator can correlate.

---

## 13. Reserved for later specs

- Online master-key rotation (key-version column + re-seal job).
- HSM-backed master key.
- Per-secret per-plugin ACL beyond the manifest-declared keys.
- Hardware token / passkey storage.
