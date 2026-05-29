# SPDX-License-Identifier: AGPL-3.0-or-later
"""``<plugins-dir>/.lock`` read/write/diff for ``eidan admin plugin sync``.

The lock file is the declarative record of which CLI-installed plugins
should exist on the live machine. It is written by
``eidan admin plugin install`` and ``eidan admin plugin remove``; it is
read (and applied) by ``eidan admin plugin sync``. A hand-edit followed
by ``plugin sync`` is the supported drift-resolution workflow.

The file is intentionally per-plugin rather than per-bundle: that
matches the on-disk reality (one folder under ``plugins/<name>/`` per
plugin) and lets sync reason about individual plugin upgrades. The
``bundle`` field records the bundle a plugin came from so sync can
group reinstalls; ``source`` records how to refetch the bundle.

Repo-bundled core plugins (the ones shipped in this repo's
``plugins/`` directory, no ``bundle:`` stanza) are NOT recorded here —
they live with the source tree, not with operator install state.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import yaml

LOCK_FILENAME = ".lock"
LOCK_SCHEMA_VERSION = 1


@dataclass(frozen=True)
class LockEntry:
    """One row in the lock file: a plugin the operator declared installed.

    ``bundle`` is the bundle name the plugin was installed as part of
    (the ``bundle.name`` stanza from the source-side manifest). It can
    be the same as ``name`` when a bundle ships exactly one plugin.

    ``source`` describes where to refetch the bundle. Mirrors the
    ``EIDAN_PLUGIN_SOURCE`` schemes accepted by ``plugin install``:
    ``gh:<org>`` or ``local:<path>``.
    """

    name: str
    version: str
    bundle: str
    source: str


def lock_path(plugins_dir: Path) -> Path:
    """Conventional location for the lock file."""
    return plugins_dir / LOCK_FILENAME


def read_lock(plugins_dir: Path) -> list[LockEntry]:
    """Parse ``<plugins-dir>/.lock`` into a list of entries.

    A missing file yields an empty list — that's the first-install
    state, not an error. A malformed file raises ``LockFileError``;
    callers (sync, install) surface that as a non-zero exit so the
    operator can fix the file rather than have sync silently treat
    drift as the new ground truth.
    """
    path = lock_path(plugins_dir)
    if not path.is_file():
        return []
    try:
        raw = yaml.safe_load(path.read_text(encoding="utf-8"))
    except (OSError, yaml.YAMLError) as exc:
        raise LockFileError(f"could not read {path}: {exc}") from exc
    if raw is None:
        return []
    if not isinstance(raw, dict):
        raise LockFileError(f"{path}: top level must be a mapping")
    schema = raw.get("schema")
    if schema != LOCK_SCHEMA_VERSION:
        raise LockFileError(
            f"{path}: schema={schema!r}; this CLI understands "
            f"schema={LOCK_SCHEMA_VERSION}."
        )
    plugins = raw.get("plugins") or []
    if not isinstance(plugins, list):
        raise LockFileError(f"{path}: 'plugins' must be a list")
    out: list[LockEntry] = []
    for idx, item in enumerate(plugins):
        if not isinstance(item, dict):
            raise LockFileError(
                f"{path}: plugins[{idx}] must be a mapping"
            )
        for field in ("name", "version", "bundle", "source"):
            value = item.get(field)
            if not isinstance(value, str) or not value:
                raise LockFileError(
                    f"{path}: plugins[{idx}] missing/empty '{field}'"
                )
        out.append(
            LockEntry(
                name=item["name"],
                version=item["version"],
                bundle=item["bundle"],
                source=item["source"],
            )
        )
    return out


def write_lock(plugins_dir: Path, entries: list[LockEntry]) -> None:
    """Atomically write the lock file, sorted by plugin name.

    Sorted output keeps the diff stable across runs so an operator
    reviewing ``git diff plugins/.lock`` (or its analogue) sees only
    real semantic changes. The write goes via a sibling tempfile +
    rename so a crash mid-write cannot leave the lock truncated.

    Any filesystem failure (permission denied on the plugins dir,
    disk full mid-write, cross-device rename) is re-raised as
    ``LockFileError`` so callers can treat lock-file IO uniformly —
    install/remove/sync all catch this single type and surface it as
    a non-fatal warning rather than letting an ``OSError`` crash the
    CLI after the plugin files are already on disk.
    """
    payload = {
        "schema": LOCK_SCHEMA_VERSION,
        "plugins": [
            {
                "name": e.name,
                "version": e.version,
                "bundle": e.bundle,
                "source": e.source,
            }
            for e in sorted(entries, key=lambda x: x.name)
        ],
    }
    text = yaml.safe_dump(payload, sort_keys=False, default_flow_style=False)
    target = lock_path(plugins_dir)
    tmp = target.with_suffix(target.suffix + ".tmp")
    try:
        plugins_dir.mkdir(parents=True, exist_ok=True)
        tmp.write_text(text, encoding="utf-8")
        tmp.replace(target)
    except OSError as exc:
        raise LockFileError(f"could not write {target}: {exc}") from exc


def upsert(entries: list[LockEntry], new: list[LockEntry]) -> list[LockEntry]:
    """Return ``entries`` with each ``new`` entry overwriting or appended.

    Pure function — caller writes the result. Keyed by ``name``; an
    existing row for the same name is replaced wholesale (version /
    bundle / source all swap together because they describe a single
    install action).
    """
    by_name = {e.name: e for e in entries}
    for entry in new:
        by_name[entry.name] = entry
    return list(by_name.values())


def remove(entries: list[LockEntry], names: list[str]) -> list[LockEntry]:
    """Return ``entries`` with any row whose ``name`` is in ``names`` dropped."""
    drop = set(names)
    return [e for e in entries if e.name not in drop]


@dataclass(frozen=True)
class SyncPlan:
    """The diff between the lock and the installed tree.

    ``install_bundles`` groups lock entries by ``(source, bundle)`` so
    the executor can install each bundle once even when it contributes
    multiple plugins. ``upgrades`` is a subset of the install plan
    flagged by an on-disk version mismatch — useful for the dry-run
    output even though both code paths run the same install command.

    ``prune`` is the names of plugins on disk but not in the lock that
    sync may delete with ``--prune``. The CLI's pruning policy is
    decided here (only entries that came from a bundle, never
    repo-shipped core), so the executor just iterates.
    """

    install_bundles: list[tuple[str, str, list[str]]]
    upgrades: list[tuple[str, str, str]]
    prune: list[str]
    in_sync: list[str]


@dataclass(frozen=True)
class InstalledView:
    """The CLI's projection of one on-disk ``plugins/<name>/`` directory.

    Kept out of ``admin._PluginEntry``'s import chain so the pure
    diff logic above stays testable without pulling in the backend
    plugin loader. ``bundle`` is the ``bundle.name`` stanza from the
    on-disk manifest (None if absent).
    """

    name: str
    version: str
    bundle: str | None


def plan_sync(
    lock_entries: list[LockEntry],
    installed: list[InstalledView],
    *,
    prune: bool,
) -> SyncPlan:
    """Compute install / upgrade / prune actions.

    ``installed`` is the on-disk view: name, version, and whether the
    plugin declares a ``bundle:`` stanza (eligible for pruning) or not
    (repo-shipped, never pruned).

    Sync v1 ignores transitive bundle dependencies — the install path
    already auto-resolves ``bundle.yaml`` ``depends_on``, so a bundle
    that pulls a baseline gets the baseline reinstalled for free.
    """
    by_name = {iv.name: iv for iv in installed}

    install_groups: dict[tuple[str, str], list[str]] = {}
    upgrades: list[tuple[str, str, str]] = []
    in_sync: list[str] = []
    locked_names: set[str] = set()
    for entry in lock_entries:
        locked_names.add(entry.name)
        key = (entry.source, entry.bundle)
        current = by_name.get(entry.name)
        if current is None:
            install_groups.setdefault(key, []).append(entry.name)
        elif current.version != entry.version:
            install_groups.setdefault(key, []).append(entry.name)
            upgrades.append(
                (entry.name, current.version or "(unknown)", entry.version)
            )
        else:
            in_sync.append(entry.name)

    install_bundles = [
        (source, bundle, sorted(names))
        for (source, bundle), names in sorted(install_groups.items())
    ]

    prune_targets: list[str] = []
    if prune:
        for iv in installed:
            if iv.name in locked_names:
                continue
            if iv.bundle is None:
                # No bundle stanza ⇒ repo-shipped core. Never prune
                # — a CLI-driven sync must not delete files an
                # upstream `git pull` will put back next deploy.
                continue
            prune_targets.append(iv.name)

    return SyncPlan(
        install_bundles=install_bundles,
        upgrades=upgrades,
        prune=sorted(prune_targets),
        in_sync=sorted(in_sync),
    )


class LockFileError(Exception):
    """Raised when ``<plugins-dir>/.lock`` is malformed or unreadable."""


__all__ = [
    "LOCK_FILENAME",
    "LOCK_SCHEMA_VERSION",
    "InstalledView",
    "LockEntry",
    "LockFileError",
    "SyncPlan",
    "lock_path",
    "plan_sync",
    "read_lock",
    "remove",
    "upsert",
    "write_lock",
]
