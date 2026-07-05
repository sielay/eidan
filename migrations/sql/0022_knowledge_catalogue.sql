-- SPDX-License-Identifier: AGPL-3.0-or-later

-- Knowledge catalogue: auto-tagged learnings tied to ventures, goals, issues, and life context.
-- Extends the memory system with structured capture and proactive recall via ventures/goals/topics.

CREATE TABLE eidan.knowledge_catalogue (
    id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    user_id uuid NOT NULL,
    title text NOT NULL,
    content text NOT NULL,
    source text NOT NULL, -- 'youtube', 'article', 'email', 'chat', 'transcript', 'manual', etc.
    source_url text,
    date_captured timestamp with time zone DEFAULT now() NOT NULL,

    -- Tagging against operator's landscape (stored as JSONB for flexible querying)
    tags jsonb DEFAULT '{}'::jsonb NOT NULL, -- {ventures: [...], goals: [...], issues: [...], personal: [...], topics: [...]}
    key_concepts text[] DEFAULT '{}'::text[] NOT NULL, -- extracted bullet points

    status text DEFAULT 'raw'::text NOT NULL, -- 'raw', 'catalogued', 'archived'

    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,

    CONSTRAINT knowledge_catalogue_source_check CHECK (source IN ('youtube', 'article', 'email', 'chat', 'transcript', 'manual', 'imported', 'other')),
    CONSTRAINT knowledge_catalogue_status_check CHECK (status IN ('raw', 'catalogued', 'archived'))
);

-- Indexes for efficient querying
CREATE INDEX IF NOT EXISTS idx_knowledge_catalogue_user_status
  ON eidan.knowledge_catalogue (user_id, status)
  WHERE (deleted_at IS NULL);

CREATE INDEX IF NOT EXISTS idx_knowledge_catalogue_user_created
  ON eidan.knowledge_catalogue (user_id, date_captured DESC)
  WHERE (deleted_at IS NULL);

-- Full-text search over title and content
CREATE INDEX IF NOT EXISTS idx_knowledge_catalogue_search
  ON eidan.knowledge_catalogue USING GIN (to_tsvector('english'::regconfig, title || ' ' || content))
  WHERE (deleted_at IS NULL);

-- Tag-based querying (GIN index for JSONB containment)
CREATE INDEX IF NOT EXISTS idx_knowledge_catalogue_tags
  ON eidan.knowledge_catalogue USING GIN (tags)
  WHERE (deleted_at IS NULL);

-- Trigger to update updated_at on modify
CREATE TRIGGER knowledge_catalogue_updated_at
  BEFORE UPDATE ON eidan.knowledge_catalogue
  FOR EACH ROW
  EXECUTE FUNCTION eidan.set_updated_at();
