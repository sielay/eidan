# Roadmap — parked features !!!!!

Things we want, in priority order, but are not building yet. The goal
of this file is to keep the current codebase from accreting
half-finished abstractions for features that have not yet been
designed.

When something here is ready to be built, it graduates to a numbered
spec under `docs/` and gets removed from this file.

## Auth: pluggable JWT/OAuth providers

**State today.** Phase 1 ships Supabase Auth as the only supported
identity backend. The config layer leaves the door open — see
`AuthSettings.provider: Literal["supabase", "authjs", "vercel"]` in
`apps/backend/eidan_backend/config.py` — but only the `supabase`
branch is wired up. JWKS validation is provider-agnostic by design
(any `/.well-known/jwks.json` will do), so the coupling is
operational rather than architectural.

**Why parked.** Single-operator Phase 1 doesn't need it. Adding a
second provider before we have a real second-provider need would
create surface we'd have to maintain through every refactor.

**Shape when we get to it.**
- An `EIDAN_AUTH_PROVIDER=none` escape hatch for offline / Pi
  installs where Supabase is overkill. Loop runs against the
  single-operator pin from `docs/011_AUTH_FLOW.md`.
- A generic OIDC provider (`EIDAN_AUTH_PROVIDER=oidc`) that takes
  `issuer`, `jwks_url`, and `audience` from env and validates JWTs
  the same way Supabase tokens are validated today.
- Auth.js / Vercel paths flesh out the existing Literal branches.

**Code rule until then.** New code in `apps/backend` MUST NOT
import `supabase` SDK symbols outside the auth and login
modules. JWT validation goes through the JWKS abstraction, not
through Supabase-specific helpers. Adding fields to
`SupabaseSettings` is fine; reaching into Supabase from the
agent loop, persistence, or plugin contract is not.
