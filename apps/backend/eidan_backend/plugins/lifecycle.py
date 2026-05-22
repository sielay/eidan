"""Plugin lifecycle runner — `docs/001 §8.2`–`§8.3`.

Drives :class:`LoadedPlugin` instances through the lifecycle pinned in
`docs/001 §2.3`. On host start:

1. For each plugin in topological order over ``depends_on``:
   - If ``eidan.plugin_state`` has no row for the plugin, run
     ``on_install`` and record the row.
   - Always run ``on_activate``.

On host shutdown the inverse: walk the topologically-ordered list in
reverse and call ``on_deactivate``. ``on_uninstall`` is operator-driven
(``eidan plugins uninstall``) and is intentionally out of scope here —
Phase 4 only ships the start / stop path.

The runner is parameterised over a :class:`PluginStateStore` so unit
tests can substitute an in-memory implementation. The shipped
:class:`AsyncpgPluginStateStore` is the production implementation that
talks to ``eidan.plugin_state``.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Protocol, runtime_checkable

import asyncpg

from .context import PluginContext
from .loader import LoadedPlugin


@runtime_checkable
class PluginStateStore(Protocol):
    """Persistence surface for the ``eidan.plugin_state`` registry.

    The runner cares about exactly two questions:

    - "Have I installed this plugin before?"  → :meth:`is_installed`
    - "Record that the install just succeeded." → :meth:`mark_installed`

    Concrete impls back this with asyncpg in production; tests
    substitute an in-memory map.
    """

    async def is_installed(self, name: str) -> bool: ...

    async def mark_installed(self, name: str, version: str) -> None: ...

    async def mark_uninstalled(self, name: str) -> None: ...


class AsyncpgPluginStateStore:
    """Production :class:`PluginStateStore` backed by ``eidan.plugin_state``.

    Holds the host's asyncpg pool and issues short transactions per
    query — the same pattern the rest of the host uses. The
    ``ON CONFLICT`` clause makes :meth:`mark_installed` idempotent so
    retrying a failed start does not duplicate rows.
    """

    def __init__(self, pool: asyncpg.Pool) -> None:
        self._pool = pool

    async def is_installed(self, name: str) -> bool:
        async with self._pool.acquire() as conn:
            row = await conn.fetchrow(
                "SELECT 1 FROM eidan.plugin_state WHERE name = $1",
                name,
            )
        return row is not None

    async def mark_installed(self, name: str, version: str) -> None:
        async with self._pool.acquire() as conn:
            await conn.execute(
                """
                INSERT INTO eidan.plugin_state (name, version)
                VALUES ($1, $2)
                ON CONFLICT (name) DO UPDATE
                    SET version = EXCLUDED.version
                """,
                name,
                version,
            )

    async def mark_uninstalled(self, name: str) -> None:
        async with self._pool.acquire() as conn:
            await conn.execute(
                "DELETE FROM eidan.plugin_state WHERE name = $1",
                name,
            )


ContextFactory = Callable[[LoadedPlugin], PluginContext]
"""Builds a :class:`PluginContext` for a given loaded plugin.

The runner is intentionally not opinionated about how the context is
constructed — the host owns the wiring (db pool scoped to the
plugin's schema, vault accessor, registrars) and hands a factory to
:func:`install_and_activate`. Tests pass a factory that yields a stub
context whose registrars are recording fakes.
"""


async def install_and_activate(
    plugins: list[LoadedPlugin],
    *,
    state: PluginStateStore,
    context_factory: ContextFactory,
) -> None:
    """Run ``on_install`` (first time) + ``on_activate`` (each start).

    Iterates ``plugins`` in the order the loader returned (topological
    over ``depends_on``). For each plugin:

    1. Build a :class:`PluginContext` via ``context_factory``.
    2. If :meth:`PluginStateStore.is_installed` returns ``False``,
       call ``on_install(ctx)`` and then
       :meth:`PluginStateStore.mark_installed`. A failure in
       ``on_install`` aborts the start; the row is not written, so a
       subsequent retry re-runs the hook (`docs/001 §2.2`:
       ``on_install`` MUST be idempotent).
    3. Call ``on_activate(ctx)``.

    The runner does not catch exceptions from hooks — letting them
    propagate is what causes the host's start-up to fail loud rather
    than half-load a broken plugin.
    """
    for loaded in plugins:
        ctx = context_factory(loaded)
        if not await state.is_installed(loaded.manifest.name):
            await loaded.plugin.on_install(ctx)
            await state.mark_installed(loaded.manifest.name, loaded.manifest.version)
        await loaded.plugin.on_activate(ctx)


async def deactivate(
    plugins: list[LoadedPlugin],
    *,
    context_factory: ContextFactory,
) -> None:
    """Run ``on_deactivate`` in reverse topological order.

    Each plugin's ``on_deactivate`` runs before any of its dependencies'
    deactivations, mirroring `docs/001 §2.3`. ``on_uninstall`` is
    explicitly NOT called here — Phase 4 only owns the host-shutdown
    path, not operator-driven uninstall (`docs/001 §8.4`).

    Hook exceptions are caught and logged-via-print here so a single
    misbehaving plugin does not block teardown of the rest. The
    last-raised exception is re-raised after all plugins have had a
    chance to shut down so the host's shutdown path still surfaces a
    failure.
    """
    last_error: BaseException | None = None
    for loaded in reversed(plugins):
        ctx = context_factory(loaded)
        try:
            await loaded.plugin.on_deactivate(ctx)
        except Exception as exc:  # noqa: BLE001 — see docstring
            last_error = exc
    if last_error is not None:
        raise last_error


async def uninstall(
    plugins: list[LoadedPlugin],
    *,
    state: PluginStateStore,
    context_factory: ContextFactory,
) -> None:
    """Run ``on_deactivate`` then ``on_uninstall`` per plugin, in reverse order.

    Drives the operator-uninstall path pinned in `docs/001 §8.4`. For
    each plugin in reverse topological order:

    1. Build a :class:`PluginContext` via ``context_factory``.
    2. Call ``on_deactivate`` (the runtime release; mirrors what host
       shutdown does).
    3. Call ``on_uninstall`` (the persistent-state teardown the host
       only ever runs at operator request).
    4. Drop the plugin's row from ``eidan.plugin_state`` so a fresh
       reinstall re-runs ``on_install``.

    Migration downgrade and on-disk removal are NOT this function's
    job — they live in :mod:`eidan_backend.plugins.migrations` and the
    CLI's ``plugin remove`` orchestration respectively. Splitting the
    concerns keeps each helper independently testable.

    Hook exceptions propagate. Unlike :func:`deactivate`, uninstall is
    operator-driven and a misbehaving plugin should fail loud rather
    than be silently glossed over.
    """
    for loaded in reversed(plugins):
        ctx = context_factory(loaded)
        await loaded.plugin.on_deactivate(ctx)
        await loaded.plugin.on_uninstall(ctx)
        await state.mark_uninstalled(loaded.manifest.name)


__all__ = [
    "AsyncpgPluginStateStore",
    "ContextFactory",
    "PluginStateStore",
    "deactivate",
    "install_and_activate",
    "uninstall",
]
