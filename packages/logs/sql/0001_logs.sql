-- SPDX-License-Identifier: AGPL-3.0-or-later
-- `logs` bundle schema. The plugin also ensures this idempotently at setup() (src/registry.ts), so a
-- drop-in install needs no separate migrate step; this file is the deploy-time @eidandev/migrate path
-- for operators who prefer schema applied out-of-band. Every statement is IF NOT EXISTS, so the two
-- paths compose safely. Keep in sync with src/registry.ts.
--
-- plugin_logs.sources is the per-user registry of log sources the agent may read. No API token ever
-- lands here — each is sealed in the vault (eidan.secrets_vault) under the source's token_key.

create schema if not exists plugin_logs;

create table if not exists plugin_logs.sources (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null,
  name        text not null,
  slug        text not null,
  provider    text not null,
  config      jsonb not null default '{}'::jsonb,
  token_key   text not null default '',
  status      text not null default 'active',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create unique index if not exists uq_logs_user_slug
  on plugin_logs.sources (user_id, slug) where status = 'active';

create index if not exists idx_logs_user on plugin_logs.sources (user_id);
