# SPDX-License-Identifier: AGPL-3.0-or-later
"""Hand-written refinements on top of the generated Pydantic models
(docs/004_SCHEMAS.md §5.1).

The TS twin lives in ``packages/schemas/src/adapters.ts``. JSON Schema
can express discriminated unions, but ``datamodel-code-generator``
inlines them on the parent field rather than emitting a named alias —
so the generated module exposes ``CreateEvent | UpdateRow | …`` on
``IntendedActions.actions`` but does not export an
``IntendedAction`` symbol for downstream Python code to import. The
adapter restores it as the public surface; the generated module
stays exactly what ``gen-py.sh`` produces.
"""

from __future__ import annotations

from typing import Annotated

from pydantic import Field

from .generated.core.intent.IntendedActions_schema import (
    CreateEvent,
    Lookup,
    SendMessage,
    Unknown,
    UpdateRow,
)

# Pydantic v2 resolves the action variant from the ``kind`` field at
# parse time. Extending the catalogue means adding a class to the
# schema source + regenerating, then appending the new type here; the
# intent classifier already collapses unrecognised shapes to
# :class:`Unknown` so an out-of-date deployment degrades rather than
# crashes.
IntendedAction = Annotated[
    CreateEvent | UpdateRow | SendMessage | Lookup | Unknown,
    Field(discriminator="kind"),
]


__all__ = ["IntendedAction"]
