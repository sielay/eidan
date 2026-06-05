# Roadmap — parked features

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

## Cost: recomputable pricing + finer budget scopes

**State today.** `docs/010_COST_BUDGETING.md` is the graduated
spec: core captures tokens + `cost_usd` on `llm_calls` and enforces
per-turn / per-conversation / per-day / per-user / per-agent caps
pre-call. Three follow-ups surfaced while reviewing the cost path:

- **Unpriced model silently prices at $0.** The code returns
  `cost_usd = 0` when a model id is missing from the price table,
  with no log — diverging from `010 §3.3`, which says raise and
  surface the misconfiguration. Tracked in
  [#203](https://github.com/sielay/eidan/issues/203). Near-term
  bug, not parked.
- **Recomputable cost from an effective-dated price table.**
  `010` freezes `cost_usd` on the row, so a stale/wrong price can
  never be corrected and a price change can't be back-applied.
  Evaluate a bitemporal (`effective_from` + `recorded_at`) price
  table with cost as a derived/recomputable value — freeze for
  billing, recompute for analysis. Design issue
  [#204](https://github.com/sielay/eidan/issues/204).
- **Per-node & per-model budget scopes + throttle-to-cheaper-model.**
  `010 §4` lacks per-node / per-model scopes, and the cap is a
  cliff (soft wrap-up → hard deny). Add a `downgrade` tier that
  biases the sizer toward cheaper models before denying. Design
  issue [#205](https://github.com/sielay/eidan/issues/205).

**Why parked (the design pair).** #204 and #205 revise a graduated
spec; they wait on a design delta to `010` before any code. #203 is
a straight bug and ships independently.

**Shape when we get to it.** Both #204 and #205 land first as a new
section in `docs/010`, then implementation. The richer pricing
maintenance and budget *policy* (how a price is sourced, which model
to downgrade to) is a paid-plugin consumer of these core seams —
the same core-capture / paid-consumer split `010 §7` already draws
for analytics.

## (graduated) Deploy: bake-at-build

Shipped — see `docs/DEPLOYMENT.md`. Plugins are baked into the
image at build time on the operator's laptop; no runtime install
step, no writable plugin volume, no PAT on the remote machine.

**Code rule.** Anything depending on the absolute in-image path
`/app/plugins` is forbidden. Read the plugin root through
`_resolve_plugins_dir` (backend) or `admin.PLUGINS_DIR` (CLI) so
operators iterating locally with `EIDAN_PLUGINS_DIR` set to a
scratch dir get the same resolution everywhere.
