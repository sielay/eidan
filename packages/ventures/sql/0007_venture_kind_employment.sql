-- Add 'employment' as a venture kind (track a job / employment alongside org / venture / project).
-- Additive + idempotent.
ALTER TABLE plugin_ventures.ventures DROP CONSTRAINT IF EXISTS ventures_kind_chk;
ALTER TABLE plugin_ventures.ventures
    ADD CONSTRAINT ventures_kind_chk CHECK (kind IN ('org', 'venture', 'project', 'employment'));
