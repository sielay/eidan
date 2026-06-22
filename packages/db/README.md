# @eidandev/db

The **databases** plugin for the eidan-sage coding bundle. Gives the agent read/write access to the
operator's named databases. **Postgres** and **MongoDB** ship first; more engines are a drop-in
driver module away.

## Tools

| Tool | What it does |
|------|--------------|
| `db_list_connections` | List the registered connections (name, driver, host, database). No secrets. |
| `db_inspect` | List a connection's tables (Postgres) or collections (MongoDB). |
| `db_query` | Run SQL against a Postgres connection — full read/write. `$1/$2` params supported. |
| `db_mongo` | Run a MongoDB command document via `db.command()` — full read/write. |

## Connections & secrets

Connections are registered per-user in **Integrations → Databases**. The non-secret coordinates
(driver, host, port, database, username, and a free-form `options` JSON for `ssl`/`srv`/`authSource`/
…) live in `plugin_db.connections`; **only the password is sealed in the vault** under
`EIDAN_DB_PASS_<slug>`. The admin route seals it via the engine secrets-api (the LLM-free write
path), and tools resolve it at call time with `ctx.vault.resolve('${…}')`. A secret value is never
sent to a model. This mirrors the eidan-pro mail bundle's account model.

Passwordless databases (trust auth / local socket) are allowed — leave the password blank and no
vault key is recorded.

## Config

- `EIDAN_DATABASE_URL` (or `DATABASE_URL`) — the eidan control-plane DB, where the `plugin_db`
  registry table lives. This is **not** one of the connected databases; those are arbitrary
  third-party servers described by the registry rows.

## Schema

`sql/0001_db.sql` mirrors the idempotent `ensureSchema()` in `src/registry.ts` for the
`@eidandev/migrate` deploy path. Keep the two in sync.

## Gate

`pnpm -C packages/db typecheck` (strict tsc) + `node --import tsx packages/db/smoke.test.mts`.
