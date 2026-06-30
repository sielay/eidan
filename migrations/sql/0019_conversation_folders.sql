-- Folders for organising conversations: create/rename/delete/star/move, with optional nesting.
-- User-scoped the same way the rest of the conversation surface is — every handler filters by
-- user_id explicitly (the REST pool connects as a superuser that bypasses RLS), so explicit
-- filtering is the real guard. `starred` mirrors conversations.starred so folders sort the same way.
create table if not exists eidan.conversation_folders (
    id          uuid        primary key default gen_random_uuid(),
    user_id     uuid        not null,
    name        text        not null,
    parent_id   uuid        references eidan.conversation_folders (id) on delete set null,
    starred     boolean     not null default false,
    sort_order  integer     not null default 0,
    created_at  timestamptz not null default now(),
    updated_at  timestamptz not null default now(),
    deleted_at  timestamptz
);
create index if not exists idx_conv_folders_user
    on eidan.conversation_folders (user_id, starred desc, sort_order, name)
    where deleted_at is null;

-- A conversation's folder (null = root / unfiled). No FK: a folder delete nulls these explicitly so an
-- orphaned folder_id never wedges a conversation; the UI treats an unknown folder_id as root anyway.
alter table eidan.conversations add column if not exists folder_id uuid;
create index if not exists idx_conversations_folder
    on eidan.conversations (folder_id)
    where deleted_at is null;

create trigger trg_conv_folders_updated_at before update on eidan.conversation_folders
    for each row execute function eidan.set_updated_at();
