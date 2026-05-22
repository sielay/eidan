"""Plugin command registry tests (issue #26 / `docs/019`).

The runtime side of the "one handler, many surfaces" pattern.
Adapter coverage (Telegram parser, UI form rendering, MCP tool
binding) belongs to the surface-specific tests once each surface's
bridge lands; this file exercises the seam every surface plugs
into.
"""

from __future__ import annotations

import pytest
from eidan_backend.commands import (
    Command,
    CommandIdConflict,
    CommandInput,
    CommandNameInvalid,
    CommandNotFound,
    CommandOutput,
    CommandRegistry,
)


async def _echo_handler(arg: CommandInput) -> CommandOutput:
    return CommandOutput(
        message=f"echoed: {arg.arguments}",
        data={"input": arg.arguments},
    )


def _echo(name: str = "calendar.add") -> Command:
    return Command(
        name=name,
        description="An echo handler used by the tests.",
        handler=_echo_handler,
        plugin="example-calendar",
    )


def test_register_and_lookup() -> None:
    registry = CommandRegistry()
    registry.register(_echo())
    assert registry.get("calendar.add") is not None
    assert registry.all() == (_echo(),)
    assert registry.by_plugin("example-calendar") == (_echo(),)


def test_register_rejects_invalid_name_grammar() -> None:
    registry = CommandRegistry()
    for bad in (
        "Calendar.Add",  # uppercase
        "1calendar.add",  # starts with digit
        ".calendar.add",  # leading dot
        "calendar.",  # trailing dot
        "calendar..add",  # empty segment
        "calendar-add",  # hyphen not allowed in first-segment
    ):
        with pytest.raises(CommandNameInvalid):
            registry.register(_echo(name=bad))


def test_register_conflict() -> None:
    registry = CommandRegistry()
    registry.register(_echo())
    with pytest.raises(CommandIdConflict):
        registry.register(_echo())


def test_register_all_is_atomic_on_conflict() -> None:
    registry = CommandRegistry()
    registry.register(_echo())
    batch = [
        Command(
            name="email.send",
            description="x",
            handler=_echo_handler,
            plugin="example-imap",
        ),
        # Conflict with the existing calendar.add
        _echo(),
    ]
    with pytest.raises(CommandIdConflict):
        registry.register_all(batch)
    # email.send should NOT have been admitted.
    assert registry.get("email.send") is None


@pytest.mark.asyncio
async def test_dispatch_routes_to_handler() -> None:
    registry = CommandRegistry()
    registry.register(_echo())
    out = await registry.dispatch(
        "calendar.add",
        CommandInput(arguments={"when": "tomorrow", "what": "dentist"}),
    )
    assert out.ok is True
    assert "dentist" in out.message
    assert out.data == {"input": {"when": "tomorrow", "what": "dentist"}}


@pytest.mark.asyncio
async def test_dispatch_raises_for_unknown() -> None:
    registry = CommandRegistry()
    with pytest.raises(CommandNotFound):
        await registry.dispatch("not.real", CommandInput())


def test_unregister_drops_row() -> None:
    registry = CommandRegistry()
    registry.register(_echo())
    registry.unregister("calendar.add")
    assert registry.get("calendar.add") is None
    # Unregistering twice is a silent no-op.
    registry.unregister("calendar.add")
