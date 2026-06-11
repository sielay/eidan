# eidan schema migrations

The `eidan.*` Postgres schema, as ordered SQL files in `sql/`, applied by a tiny Node runner
(`migrate.mjs`) — no Alembic / Python. `0001_baseline.sql` is the full current schema (a snapshot
that supersedes the old Alembic history); later changes are new numbered `.sql` files.

## Apply

```bash
EIDAN_DATABASE_URL=postgres://...@host/db pnpm --filter @eidandev/migrate migrate
```

The runner tracks applied files in `eidan._migrations` (idempotent — re-running is a no-op). Connect
the **runtime** as the non-superuser `eidan_app` role (created by `0002_roles.sql`) so RLS enforces;
set its password with `ALTER ROLE eidan_app PASSWORD '…'`.

## Add a migration

Drop a new `sql/NNNN_name.sql` (next number). Keep changes additive and idempotent where you can.
The matbot backend (`@eidandev/storage-postgres`) reads the schema directly.
