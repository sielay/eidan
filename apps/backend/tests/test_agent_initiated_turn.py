"""Tests for the agent-initiated turn seam (audit §10 + §9 fix).

`run_agent_initiated_turn` builds a synthetic identity, makes (or
reuses) a conversation, and delegates to `run_turn`. The seam is
how Sentry / cron / schedule-triggered behaviours spawn a turn
without an inbound user JWT.

Two halves:

- :meth:`Identity.synthetic_for_agent` shape check — the synthetic
  identity carries the marker tools / route handlers read to
  distinguish agent-initiated calls from real-user requests.
- End-to-end via the in-memory FakePool / FakeProvider — confirms
  the new turn lands a user-message row + an assistant-message row
  + at least one llm_calls row under a fresh conversation_id.
"""

from __future__ import annotations

import json
from uuid import UUID, uuid4

import pytest
from eidan_backend.identity import Actor, Identity
from eidan_backend.loop import (
    ConversationAccessError,
    TurnComplete,
    run_agent_initiated_turn,
)
from eidan_backend.providers.base import AssistantChunk

from .conftest import (
    FakePool,
    FakeProvider,
    FakeStore,
    ScriptedTurn,
)


def test_synthetic_identity_shape() -> None:
    user_id = "11111111-1111-1111-1111-111111111111"
    identity = Identity.synthetic_for_agent(user_id, agent_name="sentry")
    assert identity.user_id == user_id
    assert identity.aal == "agent"
    assert identity.email is None
    assert identity.session_id is None
    assert identity.raw_claims["synthetic"] is True
    assert identity.raw_claims["agent_name"] == "sentry"
    assert identity.raw_claims["sub"] == user_id


def test_synthetic_identity_carries_email_when_given() -> None:
    identity = Identity.synthetic_for_agent(
        "u-1", agent_name="sentry", email="op@example.test"
    )
    assert identity.email == "op@example.test"


@pytest.mark.asyncio
async def test_run_agent_initiated_turn_drives_full_pipeline() -> None:
    """The seam wraps :func:`run_turn` — every classifier, sizer,
    intent, and primary call still runs. The test scripts the
    minimum sequence the loop expects."""
    provider = FakeProvider(
        [
            ScriptedTurn(text='["chitchat"]'),       # scope
            ScriptedTurn(text="claude-sonnet-4-6"),  # sizer
            ScriptedTurn(text='{"actions": []}'),    # intent
            ScriptedTurn(text="agent-initiated reply"),  # primary
        ]
    )
    store = FakeStore()
    pool = FakePool(store)
    user_id = UUID("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1")

    chunks: list[str] = []
    completion: TurnComplete | None = None
    async for event in run_agent_initiated_turn(
        pool=pool,  # type: ignore[arg-type]
        provider=provider,  # type: ignore[arg-type]
        model="claude-sonnet-4-6",
        user_id=user_id,
        agent_name="sentry",
        prompt_text="[sentry] anything to surface?",
        user_tz="UTC",
    ):
        if isinstance(event, AssistantChunk):
            chunks.append(event.text)
        elif isinstance(event, TurnComplete):
            completion = event

    assert completion is not None
    assert "agent-initiated reply" in chunks
    # The seam should have created a conversation row. ``create_conversation``
    # uses ``conn.fetchrow`` (the INSERT carries a RETURNING id clause)
    # rather than ``conn.execute``, so the assertion targets the
    # fetchrows recorder.
    conv_inserts = [
        sql
        for sql, _ in store.fetchrows
        if "INSERT INTO eidan.conversations" in sql
    ]
    assert len(conv_inserts) == 1


@pytest.mark.asyncio
async def test_run_agent_initiated_turn_reuses_existing_conversation() -> None:
    """When the caller passes ``conversation_id`` the seam doesn't
    create a new conversation — Sentry's "agent log" conversation
    pattern relies on this."""
    provider = FakeProvider(
        [
            ScriptedTurn(text='["chitchat"]'),
            ScriptedTurn(text="claude-sonnet-4-6"),
            ScriptedTurn(text='{"actions": []}'),
            ScriptedTurn(text="reply"),
        ]
    )
    store = FakeStore()
    pool = FakePool(store)
    user_id = UUID("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa2")
    pinned_conv = uuid4()
    # The caller owns the pinned conversation — the #184 ownership guard
    # checks this before reusing it.
    store.owned_conversations.add((pinned_conv, user_id))

    async for _ in run_agent_initiated_turn(
        pool=pool,  # type: ignore[arg-type]
        provider=provider,  # type: ignore[arg-type]
        model="claude-sonnet-4-6",
        user_id=user_id,
        agent_name="sentry",
        prompt_text="prompt",
        conversation_id=pinned_conv,
    ):
        pass

    conv_inserts = [
        sql
        for sql, _ in store.executes
        if "INSERT INTO eidan.conversations" in sql
    ]
    assert conv_inserts == [], "should not create a new conversation when one is supplied"


@pytest.mark.asyncio
async def test_run_agent_initiated_turn_rejects_unowned_conversation() -> None:
    """#184 ownership guard: supplying a conversation_id the user does not
    own raises ConversationAccessError before any provider work — an
    agent must not be able to land a turn in another operator's thread."""
    provider = FakeProvider([])  # never reached — guard fires first
    store = FakeStore()
    pool = FakePool(store)
    user_id = UUID("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa3")
    foreign_conv = uuid4()  # deliberately NOT seeded as owned

    with pytest.raises(ConversationAccessError):
        async for _ in run_agent_initiated_turn(
            pool=pool,  # type: ignore[arg-type]
            provider=provider,  # type: ignore[arg-type]
            model="claude-sonnet-4-6",
            user_id=user_id,
            agent_name="sentry",
            prompt_text="prompt",
            conversation_id=foreign_conv,
        ):
            pass

    # No conversation INSERT, no message writes — the guard short-circuits.
    assert not [
        sql for sql, _ in store.executes if "INTO eidan.conversations" in sql
    ]


def _seed_message_metadata(store: FakeStore) -> dict:
    """The metadata jsonb of the single inbound user message the turn
    wrote. insert_user_message positions metadata at arg index 4
    ($5::jsonb)."""
    user_inserts = [
        args
        for sql, args in store.executes
        if "INTO eidan.messages" in sql and "'user'" in sql
    ]
    assert len(user_inserts) == 1
    return json.loads(user_inserts[0][4])


def test_actor_as_metadata() -> None:
    assert Actor(kind="turn", ref="abc").as_metadata() == {
        "kind": "turn",
        "ref": "abc",
    }


@pytest.mark.asyncio
async def test_agent_initiated_turn_stamps_initiated_by_provenance() -> None:
    """#184/#187: the seed message records WHAT initiated the turn —
    defaulting to the agent — as provenance metadata, alongside the
    loop's own keys. on_behalf_of stays the user_id; initiated_by is
    provenance-only."""
    provider = FakeProvider(
        [
            ScriptedTurn(text='["chitchat"]'),
            ScriptedTurn(text="claude-sonnet-4-6"),
            ScriptedTurn(text='{"actions": []}'),
            ScriptedTurn(text="ok"),
        ]
    )
    store = FakeStore()
    pool = FakePool(store)
    user_id = UUID("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa4")

    async for _ in run_agent_initiated_turn(
        pool=pool,  # type: ignore[arg-type]
        provider=provider,  # type: ignore[arg-type]
        model="claude-sonnet-4-6",
        user_id=user_id,
        agent_name="sentry",
        prompt_text="anything to surface?",
    ):
        pass

    meta = _seed_message_metadata(store)
    assert meta["initiated_by"] == {"kind": "agent", "ref": "sentry"}
    # the loop's authoritative keys survive the merge
    assert "sent_at_utc" in meta
    assert "user_tz" in meta


@pytest.mark.asyncio
async def test_agent_initiated_turn_accepts_explicit_actor() -> None:
    """A caller can override the initiator — e.g. the user who scheduled
    the work, or a chain link — without affecting on_behalf_of."""
    provider = FakeProvider(
        [
            ScriptedTurn(text='["chitchat"]'),
            ScriptedTurn(text="claude-sonnet-4-6"),
            ScriptedTurn(text='{"actions": []}'),
            ScriptedTurn(text="ok"),
        ]
    )
    store = FakeStore()
    pool = FakePool(store)
    user_id = UUID("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa5")

    async for _ in run_agent_initiated_turn(
        pool=pool,  # type: ignore[arg-type]
        provider=provider,  # type: ignore[arg-type]
        model="claude-sonnet-4-6",
        user_id=user_id,
        agent_name="sentry",
        prompt_text="x",
        initiated_by=Actor(kind="user", ref=str(user_id)),
    ):
        pass

    meta = _seed_message_metadata(store)
    assert meta["initiated_by"] == {"kind": "user", "ref": str(user_id)}
