"""``PluginBase`` — the abstract base every plugin subclasses.

Pinned in `docs/001 §2.2`. Phase 4 lands the four lifecycle hooks
plus the optional ``health`` readiness probe; the loader (separate
issue) drives them in the order defined in `docs/001 §2.3`.

The defaults are deliberately permissive: every hook is a no-op the
subclass overrides only as needed. A plugin that contributes only
behaviours, only routes, or only migrations doesn't need a
``Plugin`` class with four hand-written stubs.
"""

from __future__ import annotations

from typing import Any

from .context import PluginContext


class PluginBase:
    """Abstract base class for the entry-point of every plugin.

    Subclasses set the class attribute ``name`` to match the
    manifest ``name`` and override whichever hooks they need. The
    host invokes the hooks in this order over the plugin's lifetime
    (`docs/001 §2.3`)::

        on_install   (once, before first activate; after migrations up)
        on_activate  (each host start, after deps' on_activate)
        on_deactivate (each host stop, before deps' on_deactivate)
        on_uninstall (once, before migrations down, after on_deactivate)

    ``health`` is queried opportunistically by the admin UI's
    ``/admin/plugins`` endpoint and SHOULD be cheap.
    """

    name: str = ""

    async def on_install(self, ctx: PluginContext) -> None:
        """One-shot setup before first activation.

        Idempotent: MUST tolerate being re-run after a failed install.
        DDL belongs in migrations (`docs/001 §4`), not here.
        """

    async def on_activate(self, ctx: PluginContext) -> None:
        """Called every time the host starts with this plugin enabled.

        Register routers, behaviour handlers, MCP tools, etc., via
        ``ctx.register_*`` callables.
        """

    async def on_deactivate(self, ctx: PluginContext) -> None:
        """Called on host shutdown or when the plugin is disabled.

        Release in-process resources. MUST NOT mutate persistent
        state — that belongs in :meth:`on_uninstall`.
        """

    async def on_uninstall(self, ctx: PluginContext) -> None:
        """Tear down persistent state owned by this plugin.

        Migrations run separately in the reverse direction.
        """

    async def health(self, ctx: PluginContext) -> dict[str, Any]:
        """Optional readiness probe surfaced in ``/admin/plugins``.

        Default: ``{"ok": True}``. Plugins override to surface a
        richer status payload (upstream reachability, queue depth,
        etc.) without changing the hook signature.
        """
        return {"ok": True}


__all__ = ["PluginBase"]
