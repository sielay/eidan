-- Telegram account linking (potem-style). A Telegram chat binds to an eidan user via a one-time
-- token: the bot's /start mints a row in telegram_link_tokens (capturing chat_id), replies with a
-- web link carrying the token; the signed-in web user redeems it, moving the chat_id into
-- telegram_chats bound to their user_id. Inbound then maps chat_id -> user; outbound (routines,
-- replies) looks up the user's chat_id. No manual chat_id entry, no static allowlist required.

create table eidan.telegram_link_tokens (
    token      text        primary key default gen_random_uuid()::text,
    chat_id    bigint      not null,
    first_name text,
    username   text,
    created_at timestamptz not null default now(),
    used_at    timestamptz
);
create index idx_telegram_link_chat on eidan.telegram_link_tokens (chat_id);

create table eidan.telegram_chats (
    user_id    uuid        not null,
    chat_id    bigint      not null,
    username   text,
    first_name text,
    linked_at  timestamptz not null default now(),
    updated_at timestamptz not null default now()
);
-- one chat per user, one user per chat (re-linking replaces).
create unique index uq_telegram_chats_user on eidan.telegram_chats (user_id);
create unique index uq_telegram_chats_chat on eidan.telegram_chats (chat_id);
