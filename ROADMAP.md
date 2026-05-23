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

## Deploy: published image + runtime plugin install

**State today.** `docs/DEPLOYMENT.md §4` ships a deploy story that
needs zero in-repo edits and zero fork — operators clone upstream,
copy `infra/fly/fly.toml.example` somewhere they own, and run
`fly deploy --dockerfile infra/fly/Dockerfile`. Paid bundles are
installed **at image-build time** via `EIDAN_BUNDLES` +
`EIDAN_PLUGIN_SOURCE` build args + a `github_token` build secret,
which calls the existing `eidan plugin install` CLI inside the
build sandbox. The runtime resolves the plugin discovery root
through `EIDAN_PLUGINS_DIR` (`apps/backend/eidan_backend/http/app.py`,
`apps/cli/eidan_cli/admin.py`), so a baked image can point at a
mounted volume without code changes.

**Why parked.** The current story still requires `flyctl` to build
locally, and it requires a redeploy to swap which bundles are
installed. Both are acceptable trade-offs for a single-operator
shape today; both stop being acceptable once there are real
release cadence pressures or multi-operator installs.

**Shape when we get to it.**

- **Published image on GHCR.** A tagged release publishes
  `ghcr.io/sielay/eidan:vX.Y.Z` so operators can
  `fly launch --image ghcr.io/sielay/eidan:vX.Y.Z` (or the k8s /
  Compose equivalent) without ever building locally. The
  publishing pipeline lives in the landing repo, not here, so
  this repo stays free of CI that talks to anyone's registry.
- **Runtime plugin install to a Fly volume.** Mount a writable
  volume at `/var/lib/eidan/plugins`, set
  `EIDAN_PLUGINS_DIR=/var/lib/eidan/plugins`, and let
  `eidan admin plugin install` execute against the live machine
  via `fly ssh console`. Bundle swaps become a one-liner; no
  rebuild, no redeploy. Needs a Fly-specific volume migration
  pattern (machines that already booted with the image-baked
  `./plugins` keep working until the next restart).
- **Bundle lock file.** `EIDAN_BUNDLES` is freeform today;
  Phase 3 wants a `plugins/.lock` manifest so an
  `eidan admin plugin sync` command can reconcile the live tree
  with the declared set, deterministically.

**Code rule until then.** Anything depending on the absolute
in-image path `/app/plugins` is forbidden. Read the plugin root
through `_resolve_plugins_dir` (backend) or `admin.PLUGINS_DIR`
(CLI) so the Fly-volume case lands cleanly when the runtime
install path ships. The build-time bundle install in
`infra/fly/Dockerfile` is allowed to assume the image-baked path
because the runtime override is a strict superset of that
behaviour.
