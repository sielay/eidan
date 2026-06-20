# @eidandev/storage-postgres

eidan's **relational Postgres storage backend** — the matbot `StorageBackend`
that persists conversations, messages, and file artifacts as queryable rows in
the `eidan` schema. It replaces matbot's filesystem/IndexedDB stores so eidan's
memory is real Postgres (joinable, RLS-scoped) rather than opaque documents.

This plugin registers a **`StorageBackend` service**, not agent tools — so it
has no Tools table. Everything else in eidan consumes it transparently: matbot's
runner opens `Store<Session>` and the `FileStore` through it, and any plugin
that calls `services.StorageBackend?.createStore(ns)` gets a Postgres-backed
KV store keyed by namespace.

## What it provides

- **`Store<Session>`** (namespace `sessions`) — `PgSessionStore`. matbot keeps a
  session as one CAS'd document; eidan keeps messages as **append-only rows**.
  `set(session)` upserts `eidan.conversations` then INSERTs only messages whose
  `id` isn't already a row — persisted messages are never rewritten or deleted.
  `cas`/`delete` use the conversation `version` and soft-delete (`deleted_at`).
- **`Store<T>`** (any other namespace) — `PgKvStore` over `eidan.kv`, a generic
  jsonb doc store. `query()` loads the namespace and applies the `StoreQuery`
  via matbot's reference in-memory `executeQuery` (correct at KV scale).
- **`FileStore`** — `PgFileStore` over `eidan.artifacts` (metadata) +
  `eidan.artifact_blobs` (bytes in `bytea`). `put`/`get`/`getByName`/`list`/
  `delete`/`putTemp` are all principal-scoped; `watch()` is a no-op for now.

Every operation runs inside `Db.withPrincipalTx`, which stamps the ambient
matbot `Principal` into the `eidan.current_user_id` LOCAL GUC so Postgres RLS
enforces tenant isolation — no app-level filtering, no threaded user id.

## How others consume it

- matbot's runner: keen persistence — the inbound message hits the store before
  the provider call; reads rebuild the `Session` from rows via the row-mappers.
- Other plugins: `services.StorageBackend?.createStore<T>('my-namespace')`.

## Layout

- `src/index.ts` — the `MatbotPluginSpec`; exposes `storageBackend.open` and a
  `setup` that registers the backend if hot-loaded at runtime.
- `src/backend.ts` — `EidanStorageBackend`; `open()` reads `EIDAN_DATABASE_URL`
  and builds the `Db`, dispatches `createStore` to session vs KV stores.
- `src/session-store.ts` — `PgSessionStore` (append-only) + `PgKvStore`.
- `src/file-store.ts` — `PgFileStore` over artifacts + artifact_blobs.
- `src/row-mappers.ts` — pure DB-row → matbot `Session`/`Message` mappers
  (type-only imports, unit-tested in `row-mappers.test.ts`).
- `src/db.ts` — the principal-stamping transaction helper (`withPrincipalTx`).

## Schema

`eidan.conversations`, `eidan.messages`, `eidan.kv`, `eidan.artifacts`,
`eidan.artifact_blobs`. `Message.content` round-trips losslessly via the
`content_blocks` jsonb column; `content`/`tool_calls`/`tool_results` are
denormalised projections. Applied by the core migrate runner
(`migrations/sql/*.sql`), not per-plugin.

## Config

- `EIDAN_DATABASE_URL` (or `DATABASE_URL`) — Postgres connection (**required**).
