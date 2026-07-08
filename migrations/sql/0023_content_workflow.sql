-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Content workflow: card conversions, assets, copy, scheduling, forking.
-- Extends plugin_boards.cards to support the content-workflow 6-stage board:
-- Concept → Assets → Copy → Distribution → Scheduled → Published.

-- Add workflow columns to boards.cards
alter table plugin_boards.cards add column if not exists conversation_id uuid;
alter table plugin_boards.cards add column if not exists parent_card_id uuid references plugin_boards.cards(id) on delete set null;
alter table plugin_boards.cards add column if not exists publish_at timestamptz;
alter table plugin_boards.cards add column if not exists channels jsonb not null default '[]'::jsonb;
alter table plugin_boards.cards add column if not exists frozen_data jsonb not null default '{}'::jsonb;

-- Content workflow tables: assets, copy, schedule metadata
create table if not exists plugin_content.card_assets (
  id uuid primary key default gen_random_uuid(),
  card_id uuid not null references plugin_boards.cards(id) on delete cascade,
  user_id uuid not null,
  ref_id text not null,
  ref_kind text not null default 'artifact',
  approval_state text not null default 'pending' check (approval_state in ('pending', 'approved', 'rejected')),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists plugin_content.card_copy (
  id uuid primary key default gen_random_uuid(),
  card_id uuid not null references plugin_boards.cards(id) on delete cascade,
  user_id uuid not null,
  channel text not null,
  body text,
  state text not null default 'empty' check (state in ('empty', 'draft', 'ready')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (card_id, channel)
);

create table if not exists plugin_content.card_schedule (
  id uuid primary key default gen_random_uuid(),
  card_id uuid not null unique references plugin_boards.cards(id) on delete cascade,
  user_id uuid not null,
  publish_at timestamptz,
  frozen_plan jsonb not null default '[]'::jsonb,
  execution_status text not null default 'pending' check (execution_status in ('pending', 'in_progress', 'completed', 'failed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_plugin_content_card_assets_card on plugin_content.card_assets (card_id);
create index if not exists idx_plugin_content_card_copy_card on plugin_content.card_copy (card_id);
create index if not exists idx_plugin_boards_cards_conversation on plugin_boards.cards (conversation_id);
create index if not exists idx_plugin_boards_cards_parent on plugin_boards.cards (parent_card_id);
