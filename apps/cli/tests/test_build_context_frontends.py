# SPDX-License-Identifier: AGPL-3.0-or-later
"""Tests for plugin-frontend assembly into the build context (#284)."""

from __future__ import annotations

import textwrap
from pathlib import Path

from eidan_cli.build_context import assemble_plugin_frontends


def _write(p: Path, text: str) -> None:
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(textwrap.dedent(text), encoding="utf-8")


def test_assemble_plugin_frontends_copies_package_and_generates_registry(
    tmp_path: Path,
) -> None:
    context = tmp_path / "ctx"
    # apps/web must exist — assembly writes the registry + plugin dirs there.
    (context / "apps" / "web" / "src").mkdir(parents=True)

    # A plugin that declares a frontend (package + a route + a slot).
    _write(
        context / "plugins" / "ventures" / "web" / "Decks.tsx",
        "export default function Decks() { return null; }",
    )
    _write(
        context / "plugins" / "ventures" / "plugin.yaml",
        """
        name: ventures
        frontend:
          package: ./web
          routes:
            - path: /decks
              component: Decks
          components:
            - slot: dashboard.widget
              component: Decks
        """,
    )
    # A plugin with no frontend — must be skipped, not copied.
    _write(context / "plugins" / "books" / "plugin.yaml", "name: books\n")

    registry = assemble_plugin_frontends(context)

    # Package contents copied under apps/web/src/plugins/<name>/.
    assert (context / "apps/web/src/plugins/ventures/Decks.tsx").is_file()
    # Frontend-less plugin not copied.
    assert not (context / "apps/web/src/plugins/books").exists()

    txt = registry.read_text(encoding="utf-8")
    assert registry.name == "registry.generated.ts"
    assert "pluginRoutes" in txt and "pluginSlots" in txt
    # Route + slot rendered with a statically-resolvable import specifier.
    assert "'/decks'" in txt
    assert "'dashboard.widget'" in txt
    assert "import('@/plugins/ventures/Decks')" in txt


def test_assemble_plugin_frontends_empty_when_no_frontends(tmp_path: Path) -> None:
    context = tmp_path / "ctx"
    (context / "apps" / "web" / "src").mkdir(parents=True)
    _write(context / "plugins" / "books" / "plugin.yaml", "name: books\n")

    registry = assemble_plugin_frontends(context)
    txt = registry.read_text(encoding="utf-8")
    # Valid, empty registry — a plain build still works (no entries).
    assert "export const pluginRoutes: PluginRoute[] = [" in txt
    assert "export const pluginSlots: PluginSlotEntry[] = [" in txt
    assert "import(" not in txt
