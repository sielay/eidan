"""init eidan.knowledge_links + eidan.knowledge.slug column

Revision ID: 20260519000003
Revises: 20260519000002
Create Date: 2026-05-19

Phase 1 lands the structural half of docs/017: the adjacency table
that records wikilink + knowledge:// references inside a knowledge
body, plus the slug column on eidan.knowledge that the link
resolver targets.

Backfill of slug values for existing rows is intentionally deferred
— the column ships nullable so existing knowledge rows are
acceptable; a separate maintenance pass slugifies them on demand
once the operator wires the extractor into the learn plugin's
write path.
"""
from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "20260519000003"
down_revision: str | None = "20260519000002"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "knowledge",
        sa.Column("slug", sa.Text(), nullable=True),
        schema="eidan",
    )
    op.create_check_constraint(
        "knowledge_slug_chk",
        "knowledge",
        # `docs/017 §3.1` slug grammar — one or two segments,
        # lowercase alphanumeric + `_` / `-`, separated by a single `/`.
        "slug IS NULL OR slug ~ "
        "'^[a-z0-9][a-z0-9_-]*(/[a-z0-9][a-z0-9_-]*)?$'",
        schema="eidan",
    )
    op.execute(
        """
        CREATE UNIQUE INDEX uq_knowledge_user_slug
          ON eidan.knowledge (user_id, slug)
          WHERE deleted_at IS NULL
            AND slug IS NOT NULL
        """
    )

    op.create_table(
        "knowledge_links",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column("user_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column(
            "from_knowledge_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("eidan.knowledge.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "to_knowledge_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("eidan.knowledge.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("to_slug", sa.Text(), nullable=False),
        sa.Column("link_type", sa.Text(), nullable=False),
        sa.Column("position_offset", sa.Integer(), nullable=False),
        sa.Column("surrounding_context", sa.Text(), nullable=False),
        sa.Column(
            "created_at",
            postgresql.TIMESTAMP(timezone=True),
            nullable=False,
            server_default=sa.text("CURRENT_TIMESTAMP"),
        ),
        sa.CheckConstraint(
            "link_type IN ('wikilink','markdown')",
            name="knowledge_links_link_type_chk",
        ),
        sa.CheckConstraint(
            "position_offset >= 0",
            name="knowledge_links_offset_chk",
        ),
        schema="eidan",
    )
    op.create_index(
        "idx_knowledge_links_from",
        "knowledge_links",
        ["from_knowledge_id", "position_offset"],
        schema="eidan",
    )
    op.execute(
        """
        CREATE INDEX idx_knowledge_links_to
          ON eidan.knowledge_links (to_knowledge_id)
          WHERE to_knowledge_id IS NOT NULL
        """
    )
    op.execute(
        """
        CREATE INDEX idx_knowledge_links_to_slug_unresolved
          ON eidan.knowledge_links (user_id, to_slug)
          WHERE to_knowledge_id IS NULL
        """
    )
    op.create_index(
        "idx_knowledge_links_user_created",
        "knowledge_links",
        ["user_id", sa.text("created_at DESC")],
        schema="eidan",
    )


def downgrade() -> None:
    op.drop_index(
        "idx_knowledge_links_user_created",
        table_name="knowledge_links",
        schema="eidan",
    )
    op.drop_index(
        "idx_knowledge_links_to_slug_unresolved",
        table_name="knowledge_links",
        schema="eidan",
    )
    op.drop_index(
        "idx_knowledge_links_to", table_name="knowledge_links", schema="eidan"
    )
    op.drop_index(
        "idx_knowledge_links_from",
        table_name="knowledge_links",
        schema="eidan",
    )
    op.drop_table("knowledge_links", schema="eidan")

    op.execute("DROP INDEX IF EXISTS eidan.uq_knowledge_user_slug")
    op.drop_constraint(
        "knowledge_slug_chk", "knowledge", schema="eidan", type_="check"
    )
    op.drop_column("knowledge", "slug", schema="eidan")
