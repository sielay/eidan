"""init memory model — five core tables

Revision ID: 20260514000001
Revises: 20260514000000
Create Date: 2026-05-14

Creates the Phase 1 subset of the core memory schema per docs/003:
agent_context, user_context, conversations, messages, llm_calls.

events, knowledge, notes are deferred to a later migration (Phase 1.5+)
because Phase 1's agent loop does not yet consume them.
"""
from __future__ import annotations

from collections.abc import Sequence

from alembic import op

revision: str = "20260514000001"
down_revision: str | None = "20260514000000"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # 1. agent_context — no FK dependencies on other memory tables.
    op.execute(
        """
        CREATE TABLE eidan.agent_context (
            id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
            user_id         uuid        NOT NULL
                                        REFERENCES eidan.users(id)
                                        ON DELETE CASCADE,
            agent_slug      text        NOT NULL,
            display_name    text        NOT NULL,
            description     text,
            code_defaults   jsonb       NOT NULL DEFAULT '{}'::jsonb,
            user_overrides  jsonb       NOT NULL DEFAULT '{}'::jsonb,
            enabled         boolean     NOT NULL DEFAULT true,
            created_at      timestamptz NOT NULL DEFAULT now(),
            updated_at      timestamptz NOT NULL DEFAULT now(),
            CONSTRAINT agent_context_slug_chk CHECK (
                agent_slug ~ '^[a-z0-9][a-z0-9_-]*$'
            ),
            CONSTRAINT agent_context_user_slug_uq UNIQUE (user_id, agent_slug)
        )
        """
    )
    op.execute(
        """
        CREATE INDEX idx_agent_context_user_enabled
            ON eidan.agent_context (user_id)
            WHERE enabled = true
        """
    )
    op.execute(
        """
        CREATE TRIGGER trg_agent_context_updated_at
        BEFORE UPDATE ON eidan.agent_context
        FOR EACH ROW EXECUTE FUNCTION eidan.set_updated_at()
        """
    )

    # 2. user_context.
    op.execute(
        """
        CREATE TABLE eidan.user_context (
            id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
            user_id         uuid        NOT NULL
                                        REFERENCES eidan.users(id)
                                        ON DELETE CASCADE,
            category        text        NOT NULL,
            key             text        NOT NULL,
            value           jsonb       NOT NULL,
            source          text,
            confidence      real,
            metadata        jsonb       NOT NULL DEFAULT '{}'::jsonb,
            created_at      timestamptz NOT NULL DEFAULT now(),
            updated_at      timestamptz NOT NULL DEFAULT now(),
            deleted_at      timestamptz,
            CONSTRAINT user_context_category_chk CHECK (
                category IN ('identity', 'goals', 'constraints', 'preferences', 'projects')
            ),
            CONSTRAINT user_context_confidence_chk CHECK (
                confidence IS NULL OR (confidence >= 0.0 AND confidence <= 1.0)
            )
        )
        """
    )
    op.execute(
        """
        CREATE UNIQUE INDEX uq_user_context_user_cat_key
            ON eidan.user_context (user_id, category, key)
            WHERE deleted_at IS NULL
        """
    )
    op.execute(
        """
        CREATE INDEX idx_user_context_user_category
            ON eidan.user_context (user_id, category)
            WHERE deleted_at IS NULL
        """
    )
    op.execute(
        """
        CREATE TRIGGER trg_user_context_updated_at
        BEFORE UPDATE ON eidan.user_context
        FOR EACH ROW EXECUTE FUNCTION eidan.set_updated_at()
        """
    )

    # 3. conversations — FKs agent_context.
    op.execute(
        """
        CREATE TABLE eidan.conversations (
            id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
            user_id         uuid        NOT NULL
                                        REFERENCES eidan.users(id)
                                        ON DELETE CASCADE,
            title           text,
            agent_id        uuid        REFERENCES eidan.agent_context(id)
                                        ON DELETE SET NULL,
            metadata        jsonb       NOT NULL DEFAULT '{}'::jsonb,
            created_at      timestamptz NOT NULL DEFAULT now(),
            updated_at      timestamptz NOT NULL DEFAULT now(),
            deleted_at      timestamptz
        )
        """
    )
    op.execute(
        """
        CREATE INDEX idx_conversations_user_recent
            ON eidan.conversations (user_id, created_at DESC)
            WHERE deleted_at IS NULL
        """
    )
    op.execute(
        """
        CREATE INDEX idx_conversations_agent
            ON eidan.conversations (agent_id)
            WHERE deleted_at IS NULL
        """
    )
    op.execute(
        """
        CREATE TRIGGER trg_conversations_updated_at
        BEFORE UPDATE ON eidan.conversations
        FOR EACH ROW EXECUTE FUNCTION eidan.set_updated_at()
        """
    )

    # 4. messages — FKs conversations, agent_context, self.
    op.execute(
        """
        CREATE TABLE eidan.messages (
            id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
            user_id             uuid        NOT NULL
                                            REFERENCES eidan.users(id)
                                            ON DELETE CASCADE,
            conversation_id     uuid        NOT NULL
                                            REFERENCES eidan.conversations(id)
                                            ON DELETE CASCADE,
            parent_message_id   uuid        REFERENCES eidan.messages(id)
                                            ON DELETE SET NULL,
            agent_id            uuid        REFERENCES eidan.agent_context(id)
                                            ON DELETE SET NULL,
            role                text        NOT NULL,
            content             text,
            tool_calls          jsonb       NOT NULL DEFAULT '[]'::jsonb,
            tool_results        jsonb       NOT NULL DEFAULT '[]'::jsonb,
            provider            text,
            model               text,
            metadata            jsonb       NOT NULL DEFAULT '{}'::jsonb,
            created_at          timestamptz NOT NULL DEFAULT now(),
            deleted_at          timestamptz,
            CONSTRAINT messages_role_chk CHECK (
                role IN ('user', 'assistant', 'system', 'tool')
            )
        )
        """
    )
    op.execute(
        """
        CREATE INDEX idx_messages_conversation_created
            ON eidan.messages (conversation_id, created_at)
            WHERE deleted_at IS NULL
        """
    )
    op.execute(
        """
        CREATE INDEX idx_messages_parent
            ON eidan.messages (parent_message_id)
            WHERE parent_message_id IS NOT NULL
        """
    )
    op.execute(
        """
        CREATE INDEX idx_messages_user_recent
            ON eidan.messages (user_id, created_at DESC)
            WHERE deleted_at IS NULL
        """
    )
    op.execute(
        """
        CREATE INDEX idx_messages_agent_recent
            ON eidan.messages (agent_id, created_at DESC)
            WHERE agent_id IS NOT NULL AND deleted_at IS NULL
        """
    )

    # 5. llm_calls — FKs conversations, messages, agent_context. Immutable.
    op.execute(
        """
        CREATE TABLE eidan.llm_calls (
            id                    uuid           PRIMARY KEY DEFAULT gen_random_uuid(),
            user_id               uuid           NOT NULL
                                                 REFERENCES eidan.users(id)
                                                 ON DELETE CASCADE,
            conversation_id       uuid           REFERENCES eidan.conversations(id)
                                                 ON DELETE SET NULL,
            message_id            uuid           REFERENCES eidan.messages(id)
                                                 ON DELETE SET NULL,
            agent_id              uuid           REFERENCES eidan.agent_context(id)
                                                 ON DELETE SET NULL,
            role                  text           NOT NULL,
            provider              text           NOT NULL,
            model                 text           NOT NULL,
            input_tokens          integer        NOT NULL DEFAULT 0,
            output_tokens         integer        NOT NULL DEFAULT 0,
            cache_read_tokens     integer        NOT NULL DEFAULT 0,
            cache_creation_tokens integer        NOT NULL DEFAULT 0,
            cost_usd              numeric(12, 6) NOT NULL DEFAULT 0,
            latency_ms            integer,
            error                 text,
            error_type            text,
            started_at            timestamptz    NOT NULL,
            finished_at           timestamptz,
            request_id            text,
            metadata              jsonb          NOT NULL DEFAULT '{}'::jsonb,
            created_at            timestamptz    NOT NULL DEFAULT now(),
            CONSTRAINT llm_calls_role_chk CHECK (
                role IN ('primary', 'subagent', 'summariser', 'tool_synthesis', 'embed', 'other')
            ),
            CONSTRAINT llm_calls_tokens_chk CHECK (
                input_tokens >= 0
                AND output_tokens >= 0
                AND cache_read_tokens >= 0
                AND cache_creation_tokens >= 0
            )
        )
        """
    )
    op.execute(
        """
        CREATE INDEX idx_llm_calls_user_created
            ON eidan.llm_calls (user_id, created_at DESC)
        """
    )
    op.execute(
        """
        CREATE INDEX idx_llm_calls_conversation
            ON eidan.llm_calls (conversation_id, created_at)
            WHERE conversation_id IS NOT NULL
        """
    )
    op.execute(
        """
        CREATE INDEX idx_llm_calls_message
            ON eidan.llm_calls (message_id)
            WHERE message_id IS NOT NULL
        """
    )
    op.execute(
        """
        CREATE INDEX idx_llm_calls_provider_model_created
            ON eidan.llm_calls (provider, model, created_at DESC)
        """
    )
    op.execute(
        """
        CREATE INDEX idx_llm_calls_errors
            ON eidan.llm_calls (user_id, created_at DESC)
            WHERE error IS NOT NULL
        """
    )


def downgrade() -> None:
    op.execute("DROP TABLE IF EXISTS eidan.llm_calls")
    op.execute("DROP TABLE IF EXISTS eidan.messages")
    op.execute("DROP TABLE IF EXISTS eidan.conversations")
    op.execute("DROP TABLE IF EXISTS eidan.user_context")
    op.execute("DROP TABLE IF EXISTS eidan.agent_context")
