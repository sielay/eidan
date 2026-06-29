-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Affiliate program registry and link tracking: agents can discover programs, generate affiliate links,
-- inject them safely into content, and track where they're placed.

create table eidan.affiliate_programs (
    id uuid default gen_random_uuid() not null primary key,
    user_id uuid not null,
    name text not null,
    description text,
    program_type text not null, -- 'amazon', 'kdp', 'draft2digital', 'patreon', 'skillshare', etc.
    api_endpoint text, -- e.g. https://api.amazon.com/v1/associates or null for direct URL construction
    api_key text, -- DEPRECATED: should not be used. Store affiliate API credentials in vault (@eidandev/vault-postgres) instead for security
    link_template text not null, -- e.g. 'https://amazon.com/dp/{product_id}?tag={affiliate_id}'
    commission_pct numeric(5,2), -- expected commission percentage
    enabled boolean default true not null,
    metadata jsonb default '{}' not null, -- additional config: auth headers, rate limits, etc.
    created_at timestamptz default now() not null,
    updated_at timestamptz default now() not null,
    deleted_at timestamptz,
    constraint fk_affiliate_programs_user foreign key (user_id) references eidan.users(id)
);
create index idx_affiliate_programs_user_enabled on eidan.affiliate_programs(user_id, enabled, deleted_at);
create trigger trg_affiliate_programs_updated_at before update on eidan.affiliate_programs
    for each row execute function eidan.set_updated_at();

-- Track where affiliate links have been placed + their performance signals
create table eidan.affiliate_links (
    id uuid default gen_random_uuid() not null primary key,
    user_id uuid not null,
    program_id uuid not null,
    content_type text not null, -- 'youtube_description', 'blog_markdown', 'tweet', 'landing_page', etc.
    content_id text not null, -- identifier of the content (URL slug, video ID, etc.)
    product_id text not null, -- what product this link points to (ASIN, book title, course ID, etc.)
    generated_url text not null, -- the actual affiliate link injected
    position_context text, -- where in the content it was placed ('intro', 'paragraph_2', 'footer', etc.)
    injected_at timestamptz,
    performance_data jsonb default '{}' not null, -- clicks, impressions, conversions, revenue if available
    created_at timestamptz default now() not null,
    updated_at timestamptz default now() not null,
    deleted_at timestamptz,
    constraint fk_affiliate_links_user foreign key (user_id) references eidan.users(id),
    constraint fk_affiliate_links_program foreign key (program_id) references eidan.affiliate_programs(id)
);
create index idx_affiliate_links_user_program on eidan.affiliate_links(user_id, program_id, deleted_at);
create index idx_affiliate_links_content on eidan.affiliate_links(user_id, content_type, content_id, deleted_at);
create trigger trg_affiliate_links_updated_at before update on eidan.affiliate_links
    for each row execute function eidan.set_updated_at();
