# SPDX-License-Identifier: AGPL-3.0-or-later
"""Rich-formatted inspection views for `eidan node list` + `eidan node show`.

The view layer reads a :class:`Topology`, walks its resolved nodes,
and renders compact tables / panels to the user's terminal. It does
NOT touch the underlying topology file — read-only.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from rich.console import Console
from rich.panel import Panel
from rich.table import Table

if TYPE_CHECKING:
    from .topology import Topology


def _items_to_strings(items: object) -> list[str]:
    """RootModel-wrapped strings (Bundle, DisableItem) → plain strings."""
    if not items:
        return []
    out: list[str] = []
    for item in items:
        out.append(item.root if hasattr(item, "root") else str(item))
    return out


def render_node_list(topology: Topology, *, console: Console | None = None) -> None:
    """One row per node — name, target, bundles, disabled plugins."""
    console = console or Console()
    table = Table(title=f"Nodes ({len(topology.node_names())})", show_lines=False)
    table.add_column("name", style="cyan", no_wrap=True)
    table.add_column("target", style="magenta")
    table.add_column("bundles", style="green")
    table.add_column("disabled", style="yellow")

    for node in topology.iter_nodes():
        target = (
            node.target.value if hasattr(node.target, "value") else str(node.target)
        )
        bundles = ", ".join(_items_to_strings(getattr(node, "bundles", None))) or "—"
        disabled = ", ".join(_items_to_strings(getattr(node, "disable", None))) or "—"
        table.add_row(node.name, target, bundles, disabled)

    console.print(table)


def render_node_show(node: object, *, console: Console | None = None) -> None:
    """Pretty-print one resolved node — full view, defaults already
    merged in by ``Topology.resolve_node``."""
    console = console or Console()
    lines: list[str] = []

    target = (
        node.target.value if hasattr(node.target, "value") else str(node.target)  # type: ignore[attr-defined]
    )
    lines.append(f"[bold]target:[/bold] {target}")
    lines.append(f"[bold]database_url:[/bold] {node.database_url}")  # type: ignore[attr-defined]
    # Don't echo the master key verbatim — show length only so the
    # operator can tell whether it's set without leaking it to a screen-
    # shareable buffer.
    master_key = getattr(node, "auth_master_key", None)
    if master_key:
        lines.append(
            f"[bold]auth_master_key:[/bold] [dim]<set, {len(str(master_key))} chars>[/dim]"
        )
    lines.append(
        f"[bold]auth_allowed_email:[/bold] {node.auth_allowed_email}"  # type: ignore[attr-defined]
    )
    deployment_mode = getattr(node, "deployment_mode", None)
    if deployment_mode:
        mode = (
            deployment_mode.value
            if hasattr(deployment_mode, "value")
            else str(deployment_mode)
        )
        lines.append(f"[bold]deployment_mode:[/bold] {mode}")
    lines.append(
        f"[bold]http:[/bold] {getattr(node, 'http_host', '0.0.0.0')}:"
        f"{getattr(node, 'http_port', 8000)}"
    )

    provider = getattr(node, "provider", None)
    if provider is not None:
        provider_name = (
            provider.name.value if hasattr(provider.name, "value") else str(provider.name)
        )
        lines.append(
            f"[bold]provider:[/bold] {provider_name} ({provider.default_model})"
        )

    # Pi-specific
    if getattr(node, "host", None):
        lines.append(f"[bold]ssh:[/bold] {node.ssh_user}@{node.host}")  # type: ignore[attr-defined]
        if getattr(node, "ssh_key", None):
            lines.append(f"  [dim]key: {node.ssh_key}[/dim]")  # type: ignore[attr-defined]

    # Fly-specific
    if getattr(node, "app", None):
        lines.append(
            f"[bold]fly:[/bold] {node.app} @ {getattr(node, 'region', '?')}"  # type: ignore[attr-defined]
        )

    # Docker-specific
    if getattr(node, "compose_project", None):
        lines.append(f"[bold]compose:[/bold] {node.compose_project}")  # type: ignore[attr-defined]

    bundles = _items_to_strings(getattr(node, "bundles", None))
    if bundles:
        lines.append(f"[bold]bundles:[/bold] {', '.join(bundles)}")

    disabled = _items_to_strings(getattr(node, "disable", None))
    if disabled:
        lines.append(f"[bold]disabled:[/bold] {', '.join(disabled)}")

    sentry = getattr(node, "sentry", None)
    if sentry is not None:
        lines.append(
            f"[bold]sentry:[/bold] {'enabled' if sentry.enabled else 'disabled'} "
            f"({sentry.tick_interval}, model={sentry.model})"
        )

    if getattr(node, "node_id", None):
        node_type = getattr(node, "node_type", "?")
        lines.append(
            f"[bold]identity:[/bold] {node.node_id} ({node_type})"  # type: ignore[attr-defined]
        )

    body = "\n".join(lines)
    console.print(
        Panel(
            body,
            title=f"[cyan]{node.name}[/cyan]",  # type: ignore[attr-defined]
            border_style="cyan",
        )
    )


__all__ = ["render_node_list", "render_node_show"]
