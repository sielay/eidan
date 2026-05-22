"""Plugin entry point — mirrors the shape pinned in `docs/001 §2.2`.

Phase 4 acceptance: the four lifecycle hooks each print a single line
so the loader smoke test can observe them firing in order against a
real :class:`PluginContext`. A module-level ``hook_log`` list records
the same events for stronger test assertions.
"""

from __future__ import annotations

from eidan_backend.plugins import PluginBase, PluginContext

hook_log: list[str] = []


def reset_hook_log() -> None:
    """Drop accumulated hook records. Tests call this between runs."""
    hook_log.clear()


class Plugin(PluginBase):
    name = "example-core"

    async def on_install(self, ctx: PluginContext) -> None:
        print(f"[example-core] on_install (name={ctx.name})")
        hook_log.append("on_install")

    async def on_activate(self, ctx: PluginContext) -> None:
        print(f"[example-core] on_activate (name={ctx.name})")
        hook_log.append("on_activate")

    async def on_deactivate(self, ctx: PluginContext) -> None:
        print(f"[example-core] on_deactivate (name={ctx.name})")
        hook_log.append("on_deactivate")

    async def on_uninstall(self, ctx: PluginContext) -> None:
        print(f"[example-core] on_uninstall (name={ctx.name})")
        hook_log.append("on_uninstall")


__all__ = ["Plugin", "hook_log", "reset_hook_log"]
