<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# 0015 — Storage backend (Postgres)

Status: **Shipped** — `@eidandev/storage-postgres`.

## Goal

Be matbot's `StorageBackend`, so the runtime's sessions, plugin KV namespaces, and files all land in
the relational `eidan.*` schema instead of matbot's default flat store. Postgres is eidan's source of
truth, so this is the plugin that makes that true: every `Store<Session>` read/write the runner does
goes through here, under the ambient principal, with Postgres RLS enforcing tenant isolation.

## How it works

- **One backend, three store shapes.** `EidanStorageBackend.createStore(ns)` returns a
  `PgSessionStore` for the `sessions` namespace and a generic `PgKvStore` for every other namespace
  (settings, schedules, …); the backend also exposes a `fileStore` (`PgFileStore`). Stores are
  memoised per namespace.
- **Sessions are reconciled, not overwritten.** matbot keeps a whole `Session` (with `messages[]`)
  as one CAS'd document; eidan keeps messages as **append-only** rows. `set(session)` upserts the
  `eidan.conversations` row, then INSERTs only the messages whose id isn't already a row — existing
  rows are never rewritten or deleted. That is eidan's *keen* invariant (the inbound user message is
  persisted before the provider call). `content_blocks` (jsonb) round-trips matbot's
  `Message.content` losslessly; the legacy `content`/`tool_calls`/`tool_results` columns are
  denormalised projections kept only for queryability.
- **CAS over a version column.** `cas(id, expected, next)` reads `version` inside the same tx,
  compares, applies, and bumps `version = version + 1`; `delete` is soft (`deleted_at = now()`), and
  every read filters `deleted_at IS NULL`.
- **Ambient-principal RLS.** Every operation runs in `db.withPrincipalTx`, which opens a tx and sets
  a **LOCAL** GUC (`select set_config('eidan.current_user_id', <principal.id>, true)`) so Postgres RLS
  policies do the tenant filtering — no app-level `where user_id =` smeared across the queries.
- **Files in Postgres.** `PgFileStore` backs matbot's `FileStore` with `eidan.artifacts` (metadata,
  user-scoped) + `eidan.artifact_blobs` (bytes in `bytea` — the zero-dependency default; an S3
  backend would key off `storage_key`). `watch()` is currently a no-op (a LISTEN/NOTIFY watcher is a
  follow-up).

## Row mappers

The DB-row → matbot-domain projection (`rowToSession`, `rowToMessage`) lives in its own pure module
(`row-mappers.ts`, type-only matbot imports, erased at runtime) so it is unit-testable away from the
pg-backed store — see `row-mappers.test.ts`. The mappers stringify `version`, default `contexts` to
`[]`, default `traceId` to `''`, and omit optional fields (`title`, `persona`, `parentSessionId`,
`branchPointMessageId`, `providerName`, `metadata`) when null/empty.

## Config

| Env | Meaning |
|---|---|
| `EIDAN_DATABASE_URL` (or `DATABASE_URL`) | Postgres connection string. Static infra config → env (eidan secrets doctrine: only per-user creds go through the vault). Required; the backend rejects `open()` without it. |

## Files of record

- `packages/storage-postgres/src/backend.ts` — `EidanStorageBackend` (the `StorageBackend` impl, store factory).
- `packages/storage-postgres/src/session-store.ts` — `PgSessionStore` (keen append-only sessions) + `PgKvStore` (generic namespaces).
- `packages/storage-postgres/src/row-mappers.ts` — pure row → domain mappers (+ `row-mappers.test.ts`).
- `packages/storage-postgres/src/file-store.ts` — `PgFileStore` over `eidan.artifacts` / `artifact_blobs`.
- `packages/storage-postgres/src/db.ts` — pool + `withPrincipalTx` (the LOCAL-GUC / RLS seam).
- Related: [[0011-memory]] and [[0010-jobs]] persist through this backend; [[0013-architecture]] for the keen-persistence principle.
