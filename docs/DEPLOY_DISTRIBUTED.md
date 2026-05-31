# Distributed deployment

A multi-node shape: Fly handles latency-sensitive HTTP, the Pi runs
the always-on workload (behaviour dispatcher, Sentry), Vercel
serves the UI, Supabase (or any shared Postgres) holds state.
Postgres advisory locks coordinate leader-only work — whichever
instance grabs the lock first owns it.

This builds on the two single-host bootstrap recipes:

- [DEPLOY_PI_BOOTSTRAP](./DEPLOY_PI_BOOTSTRAP.md) — one-time Pi setup
- [DEPLOY_FLY_BOOTSTRAP](./DEPLOY_FLY_BOOTSTRAP.md) — one-time Fly setup

Estimated cost: Fly ~$5/mo + Supabase free tier (or ~$25 if you
outgrow it) + Vercel free + Pi sunk cost = ~$5–30/mo all-in.

## Topology

Both nodes live in one `topology.yml`. Shared bits (master key, DB
URL) go in `defaults:` so they're guaranteed byte-identical across
nodes:

```yaml
schema: 1

defaults:
  auth_master_key: !vault | ...               # SAME value on every node
  auth_allowed_email: you@yourdomain.com
  database_url: !vault | ...                  # SAME Supabase URL on every node
  image: ghcr.io/sielay/eidan:v0.1.0
  plugin_source: gh:sielay
  github_token: !vault | ...

nodes:
  fly-prod:
    target: fly
    app: eidan-api
    region: lhr
    provider:
      name: anthropic
      default_model: claude-sonnet-4-6
      api_key: !vault | ...
    # sentry.enabled defaults to false on Fly — the Pi runs the tick

  kasha:
    target: pi
    host: 192.168.1.100
    ssh_user: pi
    http_host: 127.0.0.1            # Pi doesn't serve public HTTP
    provider:
      name: ollama
      default_model: phi3
    sentry: { enabled: true, model: phi3 }
```

`eidan deploy` (with no `--node`) reconciles both in sequence.

## Bootstrap order

1. **Supabase Postgres** — follow
   [DEPLOY_PI_BOOTSTRAP §4 Option B](./DEPLOY_PI_BOOTSTRAP.md#option-b--supabase-postgres).
   The same `database_url:` is shared across nodes.
2. **Pi** — follow [DEPLOY_PI_BOOTSTRAP](./DEPLOY_PI_BOOTSTRAP.md)
   but skip the local Postgres step and point at Supabase. Run
   initial migrations from the Pi.
3. **Fly app** — follow
   [DEPLOY_FLY_BOOTSTRAP §1 + §3](./DEPLOY_FLY_BOOTSTRAP.md) (create
   the app, set up the custom domain). Skip the Postgres step —
   Fly uses the same Supabase URL.
4. **Vercel frontend** — see
   [DEPLOY_FRONTEND](./DEPLOY_FRONTEND.md). Point
   `NEXT_PUBLIC_EIDAN_BACKEND_URL` at the Fly app's custom domain
   (not the Pi).

After bootstrap, `eidan deploy` reconciles everything.

## Leader-election sanity check

After both backends are up, the dispatcher's advisory lock should
land on exactly one node. Tail both:

```bash
# Pi
sudo journalctl -u eidan-backend -f | grep dispatcher

# Fly
fly logs -a eidan-api | grep dispatcher
```

The Pi should print `behaviour dispatcher started with N cron
job(s)`. The Fly machine should print `another instance owns the
dispatcher lock`. If both claim ownership you have a Postgres
configuration problem (two databases instead of one) — stop and
diagnose before continuing.

## End-to-end smoke

From a clean browser:

1. `https://app.yourdomain.com` → click sign-in.
2. Magic link arrives in email → click → land on the conversation
   list.
3. New conversation → "what is the time in London?" → SSE stream
   produces `chunk` frames, no `[interrupted]`. (This call goes
   through Fly → Anthropic; the Pi's Ollama is idle for foreground
   work.)
4. Wait 5–10 minutes, then `journalctl -u eidan-backend` on the Pi
   → Sentry tick rows visible.
