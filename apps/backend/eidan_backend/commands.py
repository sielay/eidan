"""Plugin command registry — `docs/019 §1`, `docs/019 §4`.

Phase 1 implementation of the "one handler, many surfaces" command
pattern from `docs/019`. The full spec covers behaviour interplay,
per-surface adapters (Telegram, UI, MCP), validation against
``arguments_schema`` / ``result_schema``, and the idempotency cache.
This module lands the runtime side: the registry plugins write into
plus the dispatch entry point any surface (CLI today, UI/Telegram
later) calls.

Cross-surface adapters (UI form rendering, Telegram bot parsing)
belong to the bundle that hosts those surfaces; this is the core
seam they plug into. The CLI's ``eidan command run`` is the first
surface — sketched in :mod:`eidan_cli.commands_cli`.

The registry is process-local; reinstalls mid-turn produce a fresh
view of the registered set, like the behaviour registry. Per
``docs/019 §1`` the command + behaviour namespaces share an
allowance pool (collisions are fatal) — for Phase 1 the registries
are separate, and the cross-namespace collision check is best-effort
on the behaviour-side when both are registered for the same plugin.
"""

from __future__ import annotations

import re
from collections.abc import Awaitable, Callable, Iterable
from dataclasses import dataclass, field
from typing import Any

_COMMAND_NAME_RE = re.compile(
    r"^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$"
)


class CommandNameInvalid(ValueError):
    """Raised when a command name doesn't match the §3.2 grammar."""


class CommandIdConflict(Exception):
    """Raised when two commands register the same ``name``.

    Mirrors :class:`BehaviourIdConflict` posture from the behaviour
    registry — globally unique, fatal at activation.
    """


class CommandNotFound(KeyError):
    """Raised when dispatch targets an unregistered command."""


@dataclass(frozen=True, slots=True)
class CommandInput:
    """Pinned dict carrying validated argument values.

    Phase 1 keeps this open (``dict[str, Any]``) — schema enforcement
    against the manifest's ``arguments_schema`` lands once the
    eidan-schemas codegen catches up. The handler is responsible for
    asserting required fields until then.
    """

    arguments: dict[str, Any] = field(default_factory=dict)
    metadata: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True, slots=True)
class CommandOutput:
    """What the handler returns. ``message`` is the operator-facing
    rendering; ``data`` is the structured payload pinned by the
    manifest's ``result_schema``."""

    message: str
    data: dict[str, Any] = field(default_factory=dict)
    ok: bool = True
    error: str | None = None


# Surface-agnostic handler signature. Each handler may be wrapped by
# surface adapters (Telegram → CommandInput, UI → CommandInput, MCP →
# CommandInput) but the inner function shape is fixed.
CommandHandler = Callable[[CommandInput], Awaitable[CommandOutput]]


@dataclass(frozen=True, slots=True)
class Command:
    """Registered command: name + description + handler.

    The manifest carries more fields (``arguments_schema``,
    ``result_schema``, ``idempotent``, ``mcp_tool``, ``surfaces``).
    The runtime view here is the in-process projection — the writer
    of a command typically constructs this from the parsed manifest
    plus the resolved handler callable. Phase 1 leaves the
    schema-driven validation as a TODO inside the handler.
    """

    name: str
    description: str
    handler: CommandHandler = field(repr=False)
    idempotent: bool = True
    plugin: str | None = None


class CommandRegistry:
    """Process-local command catalogue.

    Read-mostly: writes happen at plugin activation, reads happen on
    every CLI / UI / Telegram / MCP dispatch. Keyed on ``name``; the
    register call validates the §3.2 grammar before insertion.
    """

    def __init__(self) -> None:
        self._commands: dict[str, Command] = {}

    def register(self, command: Command) -> None:
        if not _COMMAND_NAME_RE.match(command.name):
            raise CommandNameInvalid(
                f"command name {command.name!r} does not match "
                "[a-z][a-z0-9_]*(\\.[a-z][a-z0-9_]*)* (docs/019 §3.2)"
            )
        if command.name in self._commands:
            raise CommandIdConflict(command.name)
        self._commands[command.name] = command

    def register_all(self, commands: Iterable[Command]) -> None:
        # Two-pass atomic semantics, same as BehaviourRegistry — a
        # conflict halfway through the batch leaves the registry
        # unchanged so the activation as a whole is "rejected, not
        # partially loaded" (`docs/001 §3.3`).
        new = list(commands)
        for c in new:
            if not _COMMAND_NAME_RE.match(c.name):
                raise CommandNameInvalid(
                    f"command name {c.name!r} does not match the grammar"
                )
        conflicts = [c.name for c in new if c.name in self._commands]
        if conflicts:
            raise CommandIdConflict(conflicts[0])
        seen: set[str] = set()
        for c in new:
            if c.name in seen:
                raise CommandIdConflict(c.name)
            seen.add(c.name)
        for c in new:
            self._commands[c.name] = c

    def unregister(self, name: str) -> None:
        self._commands.pop(name, None)

    def get(self, name: str) -> Command | None:
        return self._commands.get(name)

    def all(self) -> tuple[Command, ...]:
        return tuple(self._commands.values())

    def by_plugin(self, plugin: str) -> tuple[Command, ...]:
        return tuple(c for c in self._commands.values() if c.plugin == plugin)

    async def dispatch(
        self,
        name: str,
        input_: CommandInput,
    ) -> CommandOutput:
        cmd = self._commands.get(name)
        if cmd is None:
            raise CommandNotFound(name)
        return await cmd.handler(input_)


__all__ = [
    "Command",
    "CommandHandler",
    "CommandIdConflict",
    "CommandInput",
    "CommandNameInvalid",
    "CommandNotFound",
    "CommandOutput",
    "CommandRegistry",
]
