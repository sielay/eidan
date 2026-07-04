-- Reddit research plugin: posts cache and trend tracking
create table if not exists eidan.reddit_posts (
    id            uuid        primary key default gen_random_uuid(),
    user_id       uuid        not null,
    post_id       text        not null,            -- Reddit post fullname (t3_<id>)
    subreddit     text        not null,
    title         text        not null,
    author        text        not null,
    score         integer     not null default 0,
    num_comments  integer     not null default 0,
    url           text        not null,
    text_content  text,
    sentiment     text,                            -- frustration | neutral | positive | etc
    keywords      text[],
    created_utc   bigint      not null,
    fetched_at    timestamptz not null default now(),
    created_at    timestamptz not null default now(),
    updated_at    timestamptz not null default now(),
    deleted_at    timestamptz
);

-- One row per (user, post_id): avoid re-scraping the same post
create unique index if not exists uq_reddit_posts_post_id
    on eidan.reddit_posts (user_id, post_id)
    where deleted_at is null;

-- Query posts by subreddit and date
create index if not exists idx_reddit_posts_subreddit
    on eidan.reddit_posts (user_id, subreddit, created_utc desc)
    where deleted_at is null;

-- Query posts by sentiment
create index if not exists idx_reddit_posts_sentiment
    on eidan.reddit_posts (user_id, sentiment, created_utc desc)
    where deleted_at is null and sentiment is not null;

-- Query posts by keyword
create index if not exists idx_reddit_posts_keywords
    on eidan.reddit_posts using gin (keywords)
    where deleted_at is null;

create trigger trg_reddit_posts_updated_at before update on eidan.reddit_posts
    for each row execute function eidan.set_updated_at();

-- Venture-to-subreddit mapping (operator config)
create table if not exists eidan.reddit_ventures (
    id            uuid        primary key default gen_random_uuid(),
    user_id       uuid        not null,
    venture       text        not null,            -- venture slug (mathbuns, phonekills, etc)
    subreddit     text        not null,            -- target subreddit (r/parenting, r/nosurf, etc)
    keywords      text[],                          -- optional: keywords to search within subreddit
    sentiment_keywords text[],                     -- optional: frustration keywords to filter on
    created_at    timestamptz not null default now(),
    updated_at    timestamptz not null default now(),
    deleted_at    timestamptz
);

-- One row per (user, venture, subreddit): operator's research targets
create unique index if not exists uq_reddit_ventures_mapping
    on eidan.reddit_ventures (user_id, venture, subreddit)
    where deleted_at is null;

create trigger trg_reddit_ventures_updated_at before update on eidan.reddit_ventures
    for each row execute function eidan.set_updated_at();
