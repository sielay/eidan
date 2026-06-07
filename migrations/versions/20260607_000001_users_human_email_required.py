# SPDX-License-Identifier: AGPL-3.0-or-later
"""require an email on human users — close the NULL-email duplicate-identity gap

Revision ID: 20260607000001
Revises: 20260605000003
Create Date: 2026-06-07

Issue #241. ``eidan.users`` has ``UNIQUE (email)``, but Postgres treats
``NULL`` as distinct under a unique constraint, so multiple
``kind='human'`` rows with ``email IS NULL`` can coexist. Any path that
inserts a human user without an email then escapes
``ensure_user_by_email``'s ``ON CONFLICT (email) DO NOTHING`` dedup —
each such login mints a fresh row, scattering one operator's data across
several ``user_id``s (observed in practice during the Supabase→native
auth transition, where the first-sight ``upsert_user`` keyed on the JWT
``sub`` with an absent email claim).

This adds the missing invariant: a **human** user must carry an email.
``agent`` / ``system`` service accounts (``docs/028 §3``) are provisioned
host-side and never log in, so they may keep ``email IS NULL`` —
the constraint only binds ``kind = 'human'``.

Additive + reversible. Validates cleanly: no human row may have a NULL
email at apply time (the auth surface always supplies one via
``ensure_user_by_email``; the legacy NULL-email rows were a transition
artefact).
"""
from __future__ import annotations

from collections.abc import Sequence

from alembic import op

revision: str = "20260607000001"
down_revision: str | None = "20260605000003"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute(
        """
        ALTER TABLE eidan.users
            ADD CONSTRAINT users_human_email_required
            CHECK (kind <> 'human' OR email IS NOT NULL)
        """
    )


def downgrade() -> None:
    op.execute(
        "ALTER TABLE eidan.users DROP CONSTRAINT IF EXISTS users_human_email_required"
    )
