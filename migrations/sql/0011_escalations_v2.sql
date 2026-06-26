-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Add bidirectional escalations support (Escalations v2)

ALTER TABLE eidan.escalations
  ADD COLUMN IF NOT EXISTS from_agent text,
  ADD COLUMN IF NOT EXISTS to_agent text,
  ADD COLUMN IF NOT EXISTS escalation_type text DEFAULT 'agent_to_operator'::text,
  ADD COLUMN IF NOT EXISTS response jsonb,
  ADD COLUMN IF NOT EXISTS trigger_prompt text,
  ADD COLUMN IF NOT EXISTS responded_at timestamp with time zone,
  ADD COLUMN IF NOT EXISTS responded_by uuid,
  ADD COLUMN IF NOT EXISTS deleted_at timestamp with time zone;

-- Update status check constraint to include new statuses
ALTER TABLE eidan.escalations
  DROP CONSTRAINT IF EXISTS escalations_status_chk;

ALTER TABLE eidan.escalations
  ADD CONSTRAINT escalations_status_chk CHECK (
    status = ANY (ARRAY[
      'pending'::text, 'acknowledged'::text, 'resolved'::text,
      'open'::text, 'responded'::text, 'rejected'::text
    ])
  );

-- Add escalation_type check constraint (Postgres has no ADD CONSTRAINT IF NOT EXISTS;
-- drop-then-add keeps the migration idempotent, matching escalations_status_chk above).
ALTER TABLE eidan.escalations
  DROP CONSTRAINT IF EXISTS escalations_type_chk;

ALTER TABLE eidan.escalations
  ADD CONSTRAINT escalations_type_chk CHECK (
    escalation_type = ANY (ARRAY[
      'agent_to_operator'::text, 'agent_to_agent'::text,
      'operator_to_agent'::text, 'operator_prompt'::text,
      'decision_gate'::text
    ])
  );

-- Create index for querying by to_agent + status (common agent query pattern)
CREATE INDEX IF NOT EXISTS idx_escalations_to_agent_status
  ON eidan.escalations (user_id, to_agent, status)
  WHERE deleted_at IS NULL;

-- Create index for querying by from_agent + status
CREATE INDEX IF NOT EXISTS idx_escalations_from_agent_status
  ON eidan.escalations (user_id, from_agent, status)
  WHERE deleted_at IS NULL;
