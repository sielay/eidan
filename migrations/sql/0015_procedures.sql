-- Procedures become first-class entities.
--
-- They previously piggybacked on eidan.knowledge (skill = 'procedure'), which made `recall` surface
-- their JavaScript source as "knowledge" and led agents to conflate them with the db/psql plugin. Give
-- them their own table, migrate the existing rows (preserving ids so eidan.procedure_executions still
-- links), and retire the knowledge copies. Idempotent + additive.

CREATE TABLE IF NOT EXISTS eidan.procedures (
    id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     uuid        NOT NULL REFERENCES eidan.users(id) ON DELETE CASCADE,
    name        text        NOT NULL,
    source      text        NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),
    deleted_at  timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS procedures_user_name_active ON eidan.procedures (user_id, name) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_procedures_user_recent ON eidan.procedures (user_id, updated_at DESC) WHERE deleted_at IS NULL;

-- One-time move of any knowledge-stored procedures, preserving ids.
INSERT INTO eidan.procedures (id, user_id, name, source, created_at, updated_at, deleted_at)
  SELECT id, user_id, title, body, created_at, updated_at, deleted_at
    FROM eidan.knowledge
   WHERE skill = 'procedure'
  ON CONFLICT (id) DO NOTHING;

-- Retire the knowledge copies so recall + the Knowledge UI stop showing procedure source.
UPDATE eidan.knowledge SET deleted_at = now() WHERE skill = 'procedure' AND deleted_at IS NULL;

-- Repoint the executions FK from knowledge to the new table (ids preserved → existing rows stay linked).
-- No ADD CONSTRAINT IF NOT EXISTS in Postgres, so drop-then-add.
ALTER TABLE eidan.procedure_executions DROP CONSTRAINT IF EXISTS procedure_executions_procedure_id_fkey;
ALTER TABLE eidan.procedure_executions
  ADD CONSTRAINT procedure_executions_procedure_id_fkey
  FOREIGN KEY (procedure_id) REFERENCES eidan.procedures(id) ON DELETE SET NULL;
