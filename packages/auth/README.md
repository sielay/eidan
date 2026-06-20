# @eidandev/auth

eidan's **engine-side identity seam** — a matbot `WebPrincipalResolver` that
derives the per-request `Principal` from a `Bearer` JWT. Sign-in itself lives
in the Next.js app (NextAuth or equivalent, which mints the token); the engine
only **verifies**. This is the plugin that turns an HTTP request on the AG-UI
front door into the ambient `Principal` every downstream tool, store write, and
RLS query is scoped to.

It registers no agent tools. It registers one service.

## Exposes

- **`WebPrincipalResolver` service** — `(req: IncomingMessage) => Principal`.
  Reads the `Authorization: Bearer <jwt>` header, verifies the token (HS256,
  shared secret), and returns `{ id: claims.sub, type: 'user' }`. A missing or
  invalid token throws `UnauthorizedError` → the caller answers `401`.
- Same service key matbot's `frontend-web` and `@eidandev/frontend-agui`
  consume. If this plugin doesn't register (no secret configured), the AG-UI
  server falls back to the boot principal only when explicitly opted in
  (`EIDAN_DEV_AUTH=1` / `EIDAN_ALLOW_BOOT_PRINCIPAL=1`); otherwise it fails
  closed with `401`.

## How consumed

`@eidandev/frontend-agui`'s server resolves `services.WebPrincipalResolver` per
request and runs the rest of the turn under `runAs(principal, …)`. The Telegram
link endpoint resolves it the same way. The resolver is authoritative: a throw
is a hard `401`, never a silent downgrade to another identity.

## Example

The Next app signs an HS256 JWT (`{ sub: <user-uuid>, exp }`) with the shared
secret and sends it as `Authorization: Bearer …`. On each engine request the
resolver verifies the signature + expiry and yields the user's `Principal`; the
turn then reads and writes memory as that user.

## Layout

- `src/index.ts` — the `MatbotPluginSpec`; reads the shared secret and
  registers the `WebPrincipalResolver`. Defines `UnauthorizedError`.
- `src/jwt.ts` — `verifyHs256(token, secret)`: dependency-free HS256 verify
  (constant-time compare, `exp` check). Returns the claims or `null`.

## Config

- `EIDAN_AUTH_JWT_SECRET` (falls back to `EIDAN_AUTH_MASTER_KEY`) — the HS256
  shared secret. **Absent ⇒ the resolver is NOT registered** (a warning is
  logged and the boot principal stays in effect). The Next app must mint tokens
  with the same secret.
