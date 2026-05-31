# SPDX-License-Identifier: AGPL-3.0-or-later
"""`eidan deploy` orchestrator.

Loads the topology, picks the node(s) to reconcile, dispatches each
to the right per-target reconciler under :mod:`eidan_cli.targets`.

The orchestrator is intentionally thin — it owns the "which node?
which target? continue on partial failure?" decisions and leaves
the "how do you actually reconcile a Pi?" to the target module.

Failure policy: each node returns an exit code. The orchestrator
collects them all and returns non-zero overall if any failed.
Sequential by default; `--parallel` is a follow-up if friction
shows up (Ansible already serialises per host within a single
playbook invocation, so for now the per-node loop here is fine).
"""

from __future__ import annotations

from collections.abc import Iterable
from pathlib import Path
from typing import TYPE_CHECKING

from rich.console import Console

from .targets import TargetReconcileError, fly, pi
from .topology import (
    ResolvedNode,
    TopologyError,
    TopologyUnknownNode,
    load_topology,
)

if TYPE_CHECKING:
    pass


_console = Console()


# Map ``target:`` enum value to the per-target module. The dispatcher
# looks up ``.reconcile`` at call time rather than at module load so
# tests that patch ``pi.reconcile`` see their mock. Adding a new
# target = adding a key here and a sibling module under
# :mod:`eidan_cli.targets`.
_TARGET_MODULES: dict[str, object] = {
    "pi": pi,
    "fly": fly,
}

# Per-target external-CLI dependency probe. Run only for the targets a
# given topology actually uses — an all-Pi deploy shouldn't trip over a
# missing flyctl, and vice-versa. The function name is resolved via
# getattr at call time so tests can patch the attribute on the module.
_TARGET_DEP_PROBES: dict[str, str] = {
    "pi": "ensure_ansible_available",
    "fly": "ensure_flyctl_available",
}


class DeployError(Exception):
    """Base class for orchestrator-level failures (no reconciler
    for target, topology not loadable, etc.)."""


class NoReconcilerForTarget(DeployError):
    """Raised when a node declares a ``target:`` value the CLI
    doesn't have a reconciler for yet. Distinct error class so the
    CLI can render a "follow-up PR will land this" message rather
    than a generic stack trace."""


def _resolve_nodes(
    topology_path: Path, node: str | None
) -> list[ResolvedNode]:
    """Loads the topology and picks the node(s) to reconcile."""
    topology = load_topology(topology_path)
    if node is None:
        return list(topology.iter_nodes())
    return [topology.resolve_node(node)]


def _reconcile_one(
    node: ResolvedNode,
    *,
    topology_path: Path,
    tags: list[str] | None,
    dry_run: bool,
    ask_vault_pass: bool,
    extra_args: list[str] | None,
) -> int:
    target = node.target.value if hasattr(node.target, "value") else node.target
    module = _TARGET_MODULES.get(target)
    if module is None:
        raise NoReconcilerForTarget(
            f"node {node.name!r}: no reconciler for target {target!r} yet. "
            "Pi and Fly targets work today; Docker lands in a follow-up PR."
        )

    _console.print(
        f"[bold cyan]==> reconciling node {node.name!r} (target: {target})[/bold cyan]"
    )
    return module.reconcile(
        node,
        topology_path=topology_path,
        tags=tags,
        dry_run=dry_run,
        ask_vault_pass=ask_vault_pass,
        extra_args=extra_args,
    )


def deploy(
    topology_path: Path,
    *,
    node: str | None = None,
    tags: Iterable[str] | None = None,
    dry_run: bool = False,
    ask_vault_pass: bool = False,
    extra_args: Iterable[str] | None = None,
) -> int:
    """Reconcile every node (or just one) in the topology.

    Returns 0 if every node succeeded, or the first non-zero exit
    code otherwise. Continues past per-node failures so a single
    bad node doesn't block reconciliation of healthy peers; the
    operator gets a summary at the end."""
    tags_list = list(tags) if tags is not None else None
    extra_args_list = list(extra_args) if extra_args is not None else None

    try:
        nodes = _resolve_nodes(topology_path, node)
    except (TopologyUnknownNode, TopologyError) as exc:
        _console.print(f"[red]{exc}[/red]")
        return 2

    # Surface missing-CLI-dep errors early, but only for targets we'll
    # actually invoke. An all-Pi topology mustn't fail with "install
    # flyctl", which would surprise an operator who doesn't use Fly.
    targets_in_use = {
        (n.target.value if hasattr(n.target, "value") else n.target)
        for n in nodes
    }
    for target_name in sorted(targets_in_use):
        probe_attr = _TARGET_DEP_PROBES.get(target_name)
        if probe_attr is None:
            continue
        module = _TARGET_MODULES[target_name]
        try:
            getattr(module, probe_attr)()
        except TargetReconcileError as exc:
            _console.print(f"[red]{exc}[/red]")
            return 5

    if not nodes:
        _console.print("[yellow]no nodes to reconcile[/yellow]")
        return 0

    results: list[tuple[str, int]] = []
    for resolved in nodes:
        try:
            code = _reconcile_one(
                resolved,
                topology_path=topology_path,
                tags=tags_list,
                dry_run=dry_run,
                ask_vault_pass=ask_vault_pass,
                extra_args=extra_args_list,
            )
        except TargetReconcileError as exc:
            _console.print(f"[red]node {resolved.name!r}: {exc}[/red]")
            code = 3
        except NoReconcilerForTarget as exc:
            _console.print(f"[yellow]{exc}[/yellow]")
            code = 4
        results.append((resolved.name, code))
        if code != 0:
            _console.print(
                f"[red]node {resolved.name!r} reconcile failed (exit {code})[/red]"
            )

    failed = [name for name, code in results if code != 0]
    if failed:
        _console.print(
            f"\n[red]{len(failed)}/{len(results)} node(s) failed:[/red] "
            f"{', '.join(failed)}"
        )
        return next(code for _, code in results if code != 0)
    _console.print(
        f"\n[green]reconciled {len(results)} node(s) successfully[/green]"
    )
    return 0


__all__ = [
    "DeployError",
    "NoReconcilerForTarget",
    "deploy",
]
