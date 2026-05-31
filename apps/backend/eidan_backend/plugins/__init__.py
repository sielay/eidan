"""Plugin contract — `docs/001`.

Phase 4 ships the foundational surface every paid bundle and
community plugin will build against:

- :class:`PluginBase` — the abstract base a plugin subclasses, with
  the four lifecycle hooks (`docs/001 §2.2`).
- :class:`PluginContext` — the host surface handed to those hooks
  (`docs/001 §2.2`).
- :func:`load_manifest` + :class:`MalformedManifest` — the
  ``plugin.yaml`` validator that rejects malformed manifests at load
  time (`docs/001 §1`).
- :func:`load_plugins` + :class:`LoadedPlugin` — the loader that
  walks ``plugins/<name>/``, imports each plugin's entry point, and
  topologically sorts the result (`docs/001 §6`, `§8`).
- :func:`install_and_activate` + :func:`deactivate` — the lifecycle
  runner that drives ``on_install`` (once) and ``on_activate`` /
  ``on_deactivate`` (every host start / stop) per `docs/001 §8.2`.
"""

from .base import PluginBase
from .context import (
    BehaviourRegistrar,
    DbAccessor,
    PluginContext,
    RouterRegistrar,
    SecretAccessor,
    ToolRegistrar,
)
from .lifecycle import (
    AsyncpgPluginStateStore,
    ContextFactory,
    PluginStateStore,
    deactivate,
    install_and_activate,
    uninstall,
)
from .loader import (
    LoadedPlugin,
    PluginCycleError,
    PluginLoadError,
    PluginMissingDependencyError,
    load_plugins,
)
from .manifest import IncompatibleManifest, MalformedManifest, load_manifest
from .migrations import (
    apply_plugin_migrations,
    downgrade_plugin_migrations,
    run_plugin_migrations_sync,
    schema_for_plugin,
)

__all__ = [
    "AsyncpgPluginStateStore",
    "BehaviourRegistrar",
    "ContextFactory",
    "DbAccessor",
    "IncompatibleManifest",
    "LoadedPlugin",
    "MalformedManifest",
    "PluginBase",
    "PluginContext",
    "PluginCycleError",
    "PluginLoadError",
    "PluginMissingDependencyError",
    "PluginStateStore",
    "RouterRegistrar",
    "SecretAccessor",
    "ToolRegistrar",
    "apply_plugin_migrations",
    "deactivate",
    "downgrade_plugin_migrations",
    "install_and_activate",
    "load_manifest",
    "load_plugins",
    "run_plugin_migrations_sync",
    "schema_for_plugin",
    "uninstall",
]
