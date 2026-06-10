# SPDX-License-Identifier: AGPL-3.0-or-later
"""A2A JSON-RPC 2.0 request handlers."""

from __future__ import annotations

import asyncio
import json
import logging
import os
from collections.abc import AsyncIterator
from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import UUID

from fastapi import HTTPException, Request
from fastapi.responses import StreamingResponse

from ..db import acquire
from ..loop import AssistantChunk, TurnComplete, TurnContext, run_turn
from ..persistence import (
    cost_summary_since,
    create_conversation,
    insert_user_message,
    load_full_conversation_messages,
)
from .a2a_emitter import A2AEmitter

logger = logging.getLogger(__name__)


def jsonrpc_error(
    code: int,
    message: str,
    data: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Build JSON-RPC 2.0 error response."""
    return {
        "error": {
            "code": code,
            "message": message,
            **({"data": data} if data else {}),
        }
    }


def _sse(event: dict[str, Any]) -> bytes:
    """Frame one event as a Server-Sent Event (``data: <json>\\n\\n``).

    The streaming methods declare ``text/event-stream``, so events MUST be
    SSE frames — not newline-delimited JSON — or standard SSE clients won't
    parse them (and never see the terminal event).
    """
    return f"data: {json.dumps(event)}\n\n".encode()


async def a2a_message_send(
    request: Request,
    params: dict[str, Any],
) -> dict[str, Any]:
    """Handle message/send: create or continue an A2A Task.

    Creates/continues a task backed by an eidan conversation and turn.
    """
    pool = request.app.state.pool
    provider = request.app.state.provider
    default_model = request.app.state.default_model
    tool_registry = request.app.state.tool_registry
    identity = request.state.identity
    user_uuid = UUID(identity.user_id)

    task_id = params.get("taskId")
    message = params.get("message", {})
    text_content = ""

    # Extract text from message parts
    parts = message.get("parts", [])
    for part in parts:
        if part.get("type") == "text":
            text_content = part.get("text", "")
            break

    if not text_content:
        return jsonrpc_error(400, "message must contain at least one text part")

    backend_settings = getattr(request.app.state, "backend_settings", None)
    max_turn_cost = (
        backend_settings.max_turn_cost_usd if backend_settings is not None else None
    )
    max_daily_cost = (
        backend_settings.max_daily_cost_usd if backend_settings is not None else None
    )

    # Generate or reuse task_id
    if not task_id:
        task_id = str(UUID(int=int.from_bytes(os.urandom(16), "big")))

    # Get or create conversation
    conversation_id: UUID | None = None
    async with acquire(pool, identity) as conn:
        # Fetch existing conversation from task metadata
        row = await conn.fetchrow(
            """
            SELECT conversation_id FROM eidan.messages
            WHERE user_id = $1 AND metadata->>'a2a_task_id' = $2
            LIMIT 1
            """,
            user_uuid,
            task_id,
        )
        if row:
            conversation_id = row["conversation_id"]

    if not conversation_id:
        # Create new conversation
        async with acquire(pool, identity) as conn:
            conversation_id = await create_conversation(conn, user_id=user_uuid)

    # Check daily cost cap
    async with acquire(pool, identity) as conn:
        if max_daily_cost is not None and max_daily_cost > 0:
            since = datetime.now(tz=UTC) - timedelta(hours=24)
            day_summary = await cost_summary_since(conn, user_id=user_uuid, since=since)
            day_cost = float(day_summary.get("cost_usd") or 0.0)
            if day_cost >= max_daily_cost:
                return jsonrpc_error(
                    402,
                    f"daily spend ${day_cost:.4f} exceeded ceiling of ${max_daily_cost:.4f}",
                    {
                        "code": "budget.daily_exceeded",
                        "cap_usd": max_daily_cost,
                        "spent_usd": day_cost,
                    },
                )

    # Run the turn
    ctx = TurnContext(identity=identity, conversation_id=conversation_id)
    sent_at_utc = datetime.now(tz=UTC)

    # Store A2A metadata on user message
    a2a_metadata = {"a2a_task_id": task_id}

    async with acquire(pool, identity) as conn:
        await insert_user_message(
            conn,
            user_id=user_uuid,
            conversation_id=conversation_id,
            content=text_content,
            metadata=a2a_metadata,
        )

    # Run turn (non-streaming, collect all events)
    telemetry = getattr(request.app.state, "telemetry", None)

    assistant_text = ""
    try:
        async for event in run_turn(
            pool=pool,
            provider=provider,
            model=default_model,
            ctx=ctx,
            user_text=text_content,
            sent_at_utc=sent_at_utc,
            user_tz="UTC",
            tool_registry=tool_registry,
            max_turn_cost_usd=max_turn_cost,
            telemetry=telemetry,
        ):
            if isinstance(event, AssistantChunk):
                assistant_text += event.text
            elif isinstance(event, TurnComplete):
                pass
    except Exception as exc:
        logger.exception("[a2a] turn failed: %s", exc)
        return jsonrpc_error(500, f"turn execution failed: {str(exc)[:100]}")

    return {
        "result": {
            "taskId": task_id,
            "status": "completed",
            "createdAt": sent_at_utc.isoformat(),
            "updatedAt": datetime.now(tz=UTC).isoformat(),
            # The assistant's reply as A2A content blocks, so one-shot
            # message/send is actually usable — outbound clients read
            # result.content (see a2a.register_a2a_tools).
            "content": [{"type": "text", "text": assistant_text}],
        }
    }


async def a2a_message_stream(
    request: Request,
    params: dict[str, Any],
) -> StreamingResponse:
    """Handle message/stream: stream a turn as SSE with status updates.

    Creates/continues a task and streams back SSE events with task status
    updates and artifacts. Similar to /api/turn but for A2A clients.
    """
    pool = request.app.state.pool
    provider = request.app.state.provider
    default_model = request.app.state.default_model
    tool_registry = request.app.state.tool_registry
    identity = request.state.identity
    user_uuid = UUID(identity.user_id)

    task_id = params.get("taskId")
    message = params.get("message", {})
    text_content = ""

    # Extract text from message parts
    parts = message.get("parts", [])
    for part in parts:
        if part.get("type") == "text":
            text_content = part.get("text", "")
            break

    if not text_content:
        raise HTTPException(
            status_code=400,
            detail="message must contain at least one text part",
        )

    backend_settings = getattr(request.app.state, "backend_settings", None)
    max_turn_cost = (
        backend_settings.max_turn_cost_usd if backend_settings is not None else None
    )
    max_daily_cost = (
        backend_settings.max_daily_cost_usd if backend_settings is not None else None
    )

    # Generate or reuse task_id
    if not task_id:
        task_id = str(UUID(int=int.from_bytes(os.urandom(16), "big")))

    # Get or create conversation
    conversation_id: UUID | None = None
    async with acquire(pool, identity) as conn:
        # Fetch existing conversation from task metadata
        row = await conn.fetchrow(
            """
            SELECT conversation_id FROM eidan.messages
            WHERE user_id = $1 AND metadata->>'a2a_task_id' = $2
            LIMIT 1
            """,
            user_uuid,
            task_id,
        )
        if row:
            conversation_id = row["conversation_id"]

    if not conversation_id:
        # Create new conversation
        async with acquire(pool, identity) as conn:
            conversation_id = await create_conversation(conn, user_id=user_uuid)

    # Check daily cost cap
    async with acquire(pool, identity) as conn:
        if max_daily_cost is not None and max_daily_cost > 0:
            since = datetime.now(tz=UTC) - timedelta(hours=24)
            day_summary = await cost_summary_since(conn, user_id=user_uuid, since=since)
            day_cost = float(day_summary.get("cost_usd") or 0.0)
            if day_cost >= max_daily_cost:
                raise HTTPException(
                    status_code=402,
                    detail=f"daily spend ${day_cost:.4f} exceeded ceiling of ${max_daily_cost:.4f}",
                )

    ctx = TurnContext(identity=identity, conversation_id=conversation_id)
    sent_at_utc = datetime.now(tz=UTC)

    # Store A2A metadata on user message
    a2a_metadata = {"a2a_task_id": task_id}

    async with acquire(pool, identity) as conn:
        await insert_user_message(
            conn,
            user_id=user_uuid,
            conversation_id=conversation_id,
            content=text_content,
            metadata=a2a_metadata,
        )

    async def _stream() -> AsyncIterator[bytes]:
        telemetry = getattr(request.app.state, "telemetry", None)
        artifact_service = getattr(request.app.state, "artifact_service", None)

        emitter = A2AEmitter(
            task_id=task_id,
            initial_message={"content": text_content},
            initial_timestamp=sent_at_utc.isoformat(),
        )

        try:
            # Emit start events
            for event in emitter.start():
                yield _sse(event)

            async for runner_event in run_turn(
                pool=pool,
                provider=provider,
                model=default_model,
                ctx=ctx,
                user_text=text_content,
                sent_at_utc=sent_at_utc,
                user_tz="UTC",
                tool_registry=tool_registry,
                max_turn_cost_usd=max_turn_cost,
                telemetry=telemetry,
            ):
                if await request.is_disconnected():
                    break

                for a2a_event in emitter.map(runner_event):
                    yield _sse(a2a_event)

                # After TurnComplete, check for artifacts
                if isinstance(runner_event, TurnComplete):
                    if artifact_service is not None:
                        # Fetch artifacts created during this turn
                        async with acquire(pool, identity) as conn:
                            artifact_rows = await conn.fetch(
                                """
                                SELECT id, kind, filename, mime_type, size_bytes
                                FROM eidan.artifacts
                                WHERE conversation_id = $1
                                  AND user_id = $2
                                  AND message_id = $3
                                  AND deleted_at IS NULL
                                """,
                                conversation_id,
                                user_uuid,
                                runner_event.assistant_message_id,
                            )
                        for artifact_row in artifact_rows:
                            for artifact_event in emitter.add_artifact(
                                artifact_id=UUID(artifact_row["id"]),
                                kind=artifact_row["kind"],
                                filename=artifact_row["filename"],
                                mime_type=artifact_row["mime_type"],
                                size_bytes=artifact_row["size_bytes"],
                            ):
                                yield _sse(artifact_event)

        except asyncio.CancelledError:
            # Client disconnect — propagate
            raise
        except Exception as exc:  # noqa: BLE001
            logger.exception("[a2a-stream] turn failed: %s", exc)
            for error_event in emitter.error(exc):
                yield _sse(error_event)
            raise

    return StreamingResponse(
        _stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )


async def a2a_tasks_get(
    request: Request,
    params: dict[str, Any],
) -> dict[str, Any]:
    """Handle tasks/get: fetch A2A Task status and history."""
    task_id = params.get("taskId")
    if not task_id:
        return jsonrpc_error(400, "taskId is required")

    pool = request.app.state.pool
    identity = request.state.identity
    user_uuid = UUID(identity.user_id)

    async with acquire(pool, identity) as conn:
        # Find conversation by task_id
        row = await conn.fetchrow(
            """
            SELECT DISTINCT m.conversation_id, m.created_at
            FROM eidan.messages m
            WHERE m.user_id = $1
            AND m.metadata->>'a2a_task_id' = $2
            ORDER BY m.created_at DESC
            LIMIT 1
            """,
            user_uuid,
            task_id,
        )

        if not row:
            return jsonrpc_error(404, f"task not found: {task_id}")

        conversation_id = row["conversation_id"]
        created_at = row["created_at"]

        # Load conversation messages
        messages_rows = await load_full_conversation_messages(
            conn, conversation_id=conversation_id
        )

        # Project to A2A format
        a2a_messages = []
        latest_updated = created_at

        for msg_row in messages_rows:
            role = msg_row.get("role")
            content = msg_row.get("content", "")
            msg_created = msg_row.get("created_at")

            if msg_created and msg_created > latest_updated:
                latest_updated = msg_created

            # Map eidan roles to A2A
            a2a_role = (
                "user"
                if role == "user"
                else ("assistant" if role == "assistant" else "tool")
            )
            a2a_messages.append(
                {
                    "role": a2a_role,
                    "content": content,
                    "timestamp": msg_created.isoformat() if msg_created else None,
                }
            )

        # Determine status
        status = "completed"
        if messages_rows and messages_rows[-1].get("role") == "user":
            status = "working"

        return {
            "result": {
                "taskId": task_id,
                "status": status,
                "messages": a2a_messages,
                "createdAt": created_at.isoformat(),
                "updatedAt": latest_updated.isoformat(),
            }
        }


async def a2a_tasks_resubscribe(
    request: Request,
    params: dict[str, Any],
) -> StreamingResponse:
    """Handle tasks/resubscribe: resume streaming a task's turn.

    For a task that's already running or completed, re-open the stream
    of events that occurred during the turn. Emits the same SSE events
    as message/stream would have, but for an already-completed turn.
    """
    task_id = params.get("taskId")
    if not task_id:
        raise HTTPException(
            status_code=400,
            detail="taskId is required",
        )

    pool = request.app.state.pool
    identity = request.state.identity
    user_uuid = UUID(identity.user_id)

    async with acquire(pool, identity) as conn:
        # Find conversation by task_id
        row = await conn.fetchrow(
            """
            SELECT DISTINCT m.conversation_id, m.created_at
            FROM eidan.messages m
            WHERE m.user_id = $1
            AND m.metadata->>'a2a_task_id' = $2
            ORDER BY m.created_at DESC
            LIMIT 1
            """,
            user_uuid,
            task_id,
        )

        if not row:
            raise HTTPException(
                status_code=404,
                detail=f"task not found: {task_id}",
            )

        conversation_id = row["conversation_id"]
        created_at = row["created_at"]

        # Load conversation messages
        messages_rows = await load_full_conversation_messages(
            conn, conversation_id=conversation_id
        )

        # Fetch artifacts for all messages in this conversation
        artifact_rows = await conn.fetch(
            """
            SELECT message_id, id, kind, filename, mime_type, size_bytes
            FROM eidan.artifacts
            WHERE conversation_id = $1 AND user_id = $2 AND deleted_at IS NULL
            """,
            conversation_id,
            user_uuid,
        )

    async def _stream() -> AsyncIterator[bytes]:
        # Emit user message
        user_msg = next(
            (m for m in messages_rows if m["role"] == "user"), None
        )
        if user_msg:
            yield b"data: " + json.dumps(
                {
                    "event": "message",
                    "data": {
                        "taskId": task_id,
                        "role": "user",
                        "content": user_msg.get("content", ""),
                        "timestamp": (
                            user_msg["created_at"].isoformat()
                            if user_msg["created_at"]
                            else ""
                        ),
                    },
                }
            ).encode() + b"\n\n"

        # Emit assistant message
        assistant_msg = next(
            (m for m in messages_rows if m["role"] == "assistant"), None
        )
        if assistant_msg:
            yield b"data: " + json.dumps(
                {
                    "event": "message",
                    "data": {
                        "taskId": task_id,
                        "role": "assistant",
                        "content": assistant_msg.get("content", ""),
                        "timestamp": (
                            assistant_msg["created_at"].isoformat()
                            if assistant_msg["created_at"]
                            else ""
                        ),
                    },
                }
            ).encode() + b"\n\n"

        # Emit artifacts that were produced
        artifacts_by_message = {}
        for a in artifact_rows:
            msg_id = str(a["message_id"]) if a["message_id"] else None
            if msg_id:
                artifacts_by_message.setdefault(msg_id, []).append(a)

        if assistant_msg and str(assistant_msg["id"]) in artifacts_by_message:
            for artifact in artifacts_by_message[str(assistant_msg["id"])]:
                yield b"data: " + json.dumps(
                    {
                        "event": "taskArtifactUpdate",
                        "data": {
                            "taskId": task_id,
                            "artifact": {
                                "id": str(artifact["id"]),
                                "kind": artifact["kind"],
                                "filename": artifact["filename"],
                                "mimeType": artifact["mime_type"],
                                "sizeBytes": artifact["size_bytes"],
                                "downloadUrl": f"/api/artifacts/{artifact['id']}",
                            },
                        },
                    }
                ).encode() + b"\n\n"

        # Emit final status
        yield b"data: " + json.dumps(
            {
                "event": "taskStatusUpdate",
                "data": {
                    "taskId": task_id,
                    "status": "completed",
                    "createdAt": created_at.isoformat(),
                    "updatedAt": (
                        messages_rows[-1]["created_at"].isoformat()
                        if messages_rows and messages_rows[-1]["created_at"]
                        else created_at.isoformat()
                    ),
                },
            }
        ).encode() + b"\n\n"

    return StreamingResponse(
        _stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )


async def a2a_tasks_cancel(
    request: Request,
    params: dict[str, Any],
) -> dict[str, Any]:
    """Handle tasks/cancel.

    message/send runs the turn **synchronously** and only returns once it has
    completed, so by the time a cancel could arrive the task has already
    terminated — there is no in-flight turn to stop and no persisted task
    status to flip. Rather than report a cancellation that never happened,
    return an honest "not supported" error. (A cooperative-cancel signal for
    long-running turns is future work.)
    """
    task_id = params.get("taskId")
    if not task_id:
        return jsonrpc_error(400, "taskId is required")

    return jsonrpc_error(
        -32004,
        "tasks/cancel is not supported: turns run synchronously and complete "
        "before a cancel can take effect",
    )
