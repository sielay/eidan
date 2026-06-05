# SPDX-License-Identifier: AGPL-3.0-or-later
"""Sub-conversations (#185).

`eidan.conversations` gains a parent linkage so fanned-out / long-running
sub-work gets its own child conversation instead of flooding the
originating thread. Children are navigable (queryable by parent and by
the originating message) but NOT message forks — they live in their own
conversation, not inlined in the parent's message stream.

DB-backed (the `eidan_db` migrated-Postgres fixture), so these exercise
the real migration + FKs + partial indexes.
"""

from __future__ import annotations

from uuid import UUID

import pytest
from eidan_backend.db import create_pool
from eidan_backend.persistence import (
    create_conversation,
    insert_user_message,
    list_child_conversations,
    list_child_conversations_for_message,
    upsert_user,
)

from .conftest import build_identity


@pytest.mark.asyncio
async def test_child_conversation_links_and_queries(eidan_db: str) -> None:
    identity = build_identity()
    user_uuid = UUID(identity.user_id)

    pool = await create_pool(eidan_db)
    try:
        async with pool.acquire() as conn:
            await upsert_user(conn, user_id=user_uuid, email=identity.email)

            parent = await create_conversation(
                conn, user_id=user_uuid, title="parent"
            )
            # A message in the parent that "spawns" the child sub-task.
            origin_msg = await insert_user_message(
                conn,
                user_id=user_uuid,
                conversation_id=parent,
                content="go research this in a sub-task",
            )

            child = await create_conversation(
                conn,
                user_id=user_uuid,
                title="child",
                parent_conversation_id=parent,
                origin_message_id=origin_msg,
            )

            # Queryable by parent conversation.
            by_parent = await list_child_conversations(
                conn, parent_conversation_id=parent, user_id=user_uuid
            )
            assert [r["id"] for r in by_parent] == [child]
            assert by_parent[0]["parent_conversation_id"] == parent
            assert by_parent[0]["origin_message_id"] == origin_msg

            # Queryable by the originating message.
            by_msg = await list_child_conversations_for_message(
                conn, origin_message_id=origin_msg, user_id=user_uuid
            )
            assert [r["id"] for r in by_msg] == [child]

            # The child itself has no children — the tree is one level here.
            assert (
                await list_child_conversations(
                    conn, parent_conversation_id=child, user_id=user_uuid
                )
                == []
            )
    finally:
        await pool.close()


@pytest.mark.asyncio
async def test_root_conversation_has_null_linkage(eidan_db: str) -> None:
    """A conversation created without linkage is a root — both FKs NULL.
    Confirms existing rows / the default path stay valid."""
    identity = build_identity()
    user_uuid = UUID(identity.user_id)

    pool = await create_pool(eidan_db)
    try:
        async with pool.acquire() as conn:
            await upsert_user(conn, user_id=user_uuid, email=identity.email)
            root = await create_conversation(
                conn, user_id=user_uuid, title="root"
            )
            row = await conn.fetchrow(
                """
                SELECT parent_conversation_id, origin_message_id
                FROM eidan.conversations
                WHERE id = $1
                """,
                root,
            )
            assert row["parent_conversation_id"] is None
            assert row["origin_message_id"] is None
    finally:
        await pool.close()
