-- The generic namespaced key/value store backing the matbot StorageBackend's PgKvStore
-- (packages/storage-postgres): plugin settings() and any keyed Store<T>. namespace+id is the key,
-- doc is the JSON value, version drives optimistic concurrency (cas). storage-postgres has always
-- read/written eidan.kv but no migration created it — added when frontend-telegram's per-chat
-- settings() (chat -> session pointer) first exercised the table.

create table eidan.kv (
    namespace  text        not null,
    id         text        not null,
    version    text        not null,
    doc        jsonb       not null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    primary key (namespace, id)
);

create trigger trg_kv_updated_at before update on eidan.kv
    for each row execute function eidan.set_updated_at();
