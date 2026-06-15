-- Routines: user-defined recurring prompts ("every morning at 08:00, brief me"). The @eidandev/routines
-- plugin runs a small poll loop that evaluates each enabled routine against the owner's timezone and,
-- when due, runs the prompt as an agent turn and delivers the result via @eidandev/notify.
--
-- routine_runs records one row per fired window. Its unique (routine_id, fired_for) index is the
-- cross-node fire guard: when several worker nodes share this database they all poll, but only one
-- wins the insert for a given window, so a routine fires exactly once per window regardless of how
-- many nodes are running.

create table eidan.routines (
    id          uuid primary key default gen_random_uuid(),
    user_id     uuid not null,
    name        text not null,
    -- "HH:MM" (every day) or "<days> HH:MM" (e.g. "mon,wed,fri 08:00"); interpreted in the owner's tz.
    schedule    text not null,
    prompt      text not null,
    enabled     boolean not null default true,
    last_run_at timestamptz,
    created_at  timestamptz not null default now(),
    updated_at  timestamptz not null default now(),
    deleted_at  timestamptz
);
create index idx_routines_user on eidan.routines (user_id) where deleted_at is null;
create index idx_routines_due on eidan.routines (enabled) where deleted_at is null and enabled;

create trigger trg_routines_updated_at before update on eidan.routines
    for each row execute function eidan.set_updated_at();

create table eidan.routine_runs (
    id         uuid primary key default gen_random_uuid(),
    routine_id uuid not null references eidan.routines (id) on delete cascade,
    user_id    uuid not null,
    -- the local window key, e.g. "2026-06-15T08:00" — one fire per (routine, window).
    fired_for  text not null,
    status     text not null default 'started',
    detail     text,
    created_at timestamptz not null default now(),
    constraint routine_runs_status_chk check (status in ('started', 'delivered', 'failed'))
);
create unique index uq_routine_run_window on eidan.routine_runs (routine_id, fired_for);
create index idx_routine_runs_routine on eidan.routine_runs (routine_id);
