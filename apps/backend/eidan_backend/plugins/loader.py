"""Plugin loader — `docs/001 §6`, `§8.1`–`§8.2`.

Walks ``plugins/<name>/`` on host start, validates each manifest via
:func:`load_manifest`, imports the ``backend.entrypoint`` to obtain a
:class:`PluginBase` subclass, instantiates it, then topologically
sorts the result on ``depends_on`` so the lifecycle runner can iterate
in install / activate order.

Hot-reload during host runtime is explicitly out of scope for Phase 4
(`docs/001 §8`).
"""

from __future__ import annotations

import importlib
import logging
import sys
from collections.abc import Iterable, Iterator
from dataclasses import dataclass
from pathlib import Path

from eidan_schemas.generated.core.plugin.PluginManifest_schema import (
    PluginManifest,
)

from .base import PluginBase
from .manifest import MalformedManifest, load_manifest

logger = logging.getLogger(__name__)


class PluginLoadError(Exception):
    """Raised when a plugin fails to load after manifest validation.

    Wraps the underlying import / attribute / type error in a single
    fatal class so the host's start-up path has one exception to
    handle. The ``plugin_name`` attribute carries the manifest name
    when known (it isn't when the manifest itself failed to parse —
    that path raises :class:`MalformedManifest` instead).
    """

    def __init__(self, message: str, *, plugin_name: str | None = None) -> None:
        super().__init__(message)
        self.plugin_name = plugin_name


class PluginMissingDependencyError(PluginLoadError):
    """Raised when a plugin's ``depends_on`` names an absent plugin.

    Per `docs/001 §8.1` step 2.2 this is a fatal install / load
    error — the host refuses to bring up a graph it can't complete.
    """


class PluginCycleError(PluginLoadError):
    """Raised when ``depends_on`` contains a cycle.

    `docs/001 §1.2` makes the DAG requirement explicit. Phase 4 detects
    cycles at load time so they surface before the lifecycle runner
    ever touches a plugin.
    """


@dataclass(frozen=True, slots=True)
class LoadedPlugin:
    """A validated, imported plugin ready for the lifecycle runner.

    ``plugin`` is the constructed :class:`PluginBase` instance — the
    runner calls its hooks directly. ``plugin_dir`` is retained so
    later phases (migrations, frontend symlinks) can resolve paths
    relative to the plugin root without re-deriving them.
    """

    manifest: PluginManifest
    plugin: PluginBase
    plugin_dir: Path


def _iter_plugin_dirs(plugins_dir: Path) -> Iterator[Path]:
    """Yield each ``plugins/<name>/`` directory under ``plugins_dir``.

    Hidden directories and stray files (``.gitkeep`` etc.) are
    skipped — only directories without a leading ``.`` and that
    contain a ``plugin.yaml`` are considered. Anything else gets
    rejected by :func:`load_manifest` further down, so the cheaper
    check here is just a courtesy that keeps the error path focused
    on real plugin failures.
    """
    if not plugins_dir.is_dir():
        return
    for entry in sorted(plugins_dir.iterdir()):
        if not entry.is_dir() or entry.name.startswith("."):
            continue
        if not (entry / "plugin.yaml").is_file():
            continue
        yield entry


def _import_plugin(plugin_dir: Path, manifest: PluginManifest) -> PluginBase:
    """Resolve ``backend.entrypoint`` to an instantiated :class:`PluginBase`.

    Per `docs/001 §2.1` a plugin's Python code lives in an importable
    package; in a real install the bundle CLI runs ``pip install -e .``
    against the plugin root. Phase 4 supports the same drop-in shape
    by prepending ``plugin_dir`` to :data:`sys.path` so the manifest's
    top-level package becomes importable without requiring an editable
    install on every dev's machine.

    Raises :class:`PluginLoadError` on missing stanza, bad entrypoint
    string, import error, missing attribute, or wrong base class.
    """
    if manifest.backend is None or not manifest.backend.entrypoint:
        raise PluginLoadError(
            f"{manifest.name!r}: backend.entrypoint is required to "
            "instantiate the plugin's Plugin class",
            plugin_name=manifest.name,
        )

    module_path, _, class_name = manifest.backend.entrypoint.partition(":")

    plugin_dir_str = str(plugin_dir)
    if plugin_dir_str not in sys.path:
        sys.path.insert(0, plugin_dir_str)

    try:
        module = importlib.import_module(module_path)
    except ImportError as exc:
        raise PluginLoadError(
            f"{manifest.name!r}: could not import {module_path!r}: {exc}",
            plugin_name=manifest.name,
        ) from exc

    try:
        plugin_cls = getattr(module, class_name)
    except AttributeError as exc:
        raise PluginLoadError(
            f"{manifest.name!r}: {module_path!r} has no attribute {class_name!r}",
            plugin_name=manifest.name,
        ) from exc

    if not isinstance(plugin_cls, type) or not issubclass(plugin_cls, PluginBase):
        raise PluginLoadError(
            f"{manifest.name!r}: {manifest.backend.entrypoint!r} does not "
            "resolve to a PluginBase subclass",
            plugin_name=manifest.name,
        )

    try:
        return plugin_cls()
    except Exception as exc:  # noqa: BLE001 — surface any ctor failure uniformly
        raise PluginLoadError(
            f"{manifest.name!r}: instantiating Plugin class failed: {exc}",
            plugin_name=manifest.name,
        ) from exc


def _topological_sort(plugins: list[LoadedPlugin]) -> list[LoadedPlugin]:
    """Order ``plugins`` so each plugin appears after its dependencies.

    Kahn's algorithm with alphabetical tiebreaking so the output is
    deterministic across runs. Missing dependencies raise
    :class:`PluginMissingDependencyError`; cycles raise
    :class:`PluginCycleError`. Both are fatal per `docs/001 §1.2`.
    """
    by_name: dict[str, LoadedPlugin] = {p.manifest.name: p for p in plugins}
    in_degree: dict[str, int] = {n: 0 for n in by_name}
    forward: dict[str, list[str]] = {n: [] for n in by_name}

    for p in plugins:
        for dep in p.manifest.depends_on or []:
            if dep.name not in by_name:
                raise PluginMissingDependencyError(
                    f"{p.manifest.name!r}: depends on missing plugin {dep.name!r}",
                    plugin_name=p.manifest.name,
                )
            forward[dep.name].append(p.manifest.name)
            in_degree[p.manifest.name] += 1

    ready = sorted(n for n, deg in in_degree.items() if deg == 0)
    ordered: list[LoadedPlugin] = []
    while ready:
        current = ready.pop(0)
        ordered.append(by_name[current])
        newly_ready: list[str] = []
        for dependent in forward[current]:
            in_degree[dependent] -= 1
            if in_degree[dependent] == 0:
                newly_ready.append(dependent)
        if newly_ready:
            ready = sorted(ready + newly_ready)

    if len(ordered) != len(by_name):
        unresolved = sorted(n for n, d in in_degree.items() if d > 0)
        raise PluginCycleError(
            f"depends_on cycle among plugins: {unresolved!r}",
        )

    return ordered


def load_plugins(
    plugins_dir: Path,
    *,
    disabled: Iterable[str] | None = None,
) -> list[LoadedPlugin]:
    """Discover, validate, import, and topologically sort every plugin.

    Walks ``plugins_dir/<name>/``, parses each ``plugin.yaml`` via
    :func:`load_manifest`, imports ``backend.entrypoint`` to build a
    :class:`PluginBase` instance, then orders the result by
    ``depends_on``. The lifecycle runner consumes the list directly.

    ``disabled`` is an optional iterable of plugin names to exclude
    from loading. A disabled plugin is not loaded at all — its
    manifest is not parsed, its entrypoint is not imported, neither
    ``on_install`` nor ``on_activate`` fires, no behaviours register,
    no routers mount, no MCP tools expose. The plugin's directory and
    migrations on disk are left alone. The convention is to populate
    this from ``EIDAN_DISABLED_PLUGINS`` (see :func:`bootstrap`); the
    summary log line uses that env-var name so operators can grep for
    it. Matching is case-sensitive; whitespace around each entry is
    trimmed. Names that don't match any discovered plugin emit a
    warning but don't raise — the same env var typically applies
    across nodes with different installed bundles, so "unknown" is
    expected on some of them.

    Raises :class:`MalformedManifest` on any manifest problem (missing
    file, YAML parse error, schema violation, directory-name
    mismatch); :class:`PluginLoadError` (or one of its subclasses) on
    import / topology problems.
    """
    disabled_set: set[str] = (
        {name.strip() for name in disabled if name and name.strip()}
        if disabled is not None
        else set()
    )

    loaded: list[LoadedPlugin] = []
    seen_names: set[str] = set()
    skipped: list[str] = []

    for plugin_dir in _iter_plugin_dirs(plugins_dir):
        seen_names.add(plugin_dir.name)
        # Per `docs/001 §1.2` the directory name equals the manifest
        # name — load_manifest enforces this — so filtering on the
        # cheap (no manifest parse, no import) is correct.
        if plugin_dir.name in disabled_set:
            skipped.append(plugin_dir.name)
            continue
        manifest = load_manifest(plugin_dir)  # raises MalformedManifest
        plugin_obj = _import_plugin(plugin_dir, manifest)
        loaded.append(
            LoadedPlugin(
                manifest=manifest,
                plugin=plugin_obj,
                plugin_dir=plugin_dir,
            )
        )

    if skipped:
        logger.info(
            "[plugins] disabled by EIDAN_DISABLED_PLUGINS: %s",
            ", ".join(sorted(skipped)),
        )

    unknown = disabled_set - seen_names
    if unknown:
        logger.warning(
            "[plugins] EIDAN_DISABLED_PLUGINS references unknown plugin(s): "
            "%s (no matching directory under %s)",
            ", ".join(sorted(unknown)),
            plugins_dir,
        )

    duplicates = _find_duplicate_names(loaded)
    if duplicates:
        raise PluginLoadError(
            f"duplicate plugin name(s): {duplicates!r}",
        )

    return _topological_sort(loaded)


def _find_duplicate_names(plugins: list[LoadedPlugin]) -> list[str]:
    """Return duplicate manifest names — empty list when all unique.

    The directory-name = manifest-name rule (`docs/001 §1.2`) is
    enforced by :func:`load_manifest`, which makes a sibling-directory
    duplicate impossible at the filesystem layer; this is a
    belt-and-braces check that survives any future relaxation.
    """
    seen: set[str] = set()
    dupes: list[str] = []
    for p in plugins:
        if p.manifest.name in seen:
            dupes.append(p.manifest.name)
        else:
            seen.add(p.manifest.name)
    return dupes


__all__ = [
    "LoadedPlugin",
    "MalformedManifest",
    "PluginCycleError",
    "PluginLoadError",
    "PluginMissingDependencyError",
    "load_plugins",
]
