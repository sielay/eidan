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
    IncompatibleManifest,
    MalformedManifest,
    PluginBase,
    PluginContext,
    load_manifest,
)
from eidan_backend.plugins import manifest as _manifest_module

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
        "notify_topic",
        "spawn_turn",
        "assess_sufficiency",
        "publish_event",
        "register_capabilities",
        "artifacts",
        "escalate",
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


def test_manifest_accepts_known_behaviour_kind(tmp_path: Path) -> None:
    """`kind:` joins the existing behaviour fields per docs/026.
    Verify the four declared values flow through manifest
    validation; the default (`llm_turn`) sticks when omitted."""
    plugin_dir = tmp_path / "kinds"
    plugin_dir.mkdir()
    (plugin_dir / "plugin.yaml").write_text(
        textwrap.dedent(
            """\
            schema: 1
            name: kinds
            version: 0.1.0
            tier: core
            license: AGPL
            behaviours:
              - id: kinds:t1
                trigger: event:x
                handler: kinds.handlers:t1
                kind: tool_chain
              - id: kinds:t2
                trigger: event:y
                handler: kinds.handlers:t2
                # kind omitted — defaults to llm_turn
            """
        ),
        encoding="utf-8",
    )
    manifest = load_manifest(plugin_dir)
    assert manifest.behaviours[0].kind == "tool_chain"
    assert manifest.behaviours[1].kind == "llm_turn"


def test_in_tree_plugins_declare_expected_behaviour_kinds() -> None:
    """Regression for slice 2 of docs/026: in-tree plugins re-tagged
    with their dispatch intent. example-behaviour:tick is pure
    bookkeeping (`tool_chain`); sentry:tick is the canonical
    introspective loop (`llm_turn`, explicit even though it's the
    default)."""
    plugins_dir = Path(__file__).resolve().parents[3] / "plugins"

    example_manifest = load_manifest(plugins_dir / "example-behaviour")
    assert example_manifest.behaviours is not None
    assert example_manifest.behaviours[0].id == "example-behaviour:tick"
    assert example_manifest.behaviours[0].kind == "tool_chain"

    sentry_manifest = load_manifest(plugins_dir / "sentry")
    assert sentry_manifest.behaviours is not None
    assert sentry_manifest.behaviours[0].id == "sentry:tick"
    assert sentry_manifest.behaviours[0].kind == "llm_turn"


def test_manifest_rejects_unknown_behaviour_kind(tmp_path: Path) -> None:
    """Anything outside the enum trips the strict schema, same
    posture as the unknown-tier check above. A typo'd kind
    should fail at manifest-load, not propagate to the
    dispatcher."""
    plugin_dir = tmp_path / "badkind"
    plugin_dir.mkdir()
    (plugin_dir / "plugin.yaml").write_text(
        textwrap.dedent(
            """\
            schema: 1
            name: badkind
            version: 0.1.0
            tier: core
            license: AGPL
            behaviours:
              - id: badkind:t
                trigger: event:x
                handler: badkind.handlers:t
                kind: garbage
            """
        ),
        encoding="utf-8",
    )

    with pytest.raises(MalformedManifest) as excinfo:
        load_manifest(plugin_dir)

    assert "kind" in str(excinfo.value)


# ---------- host.eidan pre-gate ------------------------------------------------


def _write_minimum_manifest(
    plugin_dir: Path, name: str, *, host_eidan: str | None = None, extra: str = ""
) -> None:
    """Write a minimal valid manifest for the gate / notifications tests.

    ``extra`` is appended verbatim before validation, so callers can
    add a ``notifications:`` block (or an intentionally-bad field)
    without re-stating the boilerplate."""
    host_block = f"host:\n  eidan: '{host_eidan}'\n" if host_eidan else ""
    (plugin_dir / "plugin.yaml").write_text(
        textwrap.dedent(
            f"""\
            schema: 1
            name: {name}
            version: 0.1.0
            tier: pro
            license: Proprietary
            """
        )
        + host_block
        + extra,
        encoding="utf-8",
    )


def test_host_eidan_gate_rejects_when_core_too_old(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A plugin pinning a constraint our core can't satisfy raises
    :class:`IncompatibleManifest` BEFORE strict schema validation,
    so the operator sees the version mismatch rather than a confusing
    `extra_forbidden` error from an unrelated schema-drift field."""
    monkeypatch.setattr(_manifest_module, "_current_core_version", lambda: "0.1.0")

    plugin_dir = tmp_path / "future-plugin"
    plugin_dir.mkdir()
    _write_minimum_manifest(
        plugin_dir,
        "future-plugin",
        host_eidan=">=0.99.0",
        # Intentionally-bogus field that would also trigger schema rejection.
        # The host gate must fire FIRST so this never surfaces.
        extra="madeup_field: 42\n",
    )

    with pytest.raises(IncompatibleManifest) as excinfo:
        load_manifest(plugin_dir)

    assert excinfo.value.plugin_name == "future-plugin"
    assert excinfo.value.required == ">=0.99.0"
    assert excinfo.value.current == "0.1.0"


def test_host_eidan_gate_passes_when_constraint_satisfied(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A satisfiable ``host.eidan`` constraint is a no-op — manifest
    continues through strict validation and loads normally."""
    monkeypatch.setattr(_manifest_module, "_current_core_version", lambda: "0.2.0")

    plugin_dir = tmp_path / "happy-plugin"
    plugin_dir.mkdir()
    _write_minimum_manifest(plugin_dir, "happy-plugin", host_eidan=">=0.1.0")

    manifest = load_manifest(plugin_dir)
    assert manifest.name == "happy-plugin"


def test_host_eidan_gate_skipped_when_absent(tmp_path: Path) -> None:
    """Plugins without a ``host`` block (or without ``host.eidan``)
    are not gated — the manifest goes straight to schema validation."""
    plugin_dir = tmp_path / "ungated"
    plugin_dir.mkdir()
    _write_minimum_manifest(plugin_dir, "ungated")  # no host block

    manifest = load_manifest(plugin_dir)
    assert manifest.name == "ungated"


def test_unparseable_host_eidan_specifier_does_not_raise_incompatible(
    tmp_path: Path,
) -> None:
    """A specifier the gate can't parse (e.g. ``"^0.2.0"`` — npm-style,
    not PEP 440) is a no-op for the host gate. The manifest schema
    types ``host.eidan`` as a free string, so this loads cleanly
    today; tightening that string into a PEP 440 specifier pattern
    is a separate follow-up. The point of this test is that an
    unparseable spec does NOT raise :class:`IncompatibleManifest` —
    the gate refuses to guess."""
    plugin_dir = tmp_path / "bad-spec"
    plugin_dir.mkdir()
    _write_minimum_manifest(plugin_dir, "bad-spec", host_eidan="^0.2.0")

    manifest = load_manifest(plugin_dir)
    assert manifest.name == "bad-spec"


# ---------- notifications.adapters[] schema acceptance -------------------------


def test_notifications_adapters_block_is_accepted(tmp_path: Path) -> None:
    """The manifest schema accepts a ``notifications.adapters[]`` block
    with ``channel`` + ``factory`` per entry — the seam paid bundles
    use to declare outbound notification adapters (docs/001 §6)."""
    plugin_dir = tmp_path / "notifier"
    plugin_dir.mkdir()
    _write_minimum_manifest(
        plugin_dir,
        "notifier",
        extra=textwrap.dedent(
            """\
            notifications:
              adapters:
                - channel: slack
                  factory: example.module:build_adapter
            """
        ),
    )

    manifest = load_manifest(plugin_dir)
    assert manifest.notifications is not None
    assert len(manifest.notifications.adapters) == 1
    entry = manifest.notifications.adapters[0]
    assert entry.channel == "slack"
    assert entry.factory == "example.module:build_adapter"


def test_notifications_adapter_invalid_channel_is_rejected(
    tmp_path: Path,
) -> None:
    """Channel slugs must match the kebab-style pattern. A leading
    digit followed by a colon (looks like an entrypoint) is rejected."""
    plugin_dir = tmp_path / "badchan"
    plugin_dir.mkdir()
    _write_minimum_manifest(
        plugin_dir,
        "badchan",
        extra=textwrap.dedent(
            """\
            notifications:
              adapters:
                - channel: "Slack!"
                  factory: example.module:build_adapter
            """
        ),
    )

    with pytest.raises(MalformedManifest) as excinfo:
        load_manifest(plugin_dir)

    assert "channel" in str(excinfo.value)


def test_notifications_adapter_invalid_factory_entrypoint_is_rejected(
    tmp_path: Path,
) -> None:
    """``factory`` must be a ``module:func`` entrypoint — a bare name
    or missing colon is rejected."""
    plugin_dir = tmp_path / "badfactory"
    plugin_dir.mkdir()
    _write_minimum_manifest(
        plugin_dir,
        "badfactory",
        extra=textwrap.dedent(
            """\
            notifications:
              adapters:
                - channel: slack
                  factory: build_adapter
            """
        ),
    )

    with pytest.raises(MalformedManifest) as excinfo:
        load_manifest(plugin_dir)

    assert "factory" in str(excinfo.value)


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
