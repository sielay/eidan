-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Response triggers: a standing agent can fire when an escalation addressed to it is answered. Two
-- additive changes — kept here (not by editing the already-applied 0006) so they actually run on live
-- databases:
--   1. allow the 'response' trigger type (0006 shipped {schedule, sensor, webhook}). PG has no
--      ADD CONSTRAINT IF NOT EXISTS, so drop-then-add the type check.
--   2. track which escalation responses the agent loop has already consumed (so each fires once).

alter table eidan.agent_triggers drop constraint if exists agent_triggers_type_chk;
alter table eidan.agent_triggers
  add constraint agent_triggers_type_chk
  check (type in ('schedule', 'sensor', 'webhook', 'response'));

alter table eidan.escalations
  add column if not exists agent_response_processed_at timestamp with time zone;

create index if not exists idx_escalations_unprocessed_responses
  on eidan.escalations (user_id, status, agent_response_processed_at)
  where status = 'responded' and agent_response_processed_at is null and deleted_at is null;
