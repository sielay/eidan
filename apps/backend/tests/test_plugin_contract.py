"""Phase 4 acceptance tests for the plugin contract.

Covers:

- :class:`PluginBase` default hooks are awaitable no-ops.
- :class:`PluginContext` is a frozen, slotted dataclass with the
  fields pinned in `docs/001 §2.2`.
- :func:`load_manifest` accepts the hand-written
  ``plugins/example-core/plugin.yaml`` and rejects malformed
  manifests with a clear field-path error.
- ``Plugin().on_activate(ctx)`` is callable with a real
  :class:`PluginContext` — the explicit acceptance criterion on the
  Phase 4 issue.
"""

from __future__ import annotations

import asyncio
import importlib
import textwrap
from collections.abc import Iterable
from dataclasses import FrozenInstanceError, fields, is_dataclass
from pathlib import Path
from typing import Any

import pytest
from eidan_backend.plugins import (
    MalformedManifest,
    PluginBase,
    PluginContext,
    load_manifest,
)

_REPO_ROOT = Path(__file__).resolve().parents[3]
_EXAMPLE_CORE_DIR = _REPO_ROOT / "plugins" / "example-core"


# ---------- PluginContext shape -------------------------------------------------


def test_plugin_context_is_frozen_slots_dataclass() -> None:
    assert is_dataclass(PluginContext)
    field_names = {f.name for f in fields(PluginContext)}
    assert field_names == {
        "name",
        "db",
        "secret",
        "register_router",
        "register_behaviours",
        "register_tools",
        "notify",
        "spawn_turn",
        "identity",
    }
    # slots=True: instance has no __dict__.
    ctx = _build_context()
    assert not hasattr(ctx, "__dict__")
    # frozen=True: re-assignment raises.
    with pytest.raises(FrozenInstanceError):
        ctx.name = "other"  # type: ignore[misc]


def test_plugin_context_identity_defaults_to_none() -> None:
    ctx = _build_context()
    assert ctx.identity is None


# ---------- PluginBase shape ---------------------------------------------------


def test_plugin_base_default_hooks_are_awaitable_noops() -> None:
    class P(PluginBase):
        name = "p"

    p = P()
    ctx = _build_context()

    assert asyncio.run(p.on_install(ctx)) is None
    assert asyncio.run(p.on_activate(ctx)) is None
    assert asyncio.run(p.on_deactivate(ctx)) is None
    assert asyncio.run(p.on_uninstall(ctx)) is None
    assert asyncio.run(p.health(ctx)) == {"ok": True}


# ---------- Manifest validation ------------------------------------------------


def test_example_core_manifest_loads(tmp_path: Path) -> None:
    manifest = load_manifest(_EXAMPLE_CORE_DIR)
    assert manifest.name == "example-core"
    assert manifest.tier.value == "core"
    assert manifest.backend is not None
    assert manifest.backend.entrypoint == "example_core.plugin:Plugin"


def test_example_core_plugin_on_activate_is_callable(tmp_path: Path) -> None:
    """The Phase 4 acceptance criterion, verbatim from the issue:
    Plugin().on_activate(ctx) is callable with a real PluginContext."""
    import sys

    sys.path.insert(0, str(_EXAMPLE_CORE_DIR))
    try:
        module = importlib.import_module("example_core.plugin")
    finally:
        sys.path.remove(str(_EXAMPLE_CORE_DIR))

    plugin = module.Plugin()
    assert isinstance(plugin, PluginBase)
    asyncio.run(plugin.on_activate(_build_context()))


def test_missing_name_is_rejected(tmp_path: Path) -> None:
    plugin_dir = tmp_path / "broken"
    plugin_dir.mkdir()
    (plugin_dir / "plugin.yaml").write_text(
        textwrap.dedent(
            """\
            schema: 1
            version: 0.1.0
            tier: core
            license: AGPL
            """
        ),
        encoding="utf-8",
    )

    with pytest.raises(MalformedManifest) as excinfo:
        load_manifest(plugin_dir)

    assert "name" in str(excinfo.value)
    assert excinfo.value.path == ("name",)


def test_missing_plugin_yaml_is_rejected(tmp_path: Path) -> None:
    plugin_dir = tmp_path / "empty"
    plugin_dir.mkdir()

    with pytest.raises(MalformedManifest) as excinfo:
        load_manifest(plugin_dir)

    assert "plugin.yaml" in str(excinfo.value)


def test_bad_yaml_is_rejected(tmp_path: Path) -> None:
    plugin_dir = tmp_path / "syntax"
    plugin_dir.mkdir()
    (plugin_dir / "plugin.yaml").write_text("schema: 1\n  bad:: indent\n")

    with pytest.raises(MalformedManifest) as excinfo:
        load_manifest(plugin_dir)

    assert "valid YAML" in str(excinfo.value)


def test_directory_name_mismatch_is_rejected(tmp_path: Path) -> None:
    plugin_dir = tmp_path / "not-example"
    plugin_dir.mkdir()
    (plugin_dir / "plugin.yaml").write_text(
        textwrap.dedent(
            """\
            schema: 1
            name: example-different
            version: 0.1.0
            tier: core
            license: AGPL
            """
        ),
        encoding="utf-8",
    )

    with pytest.raises(MalformedManifest) as excinfo:
        load_manifest(plugin_dir)

    assert "name" in str(excinfo.value)
    assert excinfo.value.path == ("name",)


def test_unknown_tier_is_rejected(tmp_path: Path) -> None:
    plugin_dir = tmp_path / "wrongtier"
    plugin_dir.mkdir()
    (plugin_dir / "plugin.yaml").write_text(
        textwrap.dedent(
            """\
            schema: 1
            name: wrongtier
            version: 0.1.0
            tier: enterprise
            license: AGPL
            """
        ),
        encoding="utf-8",
    )

    with pytest.raises(MalformedManifest) as excinfo:
        load_manifest(plugin_dir)

    assert "tier" in str(excinfo.value)


# ---------- helpers ------------------------------------------------------------


class _StubDb:
    def acquire(self, *args: Any, **kwargs: Any) -> Any:
        raise NotImplementedError


async def _stub_secret(key: str) -> str | None:
    return None


def _noop_register_router(router: Any) -> None:
    return None


def _noop_register_behaviours(behaviours: Iterable[Any]) -> None:
    return None


def _noop_register_tools(tools: Iterable[Any]) -> None:
    return None


def _build_context() -> PluginContext:
    return PluginContext(
        name="example-core",
        db=_StubDb(),
        secret=_stub_secret,
        register_router=_noop_register_router,
        register_behaviours=_noop_register_behaviours,
        register_tools=_noop_register_tools,
    )
