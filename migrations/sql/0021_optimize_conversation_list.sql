-- SPDX-License-Identifier: AGPL-3.0-or-later

-- Optimize the conversation list endpoint queries:
-- - Add DESC index for efficient last_message_preview subquery (ORDER BY created_at DESC)
-- - Note: participant_count subquery could be denormalized if performance issues arise

CREATE INDEX IF NOT EXISTS idx_messages_conversation_created_desc
  ON eidan.messages USING btree (conversation_id, created_at DESC)
  WHERE (deleted_at IS NULL);
