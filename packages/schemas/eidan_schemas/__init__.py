"""Eidan schemas — Pydantic v2 models generated from JSON Schema sources.

JSON Schema is the single source of truth (docs/004_SCHEMAS.md). This
package re-exports the generated models — and any hand-written
refinements from ``adapters`` — as the public Python surface. The
matching TypeScript / Zod surface ships as ``@eidan/schemas``.
"""

from .adapters import IntendedAction
from .generated.core.cost.CostSummary_schema import CostSummary
from .generated.core.cost.CostSummary_schema import Scope as CostScope
from .generated.core.intent.IntendedActions_schema import (
    CreateEvent,
    IntendedActions,
    Lookup,
    SendMessage,
    Unknown,
    UpdateRow,
)
from .generated.core.turn.TurnChunk_schema import TurnChunk
from .generated.core.turn.TurnComplete_schema import TurnComplete
from .generated.core.turn.TurnInput_schema import TurnInput

__version__ = "0.1.0"

__all__ = [
    "CostScope",
    "CostSummary",
    "CreateEvent",
    "IntendedAction",
    "IntendedActions",
    "Lookup",
    "SendMessage",
    "TurnChunk",
    "TurnComplete",
    "TurnInput",
    "Unknown",
    "UpdateRow",
]
