"""Phase 4 acceptance tests for ``eidan admin plugin list / remove``.

Covers (per issue #48):

- ``plugin_list`` walks ``plugins/<name>/plugin.yaml`` and prints a
  table of name / version / tier / bundle / installed-state.
- ``plugin_remove <bundle>`` matches the manifest ``bundle.name`` and
  removes every plugin in the bundle (lifecycle hooks, alembic
  downgrade, schema drop, plugin_state row delete, on-disk delete).
- ``plugin_remove <plugin-name>`` falls back to a single-plugin
  removal when no bundle matches.
- The paid baseline auto-removes once no thematic bundle remains
  installed (`docs/018 §3`).
- A name that matches nothing yields a clean error and a non-zero
  exit code.

These tests stub the DB-touching tail of ``plugin_remove``
(``_remove_one_batch``) so they run without a Postgres dependency.
The real DB path is covered alongside the migration runner's tests
in the backend suite once the smoke harness is wired through.
"""

from __future__ import annotations

import shutil
from pathlib import Path
from typing import Any

import pytest
from eidan_cli import admin

FIXTURES = Path(__file__).parent / "fixtures" / "bundles"


@pytest.fixture
def plugins_dir(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """A throwaway ``plugins/`` directory wired into the admin module."""
    target = tmp_path / "plugins"
    target.mkdir()
    monkeypatch.setattr(admin, "PLUGINS_DIR", target)
    monkeypatch.delenv("EIDAN_PLUGIN_SOURCE", raising=False)
    monkeypatch.delenv("EIDAN_PLUGIN_LINK", raising=False)
    monkeypatch.delenv("EIDAN_GITHUB_TOKEN", raising=False)
    return target


def _install_thematic_bundle(plugins_dir: Path) -> None:
    """Stage the example-bundle plugins (foo + bar) under ``plugins/``."""
    src = FIXTURES / "example-bundle"
    for child in src.iterdir():
        if child.is_dir():
            shutil.copytree(child, plugins_dir / child.name)


def _install_baseline_bundle(plugins_dir: Path) -> None:
    """Stage the example-baseline plugin under ``plugins/``."""
    src = FIXTURES / "example-baseline"
    for child in src.iterdir():
        if child.is_dir():
            shutil.copytree(child, plugins_dir / child.name)


@pytest.fixture
def fake_db(monkeypatch: pytest.MonkeyPatch) -> dict[str, Any]:
    """Replace DB-touching helpers with in-memory fakes.

    ``plugin list`` reads ``eidan.plugin_state`` via
    ``_fetch_installed_names``; ``plugin remove`` calls
    ``_remove_one_batch`` to drive the lifecycle + migration runner.
    Replacing both avoids a real Postgres dependency for these tests.
    """
    state: dict[str, Any] = {
        "installed_names": set(),
        "remove_calls": [],
    }

    async def _fake_fetch(_url: str) -> set[str]:
        return set(state["installed_names"])

    async def _fake_remove_batch(
        targets: list[admin._PluginEntry],
        *,
        plugins_dir: Path,  # noqa: ARG001 — match real signature
        database_url: str,  # noqa: ARG001
    ) -> None:
        state["remove_calls"].append([e.name for e in targets])
        # Simulate the state-row deletion the real path would do.
        for entry in targets:
            state["installed_names"].discard(entry.name)

    monkeypatch.setattr(admin, "_fetch_installed_names", _fake_fetch)
    monkeypatch.setattr(admin, "_remove_one_batch", _fake_remove_batch)
    monkeypatch.setenv("DATABASE_URL", "postgresql://stub@localhost/stub")
    return state


# ---------------------------------------------------------------------------
# plugin list
# ---------------------------------------------------------------------------


def test_list_empty_directory_is_a_clean_zero(
    plugins_dir: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    rc = admin.plugin_list()
    assert rc == 0
    out = capsys.readouterr().out
    assert "(no plugins installed)" in out


def test_list_prints_a_table_with_bundle_and_installed_columns(
    plugins_dir: Path,
    fake_db: dict[str, Any],
    capsys: pytest.CaptureFixture[str],
) -> None:
    _install_thematic_bundle(plugins_dir)
    _install_baseline_bundle(plugins_dir)
    fake_db["installed_names"] = {"example-foo", "example-baseline-plugin"}

    rc = admin.plugin_list()
    assert rc == 0
    out = capsys.readouterr().out

    assert "NAME" in out and "VERSION" in out and "BUNDLE" in out
    # Every plugin shows up in the table.
    for name in ("example-foo", "example-bar", "example-baseline-plugin"):
        assert name in out
    # Bundle column shows the bundle name.
    assert "example-bundle" in out
    # Baseline plugins are flagged.
    assert "(baseline)" in out
    # Installed-state column is yes/no per row.
    foo_line = next(line for line in out.splitlines() if line.startswith("example-foo"))
    assert "yes" in foo_line
    bar_line = next(line for line in out.splitlines() if line.startswith("example-bar"))
    assert "no" in bar_line


def test_list_without_database_url_still_prints(
    plugins_dir: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    _install_thematic_bundle(plugins_dir)
    monkeypatch.delenv("DATABASE_URL", raising=False)

    rc = admin.plugin_list()
    assert rc == 0
    captured = capsys.readouterr()
    assert "example-foo" in captured.out
    assert "DATABASE_URL" in captured.err


# ---------------------------------------------------------------------------
# plugin remove
# ---------------------------------------------------------------------------


def test_remove_unknown_target_errors_cleanly(
    plugins_dir: Path,
    fake_db: dict[str, Any],
    capsys: pytest.CaptureFixture[str],
) -> None:
    rc = admin.plugin_remove("does-not-exist")
    assert rc == 1
    err = capsys.readouterr().err
    assert "does-not-exist" in err


def test_remove_with_no_argument_returns_usage(
    plugins_dir: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    rc = admin.plugin_remove(None)
    assert rc == 2
    err = capsys.readouterr().err
    assert "usage" in err


def test_remove_single_plugin_by_name(
    plugins_dir: Path,
    fake_db: dict[str, Any],
    capsys: pytest.CaptureFixture[str],
) -> None:
    _install_thematic_bundle(plugins_dir)
    fake_db["installed_names"] = {"example-foo", "example-bar"}

    rc = admin.plugin_remove("example-bar")
    assert rc == 0

    # On-disk: only example-bar removed; example-foo stays.
    assert not (plugins_dir / "example-bar").exists()
    assert (plugins_dir / "example-foo").exists()

    # Lifecycle hook runner saw exactly the targeted plugin.
    assert fake_db["remove_calls"] == [["example-bar"]]


def test_remove_bundle_removes_every_member_plugin(
    plugins_dir: Path,
    fake_db: dict[str, Any],
    capsys: pytest.CaptureFixture[str],
) -> None:
    _install_thematic_bundle(plugins_dir)
    fake_db["installed_names"] = {"example-foo", "example-bar"}

    rc = admin.plugin_remove("example-bundle")
    assert rc == 0

    # Both plugins gone from disk.
    assert not (plugins_dir / "example-foo").exists()
    assert not (plugins_dir / "example-bar").exists()

    # The lifecycle helper saw both plugins in one batch.
    assert len(fake_db["remove_calls"]) == 1
    assert sorted(fake_db["remove_calls"][0]) == ["example-bar", "example-foo"]

    out = capsys.readouterr().out
    assert "removed plugins/example-foo/" in out
    assert "removed plugins/example-bar/" in out


def test_remove_last_thematic_bundle_auto_removes_baseline(
    plugins_dir: Path,
    fake_db: dict[str, Any],
    capsys: pytest.CaptureFixture[str],
) -> None:
    """Per `docs/018 §3`: paid baseline goes when the last thematic does."""
    _install_thematic_bundle(plugins_dir)
    _install_baseline_bundle(plugins_dir)
    fake_db["installed_names"] = {
        "example-foo",
        "example-bar",
        "example-baseline-plugin",
    }

    rc = admin.plugin_remove("example-bundle")
    assert rc == 0

    # All three plugins gone — the thematic ones plus the baseline.
    assert not (plugins_dir / "example-foo").exists()
    assert not (plugins_dir / "example-bar").exists()
    assert not (plugins_dir / "example-baseline-plugin").exists()

    # Two batches: thematic first, then baseline as the auto-removal.
    assert len(fake_db["remove_calls"]) == 2
    assert sorted(fake_db["remove_calls"][0]) == ["example-bar", "example-foo"]
    assert fake_db["remove_calls"][1] == ["example-baseline-plugin"]

    out = capsys.readouterr().out
    assert "removed plugins/example-baseline-plugin/" in out


def test_remove_bundle_keeps_baseline_when_other_thematic_remains(
    plugins_dir: Path,
    fake_db: dict[str, Any],
    tmp_path: Path,
) -> None:
    """A second thematic bundle keeps the baseline alive after one removal."""
    _install_thematic_bundle(plugins_dir)
    _install_baseline_bundle(plugins_dir)

    # Stage a second thematic plugin in a different bundle so removing
    # `example-bundle` leaves at least one thematic plugin behind.
    other = plugins_dir / "example-other"
    other.mkdir()
    (other / "plugin.yaml").write_text(
        "schema: 1\n"
        "name: example-other\n"
        "version: 0.1.0\n"
        "tier: core\n"
        "license: AGPL\n"
        "bundle:\n"
        "  name: example-other-bundle\n"
        "  kind: thematic\n"
        "backend:\n"
        "  entrypoint: example_other.plugin:Plugin\n",
        encoding="utf-8",
    )

    rc = admin.plugin_remove("example-bundle")
    assert rc == 0

    assert not (plugins_dir / "example-foo").exists()
    assert (plugins_dir / "example-baseline-plugin").exists()
    assert (plugins_dir / "example-other").exists()
    # Only one batch ran — no auto-baseline triggered.
    assert len(fake_db["remove_calls"]) == 1


def test_resolve_targets_prefers_bundle_over_name_when_both_match(
    plugins_dir: Path,
) -> None:
    """A bundle name that happens to also be a plugin name resolves to the bundle."""
    _install_thematic_bundle(plugins_dir)

    # Stage a plugin literally named "example-bundle" alongside the
    # actual bundle members. The resolver should still pick the
    # bundle membership match (two plugins) over the single-name
    # match.
    homonym = plugins_dir / "example-bundle"
    homonym.mkdir()
    (homonym / "plugin.yaml").write_text(
        "schema: 1\n"
        "name: example-bundle\n"
        "version: 0.1.0\n"
        "tier: core\n"
        "license: AGPL\n"
        "backend:\n"
        "  entrypoint: example_bundle.plugin:Plugin\n",
        encoding="utf-8",
    )

    entries = admin._scan_plugins(plugins_dir)
    targets = admin._resolve_remove_targets("example-bundle", entries)
    target_names = {t.name for t in targets}
    assert target_names == {"example-foo", "example-bar"}
