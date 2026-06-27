-- SPDX-License-Identifier: AGPL-3.0-or-later
-- First-class agent relationships. Make `agent_to_agent` (a standing directed link — one agent
-- delegates to / reviews / reports to / escalates to another) and `decision_gate` (the agent pauses
-- for a decision before proceeding) real agent_triggers types, so the org chart renders them as actual
-- edges and behaviour can build on them — instead of relationships living only as prose in personas.
-- PG has no ADD CONSTRAINT IF NOT EXISTS → drop-then-add.

alter table eidan.agent_triggers drop constraint if exists agent_triggers_type_chk;
alter table eidan.agent_triggers
  add constraint agent_triggers_type_chk
  check (type in ('schedule', 'sensor', 'webhook', 'response', 'agent_to_agent', 'decision_gate'));
