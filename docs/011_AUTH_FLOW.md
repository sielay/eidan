# 011 — Native auth flow

Status: Draft (2026-05-21 — replaces the Supabase-Auth-pinned earlier
revision)

Owner: Core

Related: [ARCHITECTURE](./ARCHITECTURE.md), [PLUGINS](./001_PLUGINS.md)
(§1 manifest env/vault, §2.2 PluginContext), [MIGRATIONS](./002_MIGRATIONS.md),
[MEMORY DDL](./003_MEMORY_DDL.md) (§9 `eidan.users`),
[AGENTIC LOOP](./005_AGENTIC_LOOP.md) (§4 `TurnContext`),
[COST BUDGETING](./010_COST_BUDGETING.md) (§4.7 per-turn budgets),
[SECRETS](./012_SECRETS.md).

Eidan ships **its own identity layer**. There is no Supabase project,
no GoTrue, no remote auth call on the hot path. The host:

- accepts a magic-link email from the operator,
- issues a short-lived **RS256** access JWT signed by a keypair stored
  encrypted in Postgres,
- carries a long-lived **opaque refresh token** in an httpOnly cookie,
- enforces a single-operator allowlist via `EIDAN_AUTH_ALLOWED_EMAIL`.

The whole subsystem is implementable in pure Python + Postgres so a
single-machine install needs nothing else. Multi-instance deployments
share the keypair and the session/vault tables transparently because
they all live in Postgres.

Out of scope:

- OAuth (Google / GitHub) sign-in. The provider interface in §9 is the
  extension point; only magic-link ships today.
- Account recovery for a lost master key. Operator runbook in
  [SECRETS](./012_SECRETS.md) §6.
- Multi-tenant identity. Core is single-operator; multi-user RLS lives
  in the universal paid baseline bundle ([018](./018_DISTRIBUTION_AND_BUNDLES.md) §3).

---

## 1. Vocabulary

| Term                  | Meaning                                                                                                              |
|-----------------------|----------------------------------------------------------------------------------------------------------------------|
| **Magic-link token**  | A 256-bit URL-safe opaque token mailed to the operator. Single-use, 15-min TTL. Stored in `eidan.auth_magic_links`. |
| **Magic-link code**   | A 6-digit numeric code paired with the token, for paste-back flows where the click-through URL is awkward.          |
| **Access token**      | An **RS256-signed JWT**, 24 h TTL by default. The backend verifies it on every request. See §5.                     |
| **Refresh token**     | A 256-bit opaque token kept in `eidan.auth_sessions`. The browser holds it as an httpOnly cookie scoped to `/api/auth/refresh`. |
| **Keypair**           | A single RS256 keypair stored in `eidan.auth_keypair`; the private PEM is sealed with the master key. See §5.2.     |
| **Master key**        | `EIDAN_AUTH_MASTER_KEY`, an env var. HKDF-derives a Fernet key used to seal the keypair, MFA secrets, and the vault. |
| **Allowlist**         | `EIDAN_AUTH_ALLOWED_EMAIL`, an env var. The only email the magic-link endpoint will mint a link for.                |
| **Session**           | A row in `eidan.auth_sessions` carrying the refresh token, the user id, and the device fingerprint.                 |
| **`eidan.users`**     | Core's user table. Rows are created idempotently the first time a magic link is consumed for a given email.         |
| **Identity context**  | The `Identity` dataclass attached to `request.state.identity` after verification.                                   |

---

## 2. Authority model

There is one rule and three boundaries.

**The rule.** Eidan itself is the only issuer of identity. The host
mints and verifies its own tokens against an RS256 keypair it owns.
Plugins never mint identity tokens.

**The three boundaries:**

1. **Browser ↔ Eidan auth endpoints.** Unauthenticated requests to
   `/api/auth/magic-link` and `/api/auth/verify` exchange an email for
   a JWT pair. See §3.
2. **Browser ↔ Eidan resource surface.** Every other request carries
   the access JWT in `Authorization: Bearer <jwt>`. See §4.
3. **Backend ↔ Postgres.** The backend holds the keypair + session
   + vault rows in `eidan.*` and connects as a single Postgres role
   (`eidan_app` in production). See [012](./012_SECRETS.md) §2.

```
                  email                  magic link
              ┌────────────────────┐    ┌────────────────────┐
              │ /api/auth/magic-link│ → │ /api/auth/verify    │
              └────────────────────┘    └─────────┬──────────┘
                                                   │ access JWT (24h)
                                                   │ refresh cookie (30d)
                                                   ▼
┌──────────┐  Authorization: Bearer  ┌────────────────────────┐
│ Browser  │ ──────────────────────▶ │ Eidan backend (FastAPI) │
│ (Next.js)│ ◀────────────────────── │ verifies via cached     │
└──────────┘  401 / 403 envelopes    │ public PEM              │
                                     └─────────────┬──────────┘
                                                   │ SET LOCAL
                                                   ▼
                                            ┌─────────────┐
                                            │ Postgres    │
                                            │ eidan.*     │
                                            └─────────────┘
```

This split means a backend restart, scale-out, or region migration
does not invalidate sessions — the keypair and the sessions are in
Postgres, so all instances see the same state.

---

## 3. Login flow

### 3.1 `POST /api/auth/magic-link`

Body:

```json
{ "email": "operator@example.com" }
```

Behaviour:

1. The handler reads `EIDAN_AUTH_ALLOWED_EMAIL` and compares
   case-insensitively. **Refuse-by-default**: an unset env var means
   no email is allowed.
2. On allow, it generates a 256-bit URL-safe token + a 6-digit
   code, writes them to `eidan.auth_magic_links` with a 15-minute
   expiry, and dispatches the email via SMTP (`EIDAN_SMTP_*` env
   vars). In dev (`EIDAN_DEPLOYMENT_MODE != production`) the link is
   also echoed back on the response body so the operator can click
   without SMTP.
3. The response is **always** `{"status": "sent"}` — same shape and
   timing regardless of whether the email was allowed, rejected, or
   already pending. The host does not surface allow/deny decisions
   to the caller (cf. RFC 7235 §3.1 enumeration concerns).

### 3.2 `POST /api/auth/verify`

Body: exactly one of `token` or `code`:

```json
{ "token": "QYx…hZQ" }
{ "code":  "418236" }
```

Behaviour:

1. Atomic `UPDATE…RETURNING` on `eidan.auth_magic_links` marks the
   row consumed (single-use). Expired or already-consumed rows raise
   typed errors mapped to 404 / 410.
2. Idempotent insert into `eidan.users` keyed on the email. The row's
   `id` is the JWT `sub` claim from this point forward.
3. Insert into `eidan.auth_sessions` carrying the refresh token's
   sha256 fingerprint, the user agent, and the client IP.
4. Mint an RS256 access JWT against the keypair from §5.2.
5. Return the access token + user envelope; set the refresh token as
   an httpOnly cookie scoped to `/api/auth/refresh`, `Secure` when
   `EIDAN_DEPLOYMENT_MODE=production`, `SameSite=Lax`.

Response:

```json
{
  "access_token": "<rs256-jwt>",
  "token_type":   "bearer",
  "expires_in":   86400,
  "user": { "id": "<uuid>", "email": "operator@example.com" }
}
```

### 3.3 `POST /api/auth/refresh`

Browser sends nothing in the body; the cookie carries the refresh
token. The handler:

1. Looks the session up by the cookie's sha256 fingerprint.
2. Rejects revoked or expired sessions with 401.
3. Touches `last_used_at` on the session.
4. Mints a fresh access JWT (the refresh token itself does **not**
   rotate today — see §5.4).

### 3.4 `POST /api/auth/logout`

Revokes the session matching the refresh cookie, deletes the cookie,
returns 204. Idempotent.

### 3.5 `GET /api/auth/config` (public)

Surfaces:

```json
{
  "provider":      "native",
  "providers":     ["magic_link"],
  "allowed_email": "operator@example.com",
  "tos_url":       null,
  "privacy_url":   null
}
```

The web UI pre-fills the email field with `allowed_email`. The
endpoint is unauthenticated; the value is intentionally non-secret
(a single-operator instance leaks one email at most).

---

## 4. Backend request lifecycle

`AuthMiddleware` (`apps/backend/eidan_backend/http/auth.py`) runs on
every request. It:

1. Pins / propagates `X-Request-Id` onto `request.state.request_id`.
2. Bypasses auth for paths in `UNAUTHENTICATED_PATHS` (the four
   `/api/auth/*` endpoints + `/api/healthz` + `/api/readyz` +
   `/api/version` + `/api/auth/config`) and the `/api/webhooks/`
   prefix (plugins verify their own inbound signatures).
3. Extracts the bearer token from `Authorization: Bearer <jwt>`.
4. Verifies the JWT via `verify_access_token(token, public_pem=…)`
   against the public PEM cached on `app.state.auth_public_pem`.
5. Stashes the resulting `Identity` on `request.state.identity` and
   echoes `X-Request-Id` on the response.

Failures map to the typed 401 / 403 envelope in §10.

### 4.1 The `Identity` dataclass

```python
@dataclass(frozen=True, slots=True)
class Identity:
    user_id:     str         # JWT sub
    email:       str | None  # JWT email
    session_id:  str | None  # JWT sid
    aal:         str         # "aal1" (no MFA) or "aal2" (MFA active)
    raw_claims:  dict[str, Any]
```

The shape is unchanged from the previous spec; downstream code (loop,
persistence, tools) consumes the same surface.

`Identity.synthetic_for_agent(...)` (`identity.py`) is the same
escape hatch for agent-initiated turns that don't carry an inbound
JWT (cron, behaviours, the sentry plugin). `aal` is `"agent"` for
those; route handlers can branch on it.

---

## 5. Token issuance and verification

### 5.1 Algorithm

RS256. The keypair is 4096-bit RSA. The chosen library is
`python-jose` (which is already in the dependency tree for the
provider clients).

Claim shape:

| Claim   | Source                                            |
|---------|---------------------------------------------------|
| `iss`   | `"eidan"` (constant)                              |
| `aud`   | `"eidan"` (constant)                              |
| `sub`   | `eidan.users.id` (uuid as string)                 |
| `email` | `eidan.users.email`                                |
| `sid`   | `eidan.auth_sessions.id` (uuid)                   |
| `iat`   | unix epoch seconds                                |
| `exp`   | `iat + ACCESS_TOKEN_TTL_MINUTES * 60` (default 24 h) |

### 5.2 Keypair storage

`eidan.auth_keypair` is a singleton (`id = 'current'`) with two
columns:

- `public_pem`: plaintext PEM bytes — the verifier reads this on every
  cold start and caches it on `app.state.auth_public_pem`.
- `private_pem_enc`: Fernet-sealed PEM bytes — sealed with the key
  derived from `EIDAN_AUTH_MASTER_KEY` via HKDF-SHA256.

On boot, `ensure_keypair(conn)` does an upsert: if no row exists, it
mints a fresh RSA-4096 keypair, encrypts the private side, and
`INSERT ON CONFLICT DO NOTHING`s. Concurrent boots converge — only
the first wins, the rest read the existing row. The PEMs land on
`app.state.auth_{public,private}_pem` for the lifetime of the
process.

### 5.3 Rotation

There are two flavours:

- **Restart-style rotation** (recommended for the single-operator
  case): the operator deletes the row in `eidan.auth_keypair`, kills
  every running instance, and starts fresh. All previously issued
  access tokens become invalid; refresh-cookie holders re-mint by
  hitting `/api/auth/refresh` (the refresh token doesn't carry the
  signing kid, so it survives).
- **Online rotation**: not supported today. The keypair table has
  no `kid` column on purpose — adding one is the natural extension
  point if/when online rotation matters.

### 5.4 Refresh tokens

`eidan.auth_sessions` is the source of truth. Each row carries:

- `refresh_sha256` — sha256 of the raw refresh token (the raw value
  is never stored).
- `user_id` — FK to `eidan.users(id)`.
- `user_agent`, `ip_address` — for forensics; never validated.
- `expires_at` — `inserted_at + REFRESH_TOKEN_TTL_DAYS * 24h`
  (default 30 days).
- `revoked_at` — `NULL` when active. A partial index on this column
  keeps the active-session query fast.

Refresh tokens do **not** rotate on use today. Adding rotation is the
right move when we add IP/UA fingerprinting and want replay
protection against a stolen cookie; the wiring lives in the verify
handler, not the model.

---

## 6. `eidan.users` provisioning

`ensure_user_by_email(conn, email=…)` does an idempotent
`INSERT ON CONFLICT (email) DO NOTHING`. The `id` returned is the
JWT `sub` from that point on.

Existing code that takes a `(user_id, email)` pair to upsert via
`persistence.upsert_user` still works — it's keyed on the id and
keeps the `updated_at` trigger honest on subsequent re-asserts.

---

## 7. Plugin access to identity

`PluginContext.identity` returns the `Identity` for the current
turn. Plugin tool handlers (which don't get the request object) read
`get_current_identity()` from `eidan_backend.identity` instead — the
contextvar is set by the agent loop right before dispatch, with a
matching `reset` in the `try/finally` block (`005 §4`).

The plugin authority surface is unchanged by the auth subsystem
swap. Plugins that need a user-scoped database connection still go
through `db.acquire(pool, identity)` — the session-variables-on-
connect plumbing in `002 §5.2` reads `identity.user_id` and is
agnostic to where the identity came from.

---

## 8. MFA (TOTP scaffold)

`eidan.auth_mfa_totp` carries one row per user when MFA is enabled.
The secret is sealed with the master key. The scaffold ships these
helpers in `auth_native/mfa.py`:

- `enrol_totp(conn, user_id) → otpauth URI + qr-friendly secret`
- `verify_and_activate_totp(conn, user_id, code)`
- `verify_totp_for_login(conn, user_id, code)`
- `is_totp_required(conn, user_id)`
- `disable_totp(conn, user_id)`

The verify endpoint does **not** challenge for TOTP today. The
scaffold lights up the `aal` claim (`"aal1"` → `"aal2"` on a
successful TOTP step-up) but the UI doesn't surface the second
factor yet. The wiring lives in the verify handler so the rest of
the surface is unchanged.

---

## 9. Provider interface

`auth_native/providers.py` defines:

```python
class AuthProvider(Protocol):
    name: str
    async def initiate(self, **kw)        -> InitiateResult
    async def verify(self, **kw)          -> VerifyResult
```

Magic-link is the only concrete implementation in core. OAuth
sign-in (Google / GitHub) is the natural second; it lands as a
new `AuthProvider` registered against the same interface, with
the same `/api/auth/initiate/<provider>` + `/api/auth/verify`
shape. The keypair, sessions, and `eidan.users` provisioning are
unchanged.

---

## 10. Error responses

### 10.1 Envelope

```json
{
  "error": {
    "code":       "auth.invalid_signature",
    "message":    "human-readable explanation",
    "request_id": "<uuid>",
    "details":    { /* optional */ }
  }
}
```

`request_id` matches the `X-Request-Id` response header the
middleware echoes.

### 10.2 Codes and status

| Code                       | HTTP | When                                                        |
|----------------------------|-----:|-------------------------------------------------------------|
| `auth.missing_token`       | 401  | No `Authorization` header on a protected path.              |
| `auth.malformed_token`     | 401  | Header present but not `Bearer <jwt>` or JWT is unparseable.|
| `auth.invalid_signature`   | 401  | Signature check fails against the cached public PEM.        |
| `auth.token_expired`       | 401  | `exp` is in the past.                                       |
| `auth.invalid_claims`      | 401  | `iss`, `aud`, or `sub` claim missing or wrong.              |
| `auth.session_revoked`     | 401  | Refresh path: `revoked_at` set on the matching session.     |
| `auth.session_expired`     | 401  | Refresh path: `expires_at` < now.                           |
| `auth.user_disabled`       | 403  | Authenticated but the user row carries `disabled_at`.       |
| `auth.plugin_scope_denied` | 403  | Plugin RBAC refuses the call (paid baseline only).          |

401 responses carry an RFC 6750 `WWW-Authenticate` header. 403
responses **do not** — refresh fixes 401, never 403; the client
must not loop on the latter.

---

## 11. Observability

Every authenticated request carries a `request_id` end to end:

- Middleware mints / honours `X-Request-Id`.
- It lands on `request.state.request_id` for handlers.
- The error envelope embeds it under `error.request_id` so a
  user-reported error can be traced.
- The response always echoes `X-Request-Id`.

The native auth surfaces log at INFO:

```
[auth] magic-link request email=<email>
[auth-config] served request_id=<id> elapsed_ms=<ms>
```

Refused magic-link requests log at WARN (cap'd to one line per
attempt — no payload):

```
[auth] magic-link refused (not in allow-list): email=<email>
```

---

## 12. Multi-instance notes

Every state the auth subsystem reads or writes lives in Postgres:

| State            | Table                       | Single source of truth? |
|------------------|-----------------------------|-------------------------|
| Keypair          | `eidan.auth_keypair`        | yes                     |
| Sessions         | `eidan.auth_sessions`       | yes                     |
| Magic links      | `eidan.auth_magic_links`    | yes                     |
| MFA secrets      | `eidan.auth_mfa_totp`       | yes                     |
| Vault entries    | `eidan.secrets_vault`       | yes                     |
| Allowlist email  | `EIDAN_AUTH_ALLOWED_EMAIL`  | env (operator pin)      |
| Master key       | `EIDAN_AUTH_MASTER_KEY`     | env (operator secret)   |

A second instance booting against the same Postgres reads the same
keypair and verifies tokens identically. No file-system state, no
JWKS round-trip, no per-instance secret. Adding instances is purely
a deploy-time concern.

---

## 13. Reserved for later specs

- OAuth provider implementations (Google / GitHub).
- TOTP step-up on the verify path.
- Refresh-token rotation + replay protection.
- Account-deletion / audit retention.
- Multi-user RLS — lives in the universal paid baseline bundle.
