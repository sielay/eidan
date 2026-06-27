-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Add agent relationships table for org chart structure

CREATE TABLE IF NOT EXISTS eidan.agent_relationships (
  id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES eidan.users(id) ON DELETE CASCADE,
  from_agent_id uuid NOT NULL REFERENCES eidan.agents(id) ON DELETE CASCADE,
  to_agent_id uuid NOT NULL REFERENCES eidan.agents(id) ON DELETE CASCADE,
  relationship_type text NOT NULL,
  strength integer DEFAULT 3 NOT NULL,
  description text,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT agent_relationships_type_chk CHECK (
    relationship_type = ANY (ARRAY[
      'reads_from'::text, 'writes_to'::text, 'asks'::text,
      'depends_on'::text, 'notifies'::text
    ])
  ),
  CONSTRAINT agent_relationships_strength_chk CHECK (strength >= 1 AND strength <= 5),
  CONSTRAINT agent_relationships_description_chk CHECK (description IS NULL OR length(description) <= 1000)
);

-- Unique constraint: one relationship per direction per user
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_relationships_unique
  ON eidan.agent_relationships (user_id, from_agent_id, to_agent_id);

-- Indexes for querying by type
CREATE INDEX IF NOT EXISTS idx_agent_relationships_from_agent_type
  ON eidan.agent_relationships (user_id, from_agent_id, relationship_type);

CREATE INDEX IF NOT EXISTS idx_agent_relationships_to_agent_type
  ON eidan.agent_relationships (user_id, to_agent_id, relationship_type);

-- Trigger for updated_at
CREATE TRIGGER eidan_agent_relationships_updated_at
  BEFORE UPDATE ON eidan.agent_relationships
  FOR EACH ROW EXECUTE FUNCTION eidan.set_updated_at();
