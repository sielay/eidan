# SPDX-License-Identifier: AGPL-3.0-or-later
"""Per-target deploy reconcilers.

One module per ``target:`` value in ``topology.yml`` (``pi``, ``fly``,
``docker``). Each exposes a ``reconcile(node, …)`` callable returning
the subprocess exit code. The dispatcher in :mod:`eidan_cli.deploy`
picks the module by name.
"""

from __future__ import annotations

from collections.abc import Callable


class TargetReconcileError(Exception):
    """Base class for reconciler failures (missing field, subprocess
    crash, etc.). Distinct from operator-input errors so the CLI can
    distinguish "your topology is broken" from "ansible failed"."""


# Reconciler signature. Returns the subprocess exit code; non-zero
# means the deploy failed. Reconcilers MUST NOT raise on subprocess
# failure — return the code so the orchestrator can decide whether
# to continue with other nodes.
Reconciler = Callable[..., int]


__all__ = [
    "Reconciler",
    "TargetReconcileError",
]
