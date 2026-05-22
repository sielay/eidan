"""init events / knowledge / notes — Phase 1.5 memory tables

Revision ID: 20260514000002
Revises: 20260514000001
Create Date: 2026-05-14

Adds the remaining three core memory tables specified in docs/003
(§4 events, §5 knowledge, §6 notes) that were deferred from the
init_memory_model migration. With this migration the core memory
schema matches docs/003 in full; RLS is still layered on later by
the RLS plugin via the host-schema migration extension point
(docs/018 §7).
"""
from __future__ import annotations

from collections.abc import Sequence

from alembic import op

revision: str = "20260514000002"
down_revision: str | None = "20260514000001"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # 1. events — calendar-like rows. No FKs to other memory tables besides users.
    op.execute(
        """
        CREATE TABLE eidan.events (
            id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
            user_id         uuid        NOT NULL
                                        REFERENCES eidan.users(id)
                                        ON DELETE CASCADE,
            type            text        NOT NULL,
            title           text        NOT NULL,
            body            text,
            due_at          timestamptz,
            occurred_at     timestamptz,
            duration_s      integer,
            status          text        NOT NULL DEFAULT 'pending',
            recurrence      text,
            external_ref    text,
            metadata        jsonb       NOT NULL DEFAULT '{}'::jsonb,
            created_at      timestamptz NOT NULL DEFAULT now(),
            updated_at      timestamptz NOT NULL DEFAULT now(),
            deleted_at      timestamptz,
            CONSTRAINT events_status_chk CHECK (
                status IN ('pending', 'in_progress', 'done', 'cancelled', 'missed')
            ),
            CONSTRAINT events_time_chk CHECK (
                due_at IS NOT NULL OR occurred_at IS NOT NULL
            )
        )
        """
    )
    op.execute(
        """
        CREATE INDEX idx_events_user_due_pending
            ON eidan.events (user_id, due_at)
            WHERE status = 'pending'
              AND deleted_at IS NULL
              AND due_at IS NOT NULL
        """
    )
    op.execute(
        """
        CREATE INDEX idx_events_user_type_due
            ON eidan.events (user_id, type, due_at)
            WHERE deleted_at IS NULL
              AND due_at IS NOT NULL
        """
    )
    op.execute(
        """
        CREATE INDEX idx_events_user_occurred
            ON eidan.events (user_id, occurred_at DESC)
            WHERE deleted_at IS NULL
              AND occurred_at IS NOT NULL
        """
    )
    op.execute(
        """
        CREATE INDEX idx_events_recurrence
            ON eidan.events (user_id)
            WHERE recurrence IS NOT NULL
              AND status = 'pending'
              AND deleted_at IS NULL
        """
    )
    op.execute(
        """
        CREATE TRIGGER trg_events_updated_at
        BEFORE UPDATE ON eidan.events
        FOR EACH ROW EXECUTE FUNCTION eidan.set_updated_at()
        """
    )

    # 2. knowledge — skill-tagged markdown with FTS.
    op.execute(
        """
        CREATE TABLE eidan.knowledge (
            id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
            user_id         uuid        NOT NULL
                                        REFERENCES eidan.users(id)
                                        ON DELETE CASCADE,
            skill           text        NOT NULL,
            title           text        NOT NULL,
            body            text        NOT NULL,
            source          text,
            source_type     text,
            body_tsv        tsvector    GENERATED ALWAYS AS (
                                            to_tsvector(
                                                'english',
                                                coalesce(title, '') || ' ' || coalesce(body, '')
                                            )
                                        ) STORED,
            metadata        jsonb       NOT NULL DEFAULT '{}'::jsonb,
            created_at      timestamptz NOT NULL DEFAULT now(),
            updated_at      timestamptz NOT NULL DEFAULT now(),
            deleted_at      timestamptz,
            CONSTRAINT knowledge_source_type_chk CHECK (
                source_type IS NULL
                OR source_type IN ('url', 'file', 'chat', 'manual', 'imported')
            )
        )
        """
    )
    op.execute(
        """
        CREATE UNIQUE INDEX uq_knowledge_user_skill_title
            ON eidan.knowledge (user_id, skill, title)
            WHERE deleted_at IS NULL
        """
    )
    op.execute(
        """
        CREATE INDEX idx_knowledge_user_skill
            ON eidan.knowledge (user_id, skill)
            WHERE deleted_at IS NULL
        """
    )
    op.execute(
        """
        CREATE INDEX idx_knowledge_body_tsv
            ON eidan.knowledge USING GIN (body_tsv)
            WHERE deleted_at IS NULL
        """
    )
    op.execute(
        """
        CREATE TRIGGER trg_knowledge_updated_at
        BEFORE UPDATE ON eidan.knowledge
        FOR EACH ROW EXECUTE FUNCTION eidan.set_updated_at()
        """
    )

    # 3. notes — working memory written by an agent during a conversation.
    op.execute(
        """
        CREATE TABLE eidan.notes (
            id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
            user_id           uuid        NOT NULL
                                          REFERENCES eidan.users(id)
                                          ON DELETE CASCADE,
            agent_id          uuid        NOT NULL
                                          REFERENCES eidan.agent_context(id)
                                          ON DELETE CASCADE,
            conversation_id   uuid        REFERENCES eidan.conversations(id)
                                          ON DELETE SET NULL,
            content           text        NOT NULL,
            metadata          jsonb       NOT NULL DEFAULT '{}'::jsonb,
            created_at        timestamptz NOT NULL DEFAULT now(),
            updated_at        timestamptz NOT NULL DEFAULT now(),
            deleted_at        timestamptz
        )
        """
    )
    op.execute(
        """
        CREATE INDEX idx_notes_user_recent
            ON eidan.notes (user_id, created_at DESC)
            WHERE deleted_at IS NULL
        """
    )
    op.execute(
        """
        CREATE INDEX idx_notes_agent_recent
            ON eidan.notes (agent_id, created_at DESC)
            WHERE deleted_at IS NULL
        """
    )
    op.execute(
        """
        CREATE INDEX idx_notes_conversation
            ON eidan.notes (conversation_id, created_at)
            WHERE conversation_id IS NOT NULL AND deleted_at IS NULL
        """
    )
    op.execute(
        """
        CREATE TRIGGER trg_notes_updated_at
        BEFORE UPDATE ON eidan.notes
        FOR EACH ROW EXECUTE FUNCTION eidan.set_updated_at()
        """
    )


def downgrade() -> None:
    op.execute("DROP TABLE IF EXISTS eidan.notes")
    op.execute("DROP TABLE IF EXISTS eidan.knowledge")
    op.execute("DROP TABLE IF EXISTS eidan.events")
