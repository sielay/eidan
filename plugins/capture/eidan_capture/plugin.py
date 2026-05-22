"""Plugin entry point for the `capture` plugin.

Registers three tools the agent uses to write into eidan's memory
tables:

- ``remember`` — curated, skill-tagged entries → ``eidan.knowledge``.
- ``note``     — working memory captured during a conversation →
  ``eidan.notes`` (uses the loop-provisioned ``current_agent_id``
  contextvar to satisfy the ``agent_id NOT NULL`` constraint).
- ``event``    — calendar-like items → ``eidan.events``.

Each handler reads identity from the loop's ambient
:func:`eidan_backend.identity.get_current_identity` and inserts on
behalf of that user. Forward-compatible with multi-user; the same
plugin instance services every identity routed to it.
"""

from __future__ import annotations

import json
import logging
from typing import Any
from uuid import UUID

from eidan_backend.identity import get_current_agent_id, get_current_identity
from eidan_backend.plugins import PluginBase, PluginContext
from eidan_backend.tools import Tool, ToolError

from .writes import (
    insert_event,
    insert_knowledge,
    insert_note,
)

logger = logging.getLogger(__name__)


_REMEMBER_DESC = (
    "Save a curated, skill-tagged entry to the operator's long-term "
    "memory. Use when the user explicitly asks you to remember "
    "something or when a fact is durable enough to revisit later. "
    "`skill` is a short free-text tag (e.g. 'python', 'cooking', "
    "'home-network'). `title` is a short summary; `body` is the "
    "full content."
)
_REMEMBER_SCHEMA: dict[str, Any] = {
    "type": "object",
    "required": ["skill", "title", "body"],
    "additionalProperties": False,
    "properties": {
        "skill": {"type": "string", "minLength": 1},
        "title": {"type": "string", "minLength": 1, "maxLength": 200},
        "body": {"type": "string", "minLength": 1},
        "source": {
            "type": "string",
            "description": "Where this came from (URL, file path, chat).",
        },
        "source_type": {
            "type": "string",
            "enum": ["url", "file", "chat", "manual", "imported"],
            "default": "manual",
        },
    },
}


_NOTE_DESC = (
    "Capture a working-memory note. Use for anything that's worth "
    "having on hand for the rest of the conversation but isn't "
    "structured enough for `remember`. The note is anchored to the "
    "current conversation when one is in flight."
)
_NOTE_SCHEMA: dict[str, Any] = {
    "type": "object",
    "required": ["content"],
    "additionalProperties": False,
    "properties": {
        "content": {"type": "string", "minLength": 1},
        "conversation_id": {
            "type": "string",
            "format": "uuid",
            "description": (
                "Optional override of the conversation this note "
                "belongs to. Leave unset to omit the FK."
            ),
        },
    },
}


_EVENT_DESC = (
    "Capture a calendar-like item — a meeting, reminder, deadline, "
    "or observation. At least one of `due_at` (future) or "
    "`occurred_at` (past) must be provided. ISO 8601 timestamps "
    "preferred; the loop's TZ header gives you the user's clock."
)
_EVENT_SCHEMA: dict[str, Any] = {
    "type": "object",
    "required": ["type", "title"],
    "additionalProperties": False,
    "properties": {
        "type": {
            "type": "string",
            "description": "Free-text category ('meeting', 'reminder', 'workout', ...).",
        },
        "title": {"type": "string", "minLength": 1, "maxLength": 200},
        "body": {"type": "string"},
        "due_at": {
            "type": "string",
            "format": "date-time",
            "description": "ISO 8601 — when this is scheduled for.",
        },
        "occurred_at": {
            "type": "string",
            "format": "date-time",
            "description": "ISO 8601 — when this actually happened.",
        },
        "duration_seconds": {
            "type": "integer",
            "minimum": 0,
        },
    },
}


def _identity_or_raise() -> Any:
    identity = get_current_identity()
    if identity is None:
        raise ToolError(
            "capture tools require an authenticated identity "
            "(set by the agent loop before invocation)"
        )
    return identity


def _agent_id_or_raise() -> UUID:
    agent_id = get_current_agent_id()
    if agent_id is None:
        raise ToolError(
            "capture `note` requires an active agent_context "
            "(set by the agent loop before invocation)"
        )
    return agent_id


class Plugin(PluginBase):
    name = "capture"

    def __init__(self) -> None:
        self._db: Any | None = None

    async def on_install(self, ctx: PluginContext) -> None:
        logger.info("[capture] on_install (name=%s)", ctx.name)

    async def on_activate(self, ctx: PluginContext) -> None:
        logger.info("[capture] on_activate (name=%s)", ctx.name)
        self._db = ctx.db
        ctx.register_tools(
            [
                Tool(
                    name="remember",
                    description=_REMEMBER_DESC,
                    input_schema=_REMEMBER_SCHEMA,
                    handler=self._handle_remember,
                ),
                Tool(
                    name="note",
                    description=_NOTE_DESC,
                    input_schema=_NOTE_SCHEMA,
                    handler=self._handle_note,
                ),
                Tool(
                    name="event",
                    description=_EVENT_DESC,
                    input_schema=_EVENT_SCHEMA,
                    handler=self._handle_event,
                ),
            ]
        )

    async def on_deactivate(self, ctx: PluginContext) -> None:
        logger.info("[capture] on_deactivate (name=%s)", ctx.name)
        self._db = None

    async def on_uninstall(self, ctx: PluginContext) -> None:
        logger.info("[capture] on_uninstall (name=%s)", ctx.name)

    def _require_db(self) -> Any:
        if self._db is None:
            raise ToolError(
                "capture tool invoked before `on_activate` — the host "
                "must activate the plugin before any tool runs"
            )
        return self._db

    async def _handle_remember(self, payload: dict) -> str:
        identity = _identity_or_raise()
        skill = payload.get("skill", "").strip()
        title = payload.get("title", "").strip()
        body = payload.get("body", "").strip()
        if not (skill and title and body):
            raise ToolError(
                "`remember` requires non-empty skill, title, and body"
            )
        async with self._require_db().acquire() as conn:
            new_id = await insert_knowledge(
                conn,
                user_id=UUID(identity.user_id),
                skill=skill,
                title=title,
                body=body,
                source=payload.get("source"),
                source_type=payload.get("source_type"),
            )
        return json.dumps({"id": str(new_id), "skill": skill, "title": title})

    async def _handle_note(self, payload: dict) -> str:
        identity = _identity_or_raise()
        agent_id = _agent_id_or_raise()
        content = payload.get("content", "").strip()
        if not content:
            raise ToolError("`note` requires non-empty content")
        conversation_id = payload.get("conversation_id")
        conv_uuid = UUID(conversation_id) if conversation_id else None

        async with self._require_db().acquire() as conn:
            new_id = await insert_note(
                conn,
                user_id=UUID(identity.user_id),
                agent_id=agent_id,
                conversation_id=conv_uuid,
                content=content,
            )
        return json.dumps({"id": str(new_id)})

    async def _handle_event(self, payload: dict) -> str:
        identity = _identity_or_raise()
        type_ = payload.get("type", "").strip()
        title = payload.get("title", "").strip()
        if not (type_ and title):
            raise ToolError("`event` requires non-empty type and title")
        due_at = payload.get("due_at")
        occurred_at = payload.get("occurred_at")
        if not (due_at or occurred_at):
            raise ToolError(
                "`event` requires at least one of due_at (future) or "
                "occurred_at (past) — the eidan.events table refuses "
                "rows with neither"
            )
        async with self._require_db().acquire() as conn:
            new_id = await insert_event(
                conn,
                user_id=UUID(identity.user_id),
                type_=type_,
                title=title,
                body=payload.get("body"),
                due_at_iso=due_at,
                occurred_at_iso=occurred_at,
                duration_seconds=payload.get("duration_seconds"),
            )
        return json.dumps({"id": str(new_id), "type": type_, "title": title})


__all__ = ["Plugin"]
