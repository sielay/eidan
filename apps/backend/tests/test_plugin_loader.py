"""Phase 4 acceptance tests for the plugin loader + lifecycle runner.

Covers (per the issue):

- ``load_plugins`` walks ``plugins/<name>/``, validates each manifest,
  imports each ``backend.entrypoint``, and returns
  :class:`LoadedPlugin` instances.
- Results are topologically sorted by ``depends_on``; cycles raise
  :class:`PluginCycleError`; missing deps raise
  :class:`PluginMissingDependencyError`.
- ``install_and_activate`` runs ``on_install`` only when the plugin is
  not yet in the state store, then always runs ``on_activate`` — and a
  second pass over the same plugins skips ``on_install``.
- ``deactivate`` walks the plugin list in reverse.
- The :class:`AsyncpgPluginStateStore` round-trips against the real
  ``eidan.plugin_state`` table from the Phase 1.5 ephemeral-Postgres
  fixture.
"""

from __future__ import annotations

import asyncio
import sys
import textwrap
from collections.abc import Iterable
from pathlib import Path
from typing import Any

import pytest
from eidan_backend.plugins import (
    AsyncpgPluginStateStore,
    LoadedPlugin,
    PluginBase,
    PluginContext,
    PluginCycleError,
    PluginLoadError,
    PluginMissingDependencyError,
    deactivate,
    install_and_activate,
    load_plugins,
    uninstall,
)

_REPO_ROOT = Path(__file__).resolve().parents[3]
_REAL_PLUGINS_DIR = _REPO_ROOT / "plugins"


# ---------- discovery + topology ----------------------------------------------


def test_load_plugins_discovers_real_plugins_dir() -> None:
    """The repo's ``plugins/`` carries example-core and example-behaviour;
    the loader picks both up and instantiates real :class:`PluginBase`
    subclasses."""
    loaded = load_plugins(_REAL_PLUGINS_DIR)
    names = [p.manifest.name for p in loaded]
    assert "example-core" in names
    assert "example-behaviour" in names
    for lp in loaded:
        assert isinstance(lp.plugin, PluginBase)
        assert lp.plugin_dir.is_dir()


def test_load_plugins_returns_empty_for_missing_dir(tmp_path: Path) -> None:
    assert load_plugins(tmp_path / "absent") == []


def test_load_plugins_skips_gitkeep_and_dotfiles(tmp_path: Path) -> None:
    (tmp_path / ".gitkeep").write_text("", encoding="utf-8")
    (tmp_path / ".hidden").mkdir()
    (tmp_path / ".hidden" / "plugin.yaml").write_text("schema: 1\n")
    assert load_plugins(tmp_path) == []


def _write_simple_plugin(
    tmp_path: Path,
    name: str,
    *,
    depends_on: list[str] | None = None,
) -> Path:
    """Materialise a minimal plugin tree under ``tmp_path / name``.

    The plugin has a tiny ``Plugin(PluginBase)`` whose hooks all
    no-op — enough for the loader to import it and the runner to
    drive lifecycle hooks against it.
    """
    plugin_dir = tmp_path / name
    plugin_dir.mkdir()
    pkg = name.replace("-", "_")
    (plugin_dir / pkg).mkdir()
    (plugin_dir / pkg / "__init__.py").write_text("", encoding="utf-8")
    (plugin_dir / pkg / "plugin.py").write_text(
        textwrap.dedent(
            """\
            from eidan_backend.plugins import PluginBase

            class Plugin(PluginBase):
                name = "{name}"
            """
        ).format(name=name),
        encoding="utf-8",
    )

    depends_block = ""
    if depends_on:
        depends_block = "depends_on:\n"
        for dep in depends_on:
            depends_block += f'  - name: {dep}\n    version: ">=0.0.0"\n'

    (plugin_dir / "plugin.yaml").write_text(
        textwrap.dedent(
            """\
            schema: 1
            name: {name}
            version: 0.1.0
            tier: core
            license: AGPL
            backend:
              entrypoint: {pkg}.plugin:Plugin
            {depends_block}"""
        ).format(name=name, pkg=pkg, depends_block=depends_block),
        encoding="utf-8",
    )
    return plugin_dir


def test_topological_sort_respects_depends_on(tmp_path: Path) -> None:
    plugins_dir = tmp_path / "plugins"
    plugins_dir.mkdir()
    # b depends on a, c depends on b. Lexical order would be a/b/c too,
    # so add a fourth plugin "z" with no deps to confirm we are not just
    # sorting lexically by luck — z has no deps so it should still come
    # out alongside a (both have in_degree 0, alpha-tied).
    _write_simple_plugin(plugins_dir, "a")
    _write_simple_plugin(plugins_dir, "b", depends_on=["a"])
    _write_simple_plugin(plugins_dir, "c", depends_on=["b"])
    _write_simple_plugin(plugins_dir, "z")

    loaded = load_plugins(plugins_dir)
    order = [p.manifest.name for p in loaded]
    # Dependency invariant: a precedes b, b precedes c.
    assert order.index("a") < order.index("b") < order.index("c")
    # z has no deps so a (also no deps) precedes it (alpha tiebreak).
    assert order.index("a") < order.index("z")
    assert set(order) == {"a", "b", "c", "z"}


def test_cycle_is_rejected(tmp_path: Path) -> None:
    plugins_dir = tmp_path / "plugins"
    plugins_dir.mkdir()
    _write_simple_plugin(plugins_dir, "a", depends_on=["b"])
    _write_simple_plugin(plugins_dir, "b", depends_on=["a"])

    with pytest.raises(PluginCycleError):
        load_plugins(plugins_dir)


def test_missing_dependency_is_rejected(tmp_path: Path) -> None:
    plugins_dir = tmp_path / "plugins"
    plugins_dir.mkdir()
    _write_simple_plugin(plugins_dir, "a", depends_on=["does-not-exist"])

    with pytest.raises(PluginMissingDependencyError) as exc:
        load_plugins(plugins_dir)
    assert exc.value.plugin_name == "a"


def test_missing_backend_entrypoint_is_rejected(tmp_path: Path) -> None:
    plugin_dir = tmp_path / "noback"
    plugin_dir.mkdir()
    (plugin_dir / "plugin.yaml").write_text(
        textwrap.dedent(
            """\
            schema: 1
            name: noback
            version: 0.1.0
            tier: core
            license: AGPL
            """
        ),
        encoding="utf-8",
    )

    with pytest.raises(PluginLoadError):
        load_plugins(tmp_path)


def test_non_pluginbase_class_is_rejected(tmp_path: Path) -> None:
    plugin_dir = tmp_path / "wrongcls"
    plugin_dir.mkdir()
    pkg = "wrongcls"
    (plugin_dir / pkg).mkdir()
    (plugin_dir / pkg / "__init__.py").write_text("", encoding="utf-8")
    (plugin_dir / pkg / "plugin.py").write_text(
        "class Plugin:\n    pass\n", encoding="utf-8"
    )
    (plugin_dir / "plugin.yaml").write_text(
        textwrap.dedent(
            """\
            schema: 1
            name: wrongcls
            version: 0.1.0
            tier: core
            license: AGPL
            backend:
              entrypoint: wrongcls.plugin:Plugin
            """
        ),
        encoding="utf-8",
    )

    with pytest.raises(PluginLoadError, match="PluginBase subclass"):
        load_plugins(tmp_path)


# ---------- disabled plugins --------------------------------------------------


def test_disabled_excludes_named_plugins(tmp_path: Path) -> None:
    """A plugin listed in ``disabled`` is not loaded; the others are."""
    plugins_dir = tmp_path / "plugins"
    plugins_dir.mkdir()
    _write_simple_plugin(plugins_dir, "alpha")
    _write_simple_plugin(plugins_dir, "beta")
    _write_simple_plugin(plugins_dir, "gamma")

    loaded = load_plugins(plugins_dir, disabled=["beta"])
    names = [p.manifest.name for p in loaded]
    assert names == ["alpha", "gamma"]


def test_disabled_empty_iterable_is_a_no_op(tmp_path: Path) -> None:
    """``disabled=[]`` matches ``disabled=None`` — nothing is filtered."""
    plugins_dir = tmp_path / "plugins"
    plugins_dir.mkdir()
    _write_simple_plugin(plugins_dir, "alpha")
    _write_simple_plugin(plugins_dir, "beta")

    none_pass = load_plugins(plugins_dir, disabled=None)
    empty_pass = load_plugins(plugins_dir, disabled=[])

    assert {p.manifest.name for p in none_pass} == {"alpha", "beta"}
    assert {p.manifest.name for p in empty_pass} == {"alpha", "beta"}


def test_disabled_trims_whitespace_and_drops_empty_entries(tmp_path: Path) -> None:
    """Whitespace is stripped per entry; empty / whitespace-only entries
    are skipped so an operator can pad the env-var value cosmetically
    without breaking matching."""
    plugins_dir = tmp_path / "plugins"
    plugins_dir.mkdir()
    _write_simple_plugin(plugins_dir, "alpha")
    _write_simple_plugin(plugins_dir, "beta")

    loaded = load_plugins(plugins_dir, disabled=[" alpha ", "", "  ", "\tbeta"])
    assert loaded == []


def test_disabled_unknown_name_emits_warning_but_does_not_raise(
    tmp_path: Path,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """An operator's env var typically applies across nodes with
    different installed bundles. Unknown names are a soft warning so
    "imap not installed on this Pi" doesn't crash the boot."""
    plugins_dir = tmp_path / "plugins"
    plugins_dir.mkdir()
    _write_simple_plugin(plugins_dir, "alpha")

    caplog.set_level("WARNING", logger="eidan_backend.plugins.loader")
    loaded = load_plugins(plugins_dir, disabled=["nope", "alpha"])

    assert [p.manifest.name for p in loaded] == []
    assert any(
        "EIDAN_DISABLED_PLUGINS references unknown plugin(s): nope" in r.message
        for r in caplog.records
    )


def test_disabled_logs_summary_at_info(
    tmp_path: Path,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """One ``[plugins] disabled by EIDAN_DISABLED_PLUGINS: ...`` line at
    info level so operators can grep for it in journald / Fly logs."""
    plugins_dir = tmp_path / "plugins"
    plugins_dir.mkdir()
    _write_simple_plugin(plugins_dir, "alpha")
    _write_simple_plugin(plugins_dir, "beta")

    caplog.set_level("INFO", logger="eidan_backend.plugins.loader")
    load_plugins(plugins_dir, disabled=["alpha"])

    summary = [
        r for r in caplog.records if "disabled by EIDAN_DISABLED_PLUGINS" in r.message
    ]
    assert len(summary) == 1
    assert summary[0].levelname == "INFO"
    assert "alpha" in summary[0].message


def test_disabled_dependency_surfaces_existing_missing_dep_error(
    tmp_path: Path,
) -> None:
    """If the operator disables a plugin that's a dependency of another
    plugin, the existing :class:`PluginMissingDependencyError` fires.
    We don't add disable-awareness to the topological sort — the error
    is informative enough on its own."""
    plugins_dir = tmp_path / "plugins"
    plugins_dir.mkdir()
    _write_simple_plugin(plugins_dir, "alpha")
    _write_simple_plugin(plugins_dir, "beta", depends_on=["alpha"])

    with pytest.raises(PluginMissingDependencyError) as exc:
        load_plugins(plugins_dir, disabled=["alpha"])
    assert exc.value.plugin_name == "beta"


# ---------- lifecycle runner --------------------------------------------------


class _InMemoryStateStore:
    """In-memory :class:`PluginStateStore` used by the lifecycle tests."""

    def __init__(self) -> None:
        self.rows: dict[str, str] = {}
        self.marks: list[tuple[str, str]] = []
        self.unmarks: list[str] = []

    async def is_installed(self, name: str) -> bool:
        return name in self.rows

    async def mark_installed(self, name: str, version: str) -> None:
        self.rows[name] = version
        self.marks.append((name, version))

    async def mark_uninstalled(self, name: str) -> None:
        self.rows.pop(name, None)
        self.unmarks.append(name)


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


def _build_context_for(loaded: LoadedPlugin) -> PluginContext:
    return PluginContext(
        name=loaded.manifest.name,
        db=_StubDb(),
        secret=_stub_secret,
        register_router=_noop_register_router,
        register_behaviours=_noop_register_behaviours,
        register_tools=_noop_register_tools,
    )


def _load_example_core_only(tmp_path: Path) -> list[LoadedPlugin]:
    """Stage just ``plugins/example-core/`` under ``tmp_path`` and load.

    The real ``plugins/`` directory carries multiple plugins; this
    helper isolates example-core so the acceptance assertions on its
    ``hook_log`` aren't fighting another plugin's print output.
    """
    src = _REAL_PLUGINS_DIR / "example-core"
    dst = tmp_path / "example-core"
    _copy_tree(src, dst)
    return load_plugins(tmp_path)


def _copy_tree(src: Path, dst: Path) -> None:
    """Tiny ``shutil.copytree`` substitute that skips compiled caches."""
    import shutil

    shutil.copytree(src, dst, ignore=shutil.ignore_patterns("__pycache__"))


def test_install_and_activate_runs_on_install_once(tmp_path: Path) -> None:
    """Phase 4 acceptance: first start runs on_install + on_activate;
    second start skips on_install."""
    # Make sure a previous test didn't leave example_core in sys.modules
    # pointing at a different copy.
    sys.modules.pop("example_core", None)
    sys.modules.pop("example_core.plugin", None)

    loaded = _load_example_core_only(tmp_path)
    assert [p.manifest.name for p in loaded] == ["example-core"]

    from example_core import plugin as example_core_plugin  # noqa: PLC0415

    example_core_plugin.reset_hook_log()

    state = _InMemoryStateStore()

    asyncio.run(
        install_and_activate(loaded, state=state, context_factory=_build_context_for)
    )
    assert example_core_plugin.hook_log == ["on_install", "on_activate"]
    assert state.marks == [("example-core", "0.1.0")]

    # Second start: state already has the row, so on_install is skipped.
    example_core_plugin.reset_hook_log()
    asyncio.run(
        install_and_activate(loaded, state=state, context_factory=_build_context_for)
    )
    assert example_core_plugin.hook_log == ["on_activate"]
    # No second mark_installed call — the row was already present.
    assert state.marks == [("example-core", "0.1.0")]


def test_deactivate_runs_in_reverse_topological_order(tmp_path: Path) -> None:
    plugins_dir = tmp_path / "plugins"
    plugins_dir.mkdir()
    _write_simple_plugin(plugins_dir, "a")
    _write_simple_plugin(plugins_dir, "b", depends_on=["a"])
    _write_simple_plugin(plugins_dir, "c", depends_on=["b"])

    loaded = load_plugins(plugins_dir)
    assert [p.manifest.name for p in loaded] == ["a", "b", "c"]

    calls: list[str] = []

    class Recorder(PluginBase):
        def __init__(self, who: str) -> None:
            super().__init__()
            self._who = who

        async def on_deactivate(self, ctx: PluginContext) -> None:
            calls.append(self._who)

    # Swap in recorder instances so we can observe ordering. The dataclass
    # is frozen, so build replacements.
    recorders = [
        LoadedPlugin(
            manifest=p.manifest,
            plugin=Recorder(p.manifest.name),
            plugin_dir=p.plugin_dir,
        )
        for p in loaded
    ]
    asyncio.run(deactivate(recorders, context_factory=_build_context_for))

    assert calls == ["c", "b", "a"]


def test_uninstall_runs_deactivate_then_uninstall_in_reverse_order(
    tmp_path: Path,
) -> None:
    """``uninstall`` mirrors ``deactivate`` ordering and also drives ``on_uninstall``.

    Phase 4 acceptance for issue #48: the operator-driven uninstall
    path runs both teardown hooks per plugin and clears the plugin's
    row from the state store. The order is reverse topological so a
    plugin's tear-down precedes any of its dependencies'.
    """
    plugins_dir = tmp_path / "plugins"
    plugins_dir.mkdir()
    _write_simple_plugin(plugins_dir, "a")
    _write_simple_plugin(plugins_dir, "b", depends_on=["a"])

    loaded = load_plugins(plugins_dir)
    assert [p.manifest.name for p in loaded] == ["a", "b"]

    calls: list[str] = []

    class Recorder(PluginBase):
        def __init__(self, who: str) -> None:
            super().__init__()
            self._who = who

        async def on_deactivate(self, ctx: PluginContext) -> None:
            calls.append(f"deactivate:{self._who}")

        async def on_uninstall(self, ctx: PluginContext) -> None:
            calls.append(f"uninstall:{self._who}")

    recorders = [
        LoadedPlugin(
            manifest=p.manifest,
            plugin=Recorder(p.manifest.name),
            plugin_dir=p.plugin_dir,
        )
        for p in loaded
    ]

    state = _InMemoryStateStore()
    state.rows = {"a": "0.1.0", "b": "0.1.0"}

    asyncio.run(
        uninstall(recorders, state=state, context_factory=_build_context_for)
    )

    # Per-plugin order: deactivate then uninstall. Across plugins:
    # reverse topological — `b` (the dependent) tears down before `a`.
    assert calls == [
        "deactivate:b",
        "uninstall:b",
        "deactivate:a",
        "uninstall:a",
    ]
    # mark_uninstalled fired for each plugin in the same reverse order.
    assert state.unmarks == ["b", "a"]
    # The state store no longer reports the plugins as installed.
    assert state.rows == {}


# ---------- AsyncpgPluginStateStore round-trip --------------------------------


@pytest.mark.asyncio
async def test_plugin_state_store_round_trips_against_real_db(
    eidan_db: str,
) -> None:
    """The asyncpg-backed store inserts and reads through
    ``eidan.plugin_state``. Uses the Phase 1.5 ephemeral-PG fixture so
    we exercise the real migration that ships the table."""
    from eidan_backend.db import create_pool  # noqa: PLC0415

    pool = await create_pool(eidan_db)
    try:
        store = AsyncpgPluginStateStore(pool)
        assert not await store.is_installed("example-core")

        await store.mark_installed("example-core", "0.1.0")
        assert await store.is_installed("example-core")

        # mark_installed is idempotent (ON CONFLICT DO UPDATE).
        await store.mark_installed("example-core", "0.2.0")
        async with pool.acquire() as conn:
            row = await conn.fetchrow(
                "SELECT version FROM eidan.plugin_state WHERE name = $1",
                "example-core",
            )
        assert row is not None and row["version"] == "0.2.0"
    finally:
        await pool.close()
