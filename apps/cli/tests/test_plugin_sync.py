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
    monkeypatch.delenv("EIDAN_PLUGIN_INSTALL_NO_LOCK", raising=False)
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


def test_sync_prune_recomputes_after_install_picks_up_new_deps(
    plugins_dir: Path, stub_remove: None
) -> None:
    """``--prune`` removes transitive deps pulled in by sync's own installs.

    Scenario: the operator's lock declares ``example-bundle``'s own
    plugins (foo + bar) but omits the transitive baseline plugin. The
    install path auto-resolves ``bundle.yaml`` ``depends_on``, so a
    sync install lands ``example-baseline-plugin`` on disk too. That
    new directory is a bundle-installed plugin not in the lock — i.e.
    a legitimate prune candidate. The pre-install prune plan was
    empty (the dep didn't exist yet on disk), so the executor must
    recompute against post-install state to converge in one run.
    """
    operator_lock = [
        plugin_lock.LockEntry(
            name="example-foo",
            version="0.1.0",
            bundle="example-bundle",
            source=f"local:{FIXTURES}",
        ),
        plugin_lock.LockEntry(
            name="example-bar",
            version="0.1.0",
            bundle="example-bundle",
            source=f"local:{FIXTURES}",
        ),
    ]
    plugin_lock.write_lock(plugins_dir, operator_lock)

    rc = admin.plugin_sync(dry_run=False, prune=True)
    assert rc == 0
    # Locked plugins land.
    assert (plugins_dir / "example-foo" / "plugin.yaml").is_file()
    assert (plugins_dir / "example-bar" / "plugin.yaml").is_file()
    # Transitive dep is pruned in the same run (was not in lock).
    assert not (plugins_dir / "example-baseline-plugin").exists()


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


def test_sync_install_does_not_mutate_operator_lock(
    plugins_dir: Path,
) -> None:
    """``plugin sync`` reinstalls a bundle without rewriting the lock.

    The fixture bundle pulls in a transitive baseline dep. A naïve
    ``sync → plugin_install → _record_install_in_lock`` chain would
    upsert that baseline plugin into the operator's lock, making sync
    re-declare what it was supposed to merely apply. With
    ``EIDAN_PLUGIN_INSTALL_NO_LOCK`` wired in by ``plugin_sync`` the
    lock the operator wrote stays byte-identical after the run.
    """
    operator_lock = [
        plugin_lock.LockEntry(
            name="example-foo",
            version="0.1.0",
            bundle="example-bundle",
            source=f"local:{FIXTURES}",
        ),
    ]
    plugin_lock.write_lock(plugins_dir, operator_lock)
    before = (plugins_dir / ".lock").read_text()

    rc = admin.plugin_sync(dry_run=False, prune=False)
    assert rc == 0
    # Files landed (dep included).
    assert (plugins_dir / "example-foo" / "plugin.yaml").is_file()
    assert (plugins_dir / "example-baseline-plugin" / "plugin.yaml").is_file()
    # Lock untouched — the operator's declared file is the source of
    # truth here, the install path must not rewrite it.
    assert (plugins_dir / ".lock").read_text() == before


def test_sync_prune_does_not_take_down_bundle_when_orphan_name_collides(
    plugins_dir: Path, stub_remove: None
) -> None:
    """``--prune`` MUST resolve orphans by plugin name only.

    The bundle/plugin-name overload in ``_resolve_remove_targets``
    matches ``bundle.name`` first when called without the safety
    flag. If a sync-orphan plugin name happens to equal an installed
    ``bundle.name`` (collision can happen with paid bundles that ship
    a same-named convenience plugin), the old prune path would take
    the whole bundle down — including plugins the lock explicitly
    declares should stay.

    Setup: install ``example-bundle`` (two locked plugins), then add
    a third bundle-installed plugin **named** ``example-bundle`` from
    a separate bundle stanza; that orphan plugin is the prune target.
    Expected: only the orphan disappears; both ``example-foo`` and
    ``example-bar`` stay because they are still in the lock.
    """
    rc = admin.plugin_install(
        bundle="example-bundle",
        from_dir=str(FIXTURES / "example-bundle"),
    )
    assert rc == 0

    # Add a colliding orphan: plugin whose name == another installed
    # bundle's name. It has its own bundle stanza so it is prune-
    # eligible, and it is NOT in the lock so it is an orphan.
    colliding = plugins_dir / "example-bundle"
    colliding.mkdir()
    (colliding / "plugin.yaml").write_text(
        "schema: 1\n"
        "name: example-bundle\n"
        "version: 0.1.0\n"
        "tier: core\n"
        "bundle:\n"
        "  name: paid-collision\n"
        "  kind: thematic\n"
    )

    rc = admin.plugin_sync(dry_run=False, prune=True)
    assert rc == 0

    # Only the colliding orphan was removed.
    assert not colliding.exists()
    # The locked bundle survived — neither sibling went down with it.
    assert (plugins_dir / "example-foo" / "plugin.yaml").is_file()
    assert (plugins_dir / "example-bar" / "plugin.yaml").is_file()
    # Lock still mentions the surviving bundle.
    locked = {e.name for e in plugin_lock.read_lock(plugins_dir)}
    assert "example-foo" in locked
    assert "example-bar" in locked


def test_sync_no_prune_hints_at_extras(
    plugins_dir: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    """Without ``--prune``, sync should not pretend everything is in sync
    when there are bundled plugins on disk that the lock omits."""
    rc = admin.plugin_install(
        bundle="example-bundle",
        from_dir=str(FIXTURES / "example-bundle"),
    )
    assert rc == 0
    capsys.readouterr()

    # Drop one entry from the lock; the on-disk plugin is now drift.
    locked = plugin_lock.read_lock(plugins_dir)
    pruned_lock = [e for e in locked if e.name != "example-bar"]
    plugin_lock.write_lock(plugins_dir, pruned_lock)

    rc = admin.plugin_sync(dry_run=True, prune=False)
    assert rc == 0
    out = capsys.readouterr().out
    assert "no changes planned" in out
    assert "example-bar" in out
    assert "--prune" in out


def test_apply_sync_install_rejects_empty_target_after_scheme(
    capsys: pytest.CaptureFixture[str],
) -> None:
    """A lock row of ``local:`` or ``gh:`` has the scheme but no target.

    Without an explicit check, ``plugin_install(from_dir="")`` would
    resolve to the CWD (``local:``) or the install path would push an
    unparseable ``EIDAN_PLUGIN_SOURCE`` (``gh:``). Either is a silent
    foot-gun; sync must refuse with a non-zero exit and a clear error.
    """
    rc = admin._apply_sync_install("local:", bundle="anything")
    assert rc == 1
    err = capsys.readouterr().err
    assert "missing the target" in err
    assert "'local:<org-or-path>'" in err

    rc = admin._apply_sync_install("gh:", bundle="anything")
    assert rc == 1
    err = capsys.readouterr().err
    assert "missing the target" in err
    assert "'gh:<org-or-path>'" in err
