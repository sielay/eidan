-- The ventures harness (charles#12) — the scoping spine for every Charles capability.
-- One self-referential tree in the plugin_ventures schema (created by the runner). Ported from the
-- Alembic revision ventures20260609000001.
--
-- ventures — orgs -> ventures -> projects, recursive via parent_id (re-parentable). user_id-scoped;
-- soft status.

CREATE TABLE plugin_ventures.ventures (
    id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     uuid        NOT NULL,
    parent_id   uuid        REFERENCES plugin_ventures.ventures(id) ON DELETE CASCADE,
    name        text        NOT NULL,
    slug        text        NOT NULL,
    kind        text        NOT NULL DEFAULT 'venture',
    legal_type  text,
    status      text        NOT NULL DEFAULT 'active',
    metadata    jsonb       NOT NULL DEFAULT '{}'::jsonb,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT ventures_kind_chk   CHECK (kind IN ('org', 'venture', 'project')),
    CONSTRAINT ventures_status_chk CHECK (status IN ('active', 'archived')),
    CONSTRAINT ventures_no_self_parent CHECK (parent_id IS NULL OR parent_id <> id)
);

-- One active slug per owner; archived rows don't block re-use.
CREATE UNIQUE INDEX uq_ventures_user_slug ON plugin_ventures.ventures (user_id, slug) WHERE status = 'active';
CREATE INDEX idx_ventures_user ON plugin_ventures.ventures (user_id);
CREATE INDEX idx_ventures_parent ON plugin_ventures.ventures (parent_id);
