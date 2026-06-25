-- Many boards per venture (charles planning platform). A venture can hold several named kanban
-- boards (e.g. "Marketing", "Build", "Ops"); venture_items gain a board_id so each item lives on one
-- board. Additive + idempotent. Pre-existing items (board_id null) are backfilled to a venture's
-- first/default board lazily by the boards data route, so nothing disappears.

CREATE TABLE IF NOT EXISTS plugin_ventures.venture_boards (
    id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    venture_id  uuid        NOT NULL REFERENCES plugin_ventures.ventures(id) ON DELETE CASCADE,
    user_id     uuid        NOT NULL,
    name        text        NOT NULL,
    position    int         NOT NULL DEFAULT 0,
    status      text        NOT NULL DEFAULT 'active',
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT vb_status_chk CHECK (status IN ('active', 'archived'))
);
CREATE INDEX IF NOT EXISTS idx_vb_venture ON plugin_ventures.venture_boards (venture_id);
CREATE INDEX IF NOT EXISTS idx_vb_user    ON plugin_ventures.venture_boards (user_id);

ALTER TABLE plugin_ventures.venture_items
    ADD COLUMN IF NOT EXISTS board_id uuid REFERENCES plugin_ventures.venture_boards(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_vi_board ON plugin_ventures.venture_items (board_id);
