-- Actual provider spend, sourced from billing/invoice emails (the vendor billing APIs are
-- unreachable with our inference keys — OpenRouter analytics needs a provisioning key → 403, and
-- Anthropic/OpenAI expose no usable billing endpoint). An agent (e.g. Email Digest) parses each
-- receipt and upserts a period total here via the `record_provider_spend` tool; the `observer` tool
-- reconciles these ACTUALS against the eidan.llm_calls estimate, which surfaces off-ledger spend
-- (e.g. sage's self-review) as the gap.
create table if not exists eidan.provider_spend (
    id            uuid        primary key default gen_random_uuid(),
    user_id       uuid        not null,
    provider      text        not null,            -- vendor as billed: anthropic | openrouter | openai | ...
    period_start  date        not null,
    period_end    date        not null,
    amount        numeric(12,4) not null,
    currency      text        not null default 'USD',
    invoice_ref   text,                            -- invoice number / receipt id, for dedup + audit
    source        text,                            -- where it came from, e.g. 'email:<message_id>'
    raw           jsonb       not null default '{}'::jsonb,
    created_at    timestamptz not null default now(),
    updated_at    timestamptz not null default now(),
    deleted_at    timestamptz
);

-- One row per (user, provider, billing period): re-parsing the same invoice updates in place.
create unique index if not exists uq_provider_spend_period
    on eidan.provider_spend (user_id, provider, period_start, period_end)
    where deleted_at is null;
create index if not exists idx_provider_spend_user
    on eidan.provider_spend (user_id, period_start desc)
    where deleted_at is null;

create trigger trg_provider_spend_updated_at before update on eidan.provider_spend
    for each row execute function eidan.set_updated_at();
