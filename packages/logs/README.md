# @eidandev/logs

The **logs** plugin for the eidan-sage coding bundle. Lets the agent read deployment and app logs
from the operator's named sources. **Vercel**, **Fly**, **Heroku** and **Better Stack** ship first;
more platforms are a drop-in provider module away.

## Tools

| Tool | What it does |
|------|--------------|
| `logs_list_sources` | List the registered sources (name, provider). No tokens. |
| `logs_read` | Pull recent log lines from a source (`limit` / `since` / `query`), newest-first. |

## Sources & secrets

Sources are registered per-user in **Integrations → Logs**. The provider plus its non-secret config
(project/app/team/query endpoint) live in `plugin_logs.sources`; **only the API token is sealed in
the vault** under `EIDAN_LOG_TOKEN_<slug>`. The admin route seals it via the engine secrets-api (the
LLM-free write path), and tools resolve it at call time. A token is never sent to a model.

### Per-provider config (the non-secret `config` JSON)

| Provider | Required | Optional | Notes |
|----------|----------|----------|-------|
| `vercel` | `project_id` | `team_id`, `base_url` | Reads the latest deployment's events. Token = a Vercel API token. |
| `heroku` | `app` | `source`, `dyno`, `base_url` | Platform API log-session → logplex pull. Token = a Heroku API key. |
| `betterstack` | `query_url`, `table` | `ts_column` (`dt`), `message_column` (`raw`), `username`, `base_url` | ClickHouse query API. Token = the query password (Basic auth when `username` set, else Bearer). |
| `fly` | `base_url` | `app` | Fly has **no first-party HTTP log-pull** — point `base_url` at a Fly log drain/aggregator, or route Fly logs into Better Stack and use a `betterstack` source instead. |

## Config

- `EIDAN_DATABASE_URL` (or `DATABASE_URL`) — the eidan control-plane DB, where the `plugin_logs`
  registry table lives.

## Schema

`sql/0001_logs.sql` mirrors the idempotent `ensureSchema()` in `src/registry.ts` for the
`@eidandev/migrate` deploy path. Keep the two in sync.

## Gate

`pnpm -C packages/logs typecheck` (strict tsc) + `node --import tsx packages/logs/smoke.test.mts`.
