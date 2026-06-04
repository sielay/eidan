# example-core — core plugin

A Phase 4 **acceptance fixture**, not a product surface. It exercises
the manifest validator and the `PluginBase` / `PluginContext` shape
end to end without contributing any real capability:

- the `Plugin` class is constructable,
- all four lifecycle hooks run against a real `PluginContext`,
- a single Alembic migration runs against the plugin-private
  `plugin_example_core` schema.

## What it ships

No tools, no behaviours. The four lifecycle hooks
(`on_install` / `on_activate` / `on_deactivate` / `on_uninstall`) each
print one line and append to a module-level `hook_log`, so the loader
smoke test can assert they fire in order. `reset_hook_log()` clears it
between runs.

The only real-ish extension point is `migrations:` — a trivial
`init_foo` migration that proves the host creates the plugin schema
before migrations run and registers the directory with Alembic at
activation time (`docs/001 §4`).

## Out of scope

Everything. This plugin's job is to be the minimal thing the loader,
manifest validator, and migration runner can be tested against.

The plugin is loaded automatically by the host's plugin loader at
startup; no manual registration step.
