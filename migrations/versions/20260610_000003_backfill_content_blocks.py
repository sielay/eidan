# SPDX-License-Identifier: AGPL-3.0-or-later
"""eidan.messages — backfill content_blocks for pre-matbot rows

Revision ID: 20260610000003
Revises: 20260610000002
Create Date: 2026-06-10

The matbot backend (@eidandev/storage-postgres) reads a message's content from
``content_blocks`` (the lossless matbot MessageContent[] array). Rows written by
the Python backend before the pivot have ``content_blocks = '[]'`` with their
content in the legacy columns. This backfills them so historical conversations
render through the matbot runtime:

  - content (text)                              -> {type:'text', text}
  - tool_calls {id,name,input}                  -> {type:'tool-call', id, name, input}
  - tool_results {tool_use_id,content,is_error} -> {type:'tool-result', id, result, isError}

Idempotent: only rows whose content_blocks is still '[]' are touched; matbot-era
rows already carry content_blocks and are skipped. Data-only — no-op downgrade.
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op

revision: str = "20260610000003"
down_revision: str | None = "20260610000002"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute(
        """
        UPDATE eidan.messages SET content_blocks = (
          (CASE WHEN content IS NOT NULL AND content <> ''
                THEN jsonb_build_array(jsonb_build_object('type','text','text',content))
                ELSE '[]'::jsonb END)
          || COALESCE((SELECT jsonb_agg(jsonb_build_object(
                'type','tool-call','id',e->>'id','name',e->>'name','input',e->'input'))
              FROM jsonb_array_elements(tool_calls) e), '[]'::jsonb)
          || COALESCE((SELECT jsonb_agg(jsonb_build_object(
                'type','tool-result','id',e->>'tool_use_id','result',e->>'content',
                'isError',(e->>'is_error')::boolean))
              FROM jsonb_array_elements(tool_results) e), '[]'::jsonb)
        )
        WHERE content_blocks = '[]'::jsonb AND deleted_at IS NULL
          AND (content IS NOT NULL AND content <> ''
               OR jsonb_array_length(tool_calls) > 0
               OR jsonb_array_length(tool_results) > 0)
        """
    )


def downgrade() -> None:
    # Data backfill — no-op downgrade (cannot distinguish backfilled blocks from
    # natively-written matbot blocks).
    pass
