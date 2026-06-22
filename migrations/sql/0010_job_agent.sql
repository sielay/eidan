-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Attribute a job to the agent that created it (#346/#407) — the `delegate` tool records the firing
-- agent (from the conversation it ran under), so the jobs board can swimlane by agent. Null = not
-- agent-originated (a human/chat delegate).
ALTER TABLE eidan.jobs ADD COLUMN IF NOT EXISTS agent text;
