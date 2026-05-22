"""End-to-end smoke for the agentic loop against a real Postgres.

Per the Phase 1.5 testing brief, this is the gate that runs before any
PR lands: wipe a DB, apply every migration, drive one turn through
``run_turn`` against a stubbed provider, then read the persisted rows
back and assert the FKs hang together. The stub never talks to
Anthropic so the test runs without credentials.
"""

from __future__ import annotations

from uuid import UUID

import pytest
from eidan_backend.db import create_pool
from eidan_backend.loop import TurnComplete, TurnContext, run_turn
from eidan_backend.persistence import create_conversation, upsert_user
from eidan_backend.providers.base import AssistantChunk

from .conftest import TZ_TEST_KWARGS, ScriptedTurn, build_identity


@pytest.mark.asyncio
async def test_phase1_smoke_writes_a_coherent_turn(
    eidan_db: str, stub_provider
) -> None:
    identity = build_identity()
    user_uuid = UUID(identity.user_id)

    provider = stub_provider(
        [
            # ③ scope classifier — returns one valid skill so parsing succeeds
            ScriptedTurn(text='["chitchat"]'),
            # ④ sizer — names a real model so the primary call uses it
            ScriptedTurn(text="claude-sonnet-4-6"),
            # ④.5 intent classifier — chitchat has no actions to enumerate
            ScriptedTurn(text='{"actions": []}'),
            # ⑥ primary — text-only reply; no tool_use, so the loop exits
            #             after one iteration. The reply text is crafted to
            #             dodge the Phase 1.5 failure detector heuristics
            #             (refusal / echo / empty / loop_exhausted).
            ScriptedTurn(
                text="The smoke test completed end-to-end against Postgres."
            ),
        ]
    )

    pool = await create_pool(eidan_db)
    try:
        # Pre-seed the user + conversation row. The loop upserts the user
        # itself, but it needs a conversation to FK into.
        async with pool.acquire() as conn:
            await upsert_user(conn, user_id=user_uuid, email=identity.email)
            conversation_id = await create_conversation(
                conn, user_id=user_uuid, title="smoke"
            )

        ctx = TurnContext(identity=identity, conversation_id=conversation_id)

        completion: TurnComplete | None = None
        text_chunks: list[str] = []
        async for event in run_turn(
            pool=pool,
            provider=provider,
            model="claude-sonnet-4-6",
            ctx=ctx,
            user_text="hello, smoke test",
            **TZ_TEST_KWARGS,
        ):
            if isinstance(event, TurnComplete):
                completion = event
            elif isinstance(event, AssistantChunk):
                text_chunks.append(event.text)

        assert completion is not None
        assert "smoke test completed" in "".join(text_chunks)

        async with pool.acquire() as conn:
            messages = await conn.fetch(
                """
                SELECT id, role, content, parent_message_id, conversation_id, user_id
                FROM eidan.messages
                WHERE conversation_id = $1
                ORDER BY created_at ASC
                """,
                conversation_id,
            )
            llm_calls = await conn.fetch(
                """
                SELECT id, role, message_id, conversation_id, user_id,
                       provider, model
                FROM eidan.llm_calls
                WHERE conversation_id = $1
                ORDER BY created_at ASC
                """,
                conversation_id,
            )
    finally:
        await pool.close()

    # One user turn, one assistant turn — no tool turn, no critic row
    # (the scripted reply avoids every failure-detector heuristic).
    user_messages = [m for m in messages if m["role"] == "user"]
    assistant_messages = [m for m in messages if m["role"] == "assistant"]
    assert len(user_messages) == 1
    assert len(assistant_messages) == 1

    user_msg = user_messages[0]
    asst_msg = assistant_messages[0]

    assert user_msg["content"] == "hello, smoke test"
    assert user_msg["conversation_id"] == conversation_id
    assert user_msg["user_id"] == user_uuid

    # The assistant turn parents the inbound user turn — that's how the
    # loop wires them per `docs/005 §1.1`.
    assert asst_msg["parent_message_id"] == user_msg["id"]
    assert asst_msg["id"] == completion.assistant_message_id
    assert user_msg["id"] == completion.user_message_id
    assert "smoke test completed" in asst_msg["content"]

    # Four llm_calls rows per turn since #59 added the intent classifier:
    # scope_classifier → sizer → intent_classifier → primary. Each is
    # attributed to the inbound user message so the whole turn can be
    # reassembled from telemetry alone.
    roles = [row["role"] for row in llm_calls]
    assert roles == ["scope_classifier", "sizer", "intent_classifier", "primary"]
    for row in llm_calls:
        assert row["message_id"] == user_msg["id"]
        assert row["conversation_id"] == conversation_id
        assert row["user_id"] == user_uuid
        assert row["provider"] == "fake"
