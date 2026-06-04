# SPDX-License-Identifier: AGPL-3.0-or-later
"""Behaviour handler context — `docs/026 §4`.

Provided to handlers based on their dispatch kind. Each kind receives
different context fields: tool_chain gets tools, classifier_gate gets
tools + classifier, notify gets minimal context.

llm_turn handlers receive no context — they call spawn_turn internally
following today's pattern.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from ..tools import ToolRegistry


@dataclass
class BehaviourContext:
    """Runtime context provided to behaviour handlers.

    Fields are populated based on the handler's declared dispatch kind:

    - **llm_turn**: No context (handler calls spawn_turn internally).
    - **tool_chain**: `tools` only (deterministic recipe calling tools).
    - **classifier_gate**: `tools` + `classify` (single LLM decision, then branch).
    - **notify**: Minimal (no handler invocation, event emit only).
    """

    tools: ToolRegistry | None = None
    classify: Callable[[str, dict, Any], Awaitable[Any]] | None = None
    # Future: escalate, write_event, etc. for richer behaviour patterns
