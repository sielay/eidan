-- Add starred column to conversations table for pinning important conversations.
ALTER TABLE eidan.conversations
  ADD COLUMN starred boolean DEFAULT false NOT NULL;

-- Create partial index for efficient starred-first ordering.
CREATE INDEX idx_conversations_user_starred_recent
  ON eidan.conversations (user_id, starred DESC, updated_at DESC)
  WHERE deleted_at IS NULL;
