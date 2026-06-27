-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Track when an escalation response has been processed by the agent system

ALTER TABLE eidan.escalations
  ADD COLUMN IF NOT EXISTS agent_response_processed_at timestamp with time zone;

-- Create index for efficient filtering of unprocessed responses
CREATE INDEX IF NOT EXISTS idx_escalations_unprocessed_responses
  ON eidan.escalations (user_id, status, agent_response_processed_at)
  WHERE status = 'responded' AND agent_response_processed_at IS NULL AND deleted_at IS NULL;
