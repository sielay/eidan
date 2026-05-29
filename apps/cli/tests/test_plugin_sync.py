# SPDX-License-Identifier: AGPL-3.0-or-later
"""End-to-end tests for the lock-writer hooks + ``plugin sync`` command.

These tests stub the DB-touching helpers (matching the pattern in
``test_plugin_list_remove.py``) so they don't need a live Postgres.
The lock-file I/O and the diff-and-apply path are exercised
directly.
"""

from __future__ import annotations

from pathlib import Path

import pytest
from eidan_cli import admin, plugin_lock

FIXTURES = Path(__file__).parent / "fixtures" / "bundles"


@pytest.fixture
def plugins_dir(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    target = tmp_path / "plugins"
    target.mkdir()
    monkeypatch.setattr(admin, "PLUGINS_DIR", target)
    monkeypatch.delenv("EIDAN_PLUGIN_SOURCE", raising=False)
    monkeypatch.delenv("EIDAN_PLUGIN_LINK", raising=False)
    monkeypatch.delenv("EIDAN_GITHUB_TOKEN", raising=False)
    monkeypatch.delenv("EIDAN_PLUGIN_INSTALL_NO_MIGRATE", raising=False)
    monkeypatch.delenv("DATABASE_URL", raising=False)
    return target


@pytest.fixture
def stub_remove(monkeypatch: pytest.MonkeyPatch) -> None:
    """Skip the DB-touching tail of ``plugin remove``.

    The on-disk delete + lock update is what we want to test here;
    the alembic + lifecycle path is covered in
    ``test_plugin_list_remove.py``.
    """
    async def _noop(
        targets: list[admin._PluginEntry],
        *,
        plugins_dir: Path,  # noqa: ARG001
        database_url: str,  # noqa: ARG001
    ) -> None:
        return None

    monkeypatch.setattr(admin, "_remove_one_batch", _noop)
    monkeypatch.setenv("DATABASE_URL", "postgresql://stub@localhost/stub")


# ---------------------------------------------------------------------------
# lock write on install
# ---------------------------------------------------------------------------


def test_install_writes_lock_entries(plugins_dir: Path) -> None:
    rc = admin.plugin_install(
        bundle="example-bundle",
        from_dir=str(FIXTURES / "example-bundle"),
    )
    assert rc == 0
    entries = plugin_lock.read_lock(plugins_dir)
    by_name = {e.name: e for e in entries}
    # Both plugins from the bundle land in the lock.
    assert "example-foo" in by_name
    assert "example-bar" in by_name
    foo = by_name["example-foo"]
    assert foo.bundle == "example-bundle"
    assert foo.version == "0.1.0"
    assert foo.source.startswith("local:")


def test_install_from_local_source_env_records_source(
    plugins_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("EIDAN_PLUGIN_SOURCE", f"local:{FIXTURES}")
    rc = admin.plugin_install(bundle="example-bundle", from_dir=None)
    assert rc == 0
    entries = plugin_lock.read_lock(plugins_dir)
    # Baseline dep was resolved through the same source — it shares
    # the same source_spec.
    sources = {e.source for e in entries}
    assert sources == {f"local:{FIXTURES}"}
    bundles = {e.name: e.bundle for e in entries}
    assert bundles["example-foo"] == "example-bundle"
    assert bundles["example-baseline-plugin"] == "example-baseline"


# ---------------------------------------------------------------------------
# lock update on remove
# ---------------------------------------------------------------------------


def test_remove_drops_lock_entries(
    plugins_dir: Path, stub_remove: None
) -> None:
    # Stage: install populates the lock.
    rc = admin.plugin_install(
        bundle="example-bundle",
        from_dir=str(FIXTURES / "example-bundle"),
    )
    assert rc == 0
    before = {e.name for e in plugin_lock.read_lock(plugins_dir)}
    assert "example-foo" in before

    # Act: remove the bundle.
    rc = admin.plugin_remove("example-bundle")
    assert rc == 0

    # Assert: lock no longer mentions either plugin.
    after = {e.name for e in plugin_lock.read_lock(plugins_dir)}
    assert "example-foo" not in after
    assert "example-bar" not in after


# ---------------------------------------------------------------------------
# plugin sync — dry run, install, prune
# ---------------------------------------------------------------------------


def test_sync_dry_run_prints_plan_without_changing_disk(
    plugins_dir: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    # A lock that requires example-bundle, but disk is empty.
    plugin_lock.write_lock(
        plugins_dir,
        [
            plugin_lock.LockEntry(
                name="example-foo",
                version="0.1.0",
                bundle="example-bundle",
                source=f"local:{FIXTURES}",
            ),
        ],
    )
    rc = admin.plugin_sync(dry_run=True, prune=False)
    assert rc == 0
    out = capsys.readouterr().out
    assert "would install" in out
    assert "example-bundle" in out
    # Disk is untouched.
    assert not (plugins_dir / "example-foo").exists()


def test_sync_installs_missing_from_lock(plugins_dir: Path) -> None:
    plugin_lock.write_lock(
        plugins_dir,
        [
            plugin_lock.LockEntry(
                name="example-foo",
                version="0.1.0",
                bundle="example-bundle",
                source=f"local:{FIXTURES}",
            ),
        ],
    )
    rc = admin.plugin_sync(dry_run=False, prune=False)
    assert rc == 0
    assert (plugins_dir / "example-foo" / "plugin.yaml").is_file()
    # Bundle deps are reinstalled too (bundle.yaml -> example-baseline).
    assert (plugins_dir / "example-baseline-plugin" / "plugin.yaml").is_file()


def test_sync_in_sync_is_a_noop(
    plugins_dir: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    rc = admin.plugin_install(
        bundle="example-bundle",
        from_dir=str(FIXTURES / "example-bundle"),
    )
    assert rc == 0
    capsys.readouterr()  # drain install output.
    rc = admin.plugin_sync(dry_run=False, prune=False)
    assert rc == 0
    out = capsys.readouterr().out
    assert "in sync" in out


def test_sync_prune_removes_orphan_bundle_plugins(
    plugins_dir: Path,
    stub_remove: None,
) -> None:
    # Install via the CLI (writes lock + lands files), then hand-edit
    # the lock to drop one entry — the orphaned plugin is now eligible
    # for --prune.
    rc = admin.plugin_install(
        bundle="example-bundle",
        from_dir=str(FIXTURES / "example-bundle"),
    )
    assert rc == 0

    locked = plugin_lock.read_lock(plugins_dir)
    pruned_lock = [e for e in locked if e.name != "example-bar"]
    plugin_lock.write_lock(plugins_dir, pruned_lock)

    rc = admin.plugin_sync(dry_run=False, prune=True)
    assert rc == 0
    # example-bar is the orphan and gets pruned.
    assert not (plugins_dir / "example-bar").exists()
    # example-foo is in the lock and stays put.
    assert (plugins_dir / "example-foo" / "plugin.yaml").is_file()


def test_sync_prune_never_touches_repo_shipped_plugin(
    plugins_dir: Path, stub_remove: None
) -> None:
    # Drop a plugin into the tree with no bundle stanza — the repo-
    # shipped shape. With prune on and no lock entry, it must NOT be
    # removed.
    (plugins_dir / "repo-core").mkdir()
    (plugins_dir / "repo-core" / "plugin.yaml").write_text(
        "schema: 1\nname: repo-core\nversion: 0.1.0\ntier: core\n"
    )
    rc = admin.plugin_sync(dry_run=False, prune=True)
    assert rc == 0
    assert (plugins_dir / "repo-core" / "plugin.yaml").is_file()


def test_sync_malformed_lock_errors_cleanly(
    plugins_dir: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    (plugins_dir / ".lock").write_text("schema: 99\nplugins: []\n")
    rc = admin.plugin_sync(dry_run=False, prune=False)
    assert rc == 1
    err = capsys.readouterr().err
    assert "schema" in err
