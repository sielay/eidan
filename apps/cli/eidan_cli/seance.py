"""Predecessor-session lookup — `docs/023`.

One-shot mode: load a named conversation's transcript and ask the
provider a question about it. Prints the answer to stdout; persists
one ``llm_calls`` row with ``role='other'`` and
``metadata.kind='seance'`` so the call attributes back to the
operator's budget without inventing a new role enum (a dedicated
``seance`` role can land alongside the docs/023 §1 vocab once it's
pinned).

The implementation is deliberately small. The summariser-driven
context-bundle from §2.1 is reserved for the follow-up; the MVP
sends the trailing N messages verbatim with a header that explains
the seance pattern to the model.
"""

from __future__ import annotations

import asyncio
import os
import sys
from uuid import UUID

# Cap on how many trailing messages to send into the seance call.
# The summariser-pass from docs/023 §2.1 supersedes this once it
# lands; for now the operator gets the most recent N as a hard
# truncate.
_TRANSCRIPT_TAIL = 40


def _need_database_url() -> str:
    url = os.environ.get("DATABASE_URL")
    if not url:
        print(
            "DATABASE_URL is not set. The seance command reads it from "
            "the environment to load prior conversations.",
            file=sys.stderr,
        )
        raise SystemExit(2)
    return url


def _need_anthropic_key() -> str:
    key = os.environ.get("ANTHROPIC_API_KEY")
    if not key:
        print(
            "ANTHROPIC_API_KEY is not set. The seance command makes one "
            "provider call to answer your question.",
            file=sys.stderr,
        )
        raise SystemExit(2)
    return key


def seance_list(*, email: str | None, limit: int = 20) -> int:
    """`eidan seance --list` — print the operator's recent conversations.

    Returns 0 with one ``id  title  updated_at`` line per row.
    """
    return asyncio.run(_seance_list_async(email=email, limit=limit))


def seance_ask(
    *, conv: str, prompt: str, email: str | None
) -> int:
    """`eidan seance --conv <id> -p "<q>"` — answer ``prompt`` against
    the named conversation's transcript."""
    if prompt == "-":
        prompt = sys.stdin.read().strip()
        if not prompt:
            print("seance: empty prompt on stdin.", file=sys.stderr)
            return 2
    try:
        conv_uuid = UUID(conv)
    except ValueError:
        print(
            f"seance: conv {conv!r} is not a valid UUID. "
            "Slug resolution lands with the docs/023 §1 vocab.",
            file=sys.stderr,
        )
        return 2
    return asyncio.run(_seance_ask_async(conv=conv_uuid, prompt=prompt, email=email))


async def _seance_list_async(*, email: str | None, limit: int) -> int:
    import asyncpg

    plain = _need_database_url().replace("postgresql+asyncpg://", "postgresql://", 1)
    conn = await asyncpg.connect(plain)
    try:
        user_id = await _resolve_user(conn, email=email)
        if user_id is None:
            return 1
        rows = await conn.fetch(
            """
            SELECT id, title, updated_at
            FROM eidan.conversations
            WHERE user_id = $1
              AND deleted_at IS NULL
            ORDER BY updated_at DESC
            LIMIT $2
            """,
            user_id,
            limit,
        )
    finally:
        await conn.close()
    if not rows:
        print("(no conversations found)")
        return 0
    for row in rows:
        title = row["title"] or "(untitled)"
        print(f"{row['id']}  {row['updated_at']:%Y-%m-%d %H:%M}  {title}")
    return 0


async def _seance_ask_async(
    *, conv: UUID, prompt: str, email: str | None
) -> int:
    import asyncpg
    from eidan_backend.persistence import insert_llm_call
    from eidan_backend.providers import AnthropicProvider
    from eidan_backend.providers.base import UserMessage

    plain = _need_database_url().replace("postgresql+asyncpg://", "postgresql://", 1)
    api_key = _need_anthropic_key()

    conn = await asyncpg.connect(plain)
    try:
        user_id = await _resolve_user(conn, email=email)
        if user_id is None:
            return 1
        owner = await conn.fetchval(
            """
            SELECT user_id
            FROM eidan.conversations
            WHERE id = $1 AND deleted_at IS NULL
            """,
            conv,
        )
        if owner is None:
            print(
                f"seance: conversation {conv} not found.",
                file=sys.stderr,
            )
            return 1
        if owner != user_id:
            print(
                f"seance: conversation {conv} does not belong to the "
                "resolved user.",
                file=sys.stderr,
            )
            return 1
        rows = await conn.fetch(
            """
            SELECT role, content
            FROM eidan.messages
            WHERE conversation_id = $1
              AND deleted_at IS NULL
              AND content IS NOT NULL
              AND role IN ('user','assistant')
            ORDER BY created_at ASC
            """,
            conv,
        )
    finally:
        await conn.close()

    transcript = _format_transcript(rows)
    provider = AnthropicProvider(api_key=api_key)
    system = (
        "You are answering a question about an earlier conversation. "
        "The transcript below is a verbatim trailing slice of that "
        "conversation. Read it, then answer the operator's question "
        "directly. Cite which turn(s) you drew from when relevant."
    )
    seance_prompt = f"Transcript:\n{transcript}\n\nQuestion: {prompt}"

    answer_chunks: list[str] = []
    async for chunk in provider.stream_turn(
        model="claude-haiku-4-5-20251001",
        messages=[UserMessage(role="user", content=seance_prompt)],
        system=system,
        max_tokens=2048,
    ):
        text = getattr(chunk, "text", "")
        if text:
            answer_chunks.append(text)
            sys.stdout.write(text)
            sys.stdout.flush()
    sys.stdout.write("\n")

    # One llm_calls row attributed to a fresh "anchor" user message id
    # — the seance call isn't part of any turn's message tree, so we
    # generate one and stamp metadata.kind='seance' for later audit.
    result = await provider.last_call_result()
    anchor_id = await _persist_seance_call(
        plain=plain,
        user_id=user_id,
        conversation_id=conv,
        prompt=prompt,
        result=result,
        insert_llm_call=insert_llm_call,
    )
    sys.stdout.write(f"\n[seance call recorded under message id {anchor_id}]\n")
    return 0


async def _persist_seance_call(
    *,
    plain: str,
    user_id: UUID,
    conversation_id: UUID,
    prompt: str,
    result,
    insert_llm_call,
):
    """Write the seance prompt as a user-role message under the
    consulted conversation and attach one llm_calls row with
    role='other' + metadata.kind='seance'.

    This treats the seance like a tool call per docs/023 §2.4:
    the prompt + answer become a record on the consulted
    conversation, not on whatever new conversation prompted the
    seance.
    """
    import asyncpg

    conn = await asyncpg.connect(plain)
    try:
        async with conn.transaction():
            await conn.execute(
                "SELECT set_config('eidan.current_user_id', $1, true)",
                str(user_id),
            )
            anchor_id = await conn.fetchval(
                """
                INSERT INTO eidan.messages
                    (user_id, conversation_id, role, content, metadata)
                VALUES
                    ($1, $2, 'user', $3,
                     '{"kind": "seance", "source": "cli"}'::jsonb)
                RETURNING id
                """,
                user_id,
                conversation_id,
                f"[seance] {prompt}",
            )
            await insert_llm_call(
                conn,
                user_id=user_id,
                conversation_id=conversation_id,
                message_id=anchor_id,
                role="other",
                result=result,
            )
    finally:
        await conn.close()
    return anchor_id


async def _resolve_user(conn, *, email: str | None):
    """Pick the eidan.users row to operate on.

    Mirrors apps/cli/eidan_cli/admin.py:_resolve_user_id but works
    over a plain asyncpg.Connection (no Identity / RLS session
    variables — seance is operator-level CLI).
    """
    if email is not None:
        row = await conn.fetchrow(
            "SELECT id FROM eidan.users WHERE email = $1", email
        )
        if row is None:
            print(
                f"seance: no user with email {email!r} in eidan.users.",
                file=sys.stderr,
            )
            return None
        return row["id"]
    rows = await conn.fetch("SELECT id, email FROM eidan.users LIMIT 2")
    if not rows:
        print("seance: no users in eidan.users yet.", file=sys.stderr)
        return None
    if len(rows) > 1:
        print(
            "seance: multiple users found; pass --email to disambiguate.",
            file=sys.stderr,
        )
        return None
    return rows[0]["id"]


def _format_transcript(rows) -> str:
    """Render the trailing ``_TRANSCRIPT_TAIL`` user/assistant turns
    as a compact ``ROLE: text`` block the seance prompt embeds.

    The summariser-pass from docs/023 §2.1 supersedes this when it
    lands — for the MVP we hand the model the raw tail with a hard
    cap on length so the prompt doesn't run away on very long
    histories.
    """
    tail = list(rows[-_TRANSCRIPT_TAIL:])
    lines: list[str] = []
    for row in tail:
        body = (row["content"] or "").strip().replace("\n", " ")[:400]
        lines.append(f"{row['role'].upper()}: {body}")
    return "\n".join(lines)


__all__ = ["seance_ask", "seance_list"]
