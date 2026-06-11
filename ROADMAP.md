# Roadmap — parked & in-flight

Things we want, roughly in priority order, that aren't fully built yet. The point of this file is to
keep the codebase from accreting half-finished abstractions for features that haven't been designed —
and to record where the deliberate seams are so the follow-on work slots in without a refactor.

Core has migrated onto the [matbot](https://github.com/MatAtBread/matbot) runtime (from an earlier
Python/FastAPI stack). The engine, the interop surfaces, the deployable host image, and the bundle
substrate are in place; the items below are the known gaps.

## Auth: real magic-link + pluggable identity

**State today.** Per-request identity is a JWT `WebPrincipalResolver` (`@eidandev/auth`, HS256 shared
secret) — the engine *verifies*; sign-in lives in the Next app. For local development the engine also
serves a dev-only `/api/auth/*` shim (gated by `EIDAN_DEV_AUTH=1`) that mints tokens directly.

**Shape when we get to it.**
- Real magic-link email sign-in (the `eidan.auth_*` tables exist) replacing the dev shim — request →
  email a one-time link/code → verify → session + refresh cookie.
- An `EIDAN_AUTH_PROVIDER` seam for offline/Pi installs (a single-operator pin) and a generic OIDC
  path (`issuer` / `jwks_url` / `audience` from env), validated the same way as the HS256 path.

**Code rule until then.** Sign-in logic stays in the Next app / the `auth` plugin; the rest of the
engine only ever sees a resolved `Principal`. Don't thread identity by hand — it's ambient.

## Cost: recomputable pricing + budget scopes

**State today.** `@eidandev/llm-calls` captures tokens (input/output/cache) per call on
`eidan.llm_calls`. `cost_usd` is recorded but currently `0` — there's no price table yet, so the
dashboards show real token counts and `$0`.

**Shape when we get to it.**
- A price table keyed by model + an effective date; compute `cost_usd` at record time, and keep it
  **recomputable** for analysis (freeze for billing, recompute for reporting) rather than a frozen
  literal that a price correction can never fix.
- Per-turn / per-conversation / per-day / per-user budget scopes with a `downgrade` tier (bias the
  sizer toward a cheaper model before a hard deny), not just a cliff.

## Bundles: the full Sage loop + the other bundles

**State today.** The bundle substrate is proven: a bundle is a vendored matbot plugin that registers
a kind handler on the `@eidandev/jobs` work-queue via the string-keyed service registry. Sage v0
registers a `'code'` handler that runs the goal as an agent turn end-to-end.

**Shape when we get to it.**
- **Sage** — the full coding loop: clone the repo from the job payload, drive Claude Code, run a
  pre-PR critic, open the PR, iterate against CI/Copilot. (v0 is the agent-turn stand-in.)
- **Pro** (calendar / IMAP / Gmail / mail-send / Slack) — port its plugins to the matbot shape; they
  load like any plugin and route notifications through `@eidandev/notify`.
- **Charles / Charlotte** (business / lifestyle) — greenfield, still in design.

## Interop: A2A outbound

**State today.** Inbound is done — `@eidandev/mcp-server` (MCP), `@eidandev/frontend-agui` (AG-UI),
`@eidandev/a2a-server` (A2A agent card + `message/send`). matbot ships an MCP *client* (tools out).

**Shape when we get to it.** An A2A *outbound* client plugin so eidan can consume remote agents as
tools, completing the symmetry (in *and* out on all three protocols).
