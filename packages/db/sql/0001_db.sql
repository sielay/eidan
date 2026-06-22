-- SPDX-License-Identifier: AGPL-3.0-or-later
-- `db` bundle schema. The plugin also ensures this idempotently at setup() (src/registry.ts), so a
-- drop-in install needs no separate migrate step; this file is the deploy-time @eidandev/migrate
-- path for operators who prefer schema applied out-of-band. Every statement is IF NOT EXISTS, so the
-- two paths compose safely. Keep in sync with src/registry.ts.
--
-- plugin_db.connections is the per-user registry of databases the agent may reach. No password ever
-- lands here — each is sealed in the vault (eidan.secrets_vault) under the connection's pass_key.

create schema if not exists plugin_db;

create table if not exists plugin_db.connections (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null,
  name        text not null,
  slug        text not null,
  driver      text not null,
  host        text not null,
  port        integer not null,
  database    text not null default '',
  username    text not null default '',
  options     jsonb not null default '{}'::jsonb,
  pass_key    text not null default '',
  status      text not null default 'active',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create unique index if not exists uq_db_user_slug
  on plugin_db.connections (user_id, slug) where status = 'active';

create index if not exists idx_db_user on plugin_db.connections (user_id);
