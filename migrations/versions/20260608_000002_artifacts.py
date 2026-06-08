# SPDX-License-Identifier: AGPL-3.0-or-later
"""eidan.artifacts — agent-produced downloadable files (binary artifacts)

Revision ID: 20260608000002
Revises: 20260608000001
Create Date: 2026-06-08

Issue #252. A generic primitive: a plugin tool produces *bytes* (a
rendered document, an export, a generated image) and hands them back as a
downloadable artifact. Metadata lives here in ``eidan.artifacts`` (indexed,
RLS-ready, user-scoped); the bytes live in a pluggable store behind one
S3-shaped interface (Supabase Storage / S3 / R2 / MinIO).

``eidan.artifact_blobs`` is the **zero-dependency default backend** — bytes
in Postgres ``bytea``, multi-instance-safe (one source of truth) and
one-click-export friendly (the own-your-data promise). An S3-backed deploy
leaves this table unused: the bytes live in the bucket, keyed by
``storage_key``. The blob row CASCADE-deletes with its artifact, so there
are no orphaned bytes (a sharp edge in the prior-art we deliberately fix).
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op

revision: str = "20260608000002"
down_revision: str | None = "20260608000001"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute(
        """
        CREATE TABLE eidan.artifacts (
            id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
            -- owner: whose data this is; cost/RLS follow this (docs/028).
            user_id         uuid        NOT NULL REFERENCES eidan.users(id) ON DELETE CASCADE,
            -- where it was produced (nullable: a cron/system artifact has neither).
            conversation_id uuid        REFERENCES eidan.conversations(id) ON DELETE SET NULL,
            message_id      uuid        REFERENCES eidan.messages(id) ON DELETE CASCADE,
            -- artifact class, set by the producing tool: 'deck'|'pdf'|'report'|…
            kind            text        NOT NULL,
            mime_type       text        NOT NULL,
            filename        text        NOT NULL,
            size_bytes      bigint      NOT NULL,
            -- opaque key the storage backend resolves. For the postgres
            -- backend this is the artifact id; for S3 it's '{user_id}/{id}'.
            storage_key     text        NOT NULL,
            metadata        jsonb       NOT NULL DEFAULT '{}'::jsonb,
            created_by      text        NOT NULL DEFAULT 'agent'
                            CHECK (created_by IN ('user','agent')),
            created_at      timestamptz NOT NULL DEFAULT now(),
            updated_at      timestamptz NOT NULL DEFAULT now(),
            deleted_at      timestamptz
        )
        """
    )
    # Recent-first listing per owner (the memory browser / file panel read
    # path), live rows only — partial on the soft-delete predicate (003 §1.3).
    op.execute(
        """
        CREATE INDEX idx_artifacts_user_recent
            ON eidan.artifacts (user_id, created_at DESC)
            WHERE deleted_at IS NULL
        """
    )
    # "What did this message produce?" — the download-chip lookup.
    op.execute(
        """
        CREATE INDEX idx_artifacts_message
            ON eidan.artifacts (message_id)
            WHERE deleted_at IS NULL
        """
    )
    op.execute(
        """
        CREATE TRIGGER trg_artifacts_updated_at
        BEFORE UPDATE ON eidan.artifacts
        FOR EACH ROW EXECUTE FUNCTION eidan.set_updated_at()
        """
    )

    # Zero-dependency default storage backend (bytea). Unused by S3 deploys.
    # CASCADE on the artifact FK guarantees no orphaned bytes.
    op.execute(
        """
        CREATE TABLE eidan.artifact_blobs (
            artifact_id uuid PRIMARY KEY
                        REFERENCES eidan.artifacts(id) ON DELETE CASCADE,
            data        bytea NOT NULL
        )
        """
    )


def downgrade() -> None:
    op.execute("DROP TABLE IF EXISTS eidan.artifact_blobs")
    op.execute("DROP TABLE IF EXISTS eidan.artifacts")
