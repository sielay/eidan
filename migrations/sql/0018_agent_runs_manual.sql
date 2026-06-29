-- Make manual "Run now" agent fires observable. They have no trigger, so eidan.agent_runs.trigger_id
-- (NOT NULL since 0006) blocked recording them — which is why a manually-tested agent couldn't see
-- its own run in the observer's agent_activity. Allow null trigger_id for the manual case; the unique
-- (trigger_id, fire_key) dedup index is unaffected (Postgres treats NULLs as distinct, and manual
-- fire_keys carry the unique conversation id anyway).
alter table eidan.agent_runs alter column trigger_id drop not null;
