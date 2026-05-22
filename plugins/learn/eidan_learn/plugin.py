"""Plugin entry point for the `learn` plugin.

Registers a single tool (``learn``) with the host. The tool surveys
the operator's existing memory for a given topic and returns a
structured JSON payload the primary call uses to compose a
user-facing learning plan.

Phase 1 scope:
- DB-survey across ``eidan.knowledge`` / ``eidan.notes`` /
  ``eidan.messages``.
- No external connectors (Phase 2 of issue #50).
- No command-registry routing — the model invokes the tool via
  ``tool_use``; the slash-command surface (issue #26 / docs/019) is
  separate work.

Identity: the tool handler reads the ambient
:data:`eidan_backend.identity.current_identity` contextvar — the
agent loop sets it for the duration of each turn so the handler
filters its queries on the right user. The plugin itself doesn't
capture identity at activation; that makes it forwards-compatible
with multi-user deployments where one host process serves many
identities.
"""

from __future__ import annotations

import logging
from typing import Any
from uuid import UUID

from eidan_backend.identity import get_current_identity
from eidan_backend.plugins import PluginBase, PluginContext
from eidan_backend.tools import Tool, ToolError

from .research import run_survey

logger = logging.getLogger(__name__)


_TOOL_NAME = "learn"
_TOOL_DESCRIPTION = (
    "Survey the operator's existing memory (knowledge, notes, recent "
    "messages) for what they already know about a topic. Returns a "
    "structured JSON payload listing the matched material, a summary "
    "counter, and a suggested set of clarifying questions. Use this "
    "when the user wants to research, plan, or learn about something "
    "— prefer it over guessing what the user already knows."
)
_INPUT_SCHEMA: dict[str, Any] = {
    "type": "object",
    "required": ["topic"],
    "additionalProperties": False,
    "properties": {
        "topic": {
            "type": "string",
            "minLength": 1,
            "description": "The topic the user wants to learn about.",
        },
        "depth": {
            "type": "string",
            "enum": ["shallow", "deep"],
            "default": "shallow",
            "description": (
                "Phase 1 ignores this — both depths run the same DB "
                "survey. Phase 2 will use `deep` to also reach out to "
                "MCP / external sources."
            ),
        },
    },
}


class Plugin(PluginBase):
    name = "learn"

    def __init__(self) -> None:
        # Captured at on_activate. The host calls on_activate once at
        # boot — that's when we register the tool. The handler reads
        # identity from the ambient contextvar at call time, so we
        # don't need to capture it here.
        self._db: Any | None = None

    async def on_install(self, ctx: PluginContext) -> None:
        # No persistent state to set up — Phase 1 reads core tables.
        logger.info("[learn] on_install (name=%s)", ctx.name)

    async def on_activate(self, ctx: PluginContext) -> None:
        logger.info("[learn] on_activate (name=%s)", ctx.name)
        self._db = ctx.db

        ctx.register_tools(
            [
                Tool(
                    name=_TOOL_NAME,
                    description=_TOOL_DESCRIPTION,
                    input_schema=_INPUT_SCHEMA,
                    handler=self._handle_learn,
                )
            ]
        )

    async def on_deactivate(self, ctx: PluginContext) -> None:
        logger.info("[learn] on_deactivate (name=%s)", ctx.name)
        self._db = None

    async def on_uninstall(self, ctx: PluginContext) -> None:
        logger.info("[learn] on_uninstall (name=%s)", ctx.name)

    async def _handle_learn(self, payload: dict) -> str:
        if self._db is None:
            raise ToolError(
                "the `learn` tool was invoked before the plugin was "
                "activated; the host must call `on_activate` first"
            )

        identity = get_current_identity()
        if identity is None:
            raise ToolError(
                "the `learn` tool requires an authenticated identity "
                "(set by the agent loop before invocation)"
            )

        topic = payload.get("topic")
        if not isinstance(topic, str) or not topic.strip():
            raise ToolError("`topic` is required and must be a non-empty string")

        async with self._db.acquire() as conn:
            survey = await run_survey(
                conn,
                user_id=UUID(identity.user_id),
                topic=topic,
            )
        return survey.to_json()


__all__ = ["Plugin"]
