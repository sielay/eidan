# SPDX-License-Identifier: AGPL-3.0-or-later
"""User lookup-or-mint by email (`docs/011 §17`).

The Supabase-backed flow used Supabase's ``auth.users`` table to
mint UUIDs and Eidan's ``persistence.upsert_user`` to mirror them
into ``eidan.users``. Native auth has no upstream — the verify
endpoint mints a fresh UUID on first login and inserts straight
into ``eidan.users``.

This module owns that lookup-or-create-by-email logic, separate
from :mod:`eidan_backend.persistence` so the existing
``upsert_user(user_id, email)`` signature (used by the Supabase
path during the transition) stays untouched.
"""

from __future__ import annotations

from typing import Any
from uuid import UUID, uuid4


async def ensure_user_by_email(conn: Any, *, email: str) -> UUID:
    """Resolve ``email`` to the canonical ``eidan.users.id`` UUID,
    minting a row if none exists.

    Returns the UUID. The email is lower-cased before lookup so
    ``Operator@Example.com`` and ``operator@example.com`` resolve
    to the same row (RFC 5321 §2.4 says the local-part may be
    case-sensitive but in practice everyone treats it as not).

    Concurrency: ``ON CONFLICT (email)`` makes this safe across
    parallel logins from different devices on first start — both
    end up reading the winner's row via the follow-up SELECT.
    """
    normalised = email.strip().lower()
    new_id = uuid4()
    await conn.execute(
        """
        INSERT INTO eidan.users (id, email)
        VALUES ($1, $2)
        ON CONFLICT (email) DO NOTHING
        """,
        new_id,
        normalised,
    )
    row = await conn.fetchrow(
        "SELECT id FROM eidan.users WHERE email = $1",
        normalised,
    )
    assert row is not None, "eidan.users row missing after upsert"
    return row["id"]


__all__ = ["ensure_user_by_email"]
