-- Build -> plan inside a venture (charles#21). A venture is a container the operator can both
-- *build in* and *plan within*: attach lightweight tasks / ideas / notes to it, and let Charles
-- reason over the whole container (plan + items + resources + identity). This is the operator's own
-- derived "PA notebook" state (docs/001 §2, the "minimal derived memory" line), not a mirror of any
-- third party — so it lives in plugin_ventures.* and is owner-scoped like everything else here.
--
-- The lightweight *plan* itself is not a table: it rides in plugin_ventures.ventures.metadata.plan
-- (a small jsonb blob, set by the venture_set_plan tool), keeping a venture's "state" in one place
-- next to its identity. This table is only the many-rows-per-venture working items.
--
-- venture_items — tasks / ideas / notes under a venture. user_id-scoped (a venture can't cross
-- owners, but the explicit column keeps reads correct independent of any future RLS); soft status.

CREATE TABLE plugin_ventures.venture_items (
    id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    venture_id  uuid        NOT NULL REFERENCES plugin_ventures.ventures(id) ON DELETE CASCADE,
    user_id     uuid        NOT NULL,
    kind        text        NOT NULL DEFAULT 'task',
    title       text        NOT NULL,
    body        text,
    status      text        NOT NULL DEFAULT 'open',
    metadata    jsonb       NOT NULL DEFAULT '{}'::jsonb,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT vi_kind_chk   CHECK (kind IN ('task', 'idea', 'note')),
    -- 'archived' is the soft-delete tombstone; the live states are open / doing / done.
    CONSTRAINT vi_status_chk CHECK (status IN ('open', 'doing', 'done', 'archived'))
);

CREATE INDEX idx_vi_venture ON plugin_ventures.venture_items (venture_id);
CREATE INDEX idx_vi_user    ON plugin_ventures.venture_items (user_id);
