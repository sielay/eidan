-- User-defined agents with composable triggers (epic sielay/eidan#346). An agent is a configured
-- persona + its own provider/model; it binds to one or more triggers (schedule | sensor | webhook).
-- This generalises eidan.routines (the schedule case). The cluster runs all agents with exactly-once
-- dedup via the unique (trigger_id, fire_key) index on agent_runs — the same claim-by-insert guard
-- routines uses, so any number of nodes can poll without duplicate fires. Slice 1 (#346) ships the
-- schedule trigger; sensor/webhook land as follow-ups (the schema already carries them).

create table eidan.agents (
    id          uuid        primary key default gen_random_uuid(),
    user_id     uuid        not null,
    name        text        not null,
    persona     text        not null,            -- system prompt / role; what the agent does each fire
    provider    text,                            -- per-agent provider (claude|openrouter|ollama|…); null = node default
    model       text,                            -- optional explicit model override (informational for now)
    enabled     boolean     not null default true,
    metadata    jsonb       not null default '{}'::jsonb,
    created_at  timestamptz not null default now(),
    updated_at  timestamptz not null default now(),
    deleted_at  timestamptz
);
create index idx_agents_user on eidan.agents (user_id) where deleted_at is null;
create index idx_agents_enabled on eidan.agents (enabled) where deleted_at is null and enabled;
create trigger trg_agents_updated_at before update on eidan.agents
    for each row execute function eidan.set_updated_at();

create table eidan.agent_triggers (
    id          uuid        primary key default gen_random_uuid(),
    agent_id    uuid        not null references eidan.agents (id) on delete cascade,
    user_id     uuid        not null,
    type        text        not null,
    config      jsonb       not null default '{}'::jsonb,  -- schedule:{schedule} | sensor:{kind,filter} | webhook:{token}
    enabled     boolean     not null default true,
    created_at  timestamptz not null default now(),
    updated_at  timestamptz not null default now(),
    deleted_at  timestamptz,
    constraint agent_triggers_type_chk check (type in ('schedule', 'sensor', 'webhook'))
);
create index idx_agent_triggers_agent on eidan.agent_triggers (agent_id) where deleted_at is null;
create index idx_agent_triggers_type on eidan.agent_triggers (type, enabled) where deleted_at is null and enabled;
create trigger trg_agent_triggers_updated_at before update on eidan.agent_triggers
    for each row execute function eidan.set_updated_at();

-- One row per fire. unique (trigger_id, fire_key) is the cross-node claim guard: many nodes poll, one
-- wins the insert for a given fire → exactly once. conversation_id links the turn the fire produced
-- (no FK, so agent_runs stays durable if the conversation is later pruned).
create table eidan.agent_runs (
    id              uuid        primary key default gen_random_uuid(),
    agent_id        uuid        not null references eidan.agents (id) on delete cascade,
    trigger_id      uuid        not null references eidan.agent_triggers (id) on delete cascade,
    user_id         uuid        not null,
    fire_key        text        not null,        -- schedule window | sensor item id | webhook delivery id
    status          text        not null default 'started',
    conversation_id uuid,
    detail          text,
    created_at      timestamptz not null default now(),
    constraint agent_runs_status_chk check (status in ('started', 'delivered', 'failed'))
);
create unique index uq_agent_run_fire on eidan.agent_runs (trigger_id, fire_key);
create index idx_agent_runs_agent on eidan.agent_runs (agent_id, created_at desc);
