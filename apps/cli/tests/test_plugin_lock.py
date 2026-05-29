# SPDX-License-Identifier: AGPL-3.0-or-later
"""Unit tests for ``eidan_cli.plugin_lock``.

The module is the pure read/write/diff layer that
``eidan admin plugin sync`` sits on top of. These tests cover the
file shape, the upsert / remove helpers, and the diff math that
produces a :class:`SyncPlan` — without invoking the admin command
itself (covered separately in ``test_plugin_sync.py``).
"""

from __future__ import annotations

from pathlib import Path

import pytest
import yaml
from eidan_cli import plugin_lock


def test_read_lock_missing_file_returns_empty(tmp_path: Path) -> None:
    assert plugin_lock.read_lock(tmp_path) == []


def test_round_trip_sorts_by_name(tmp_path: Path) -> None:
    entries = [
        plugin_lock.LockEntry(
            name="zeta", version="0.2.0", bundle="bz", source="gh:org"
        ),
        plugin_lock.LockEntry(
            name="alpha", version="0.1.0", bundle="ba", source="gh:org"
        ),
    ]
    plugin_lock.write_lock(tmp_path, entries)

    raw = yaml.safe_load((tmp_path / ".lock").read_text())
    assert raw["schema"] == plugin_lock.LOCK_SCHEMA_VERSION
    assert [p["name"] for p in raw["plugins"]] == ["alpha", "zeta"]

    parsed = plugin_lock.read_lock(tmp_path)
    assert [e.name for e in parsed] == ["alpha", "zeta"]


def test_write_lock_is_atomic(tmp_path: Path) -> None:
    """No ``.lock.tmp`` survives a successful write."""
    plugin_lock.write_lock(
        tmp_path,
        [
            plugin_lock.LockEntry(
                name="alpha", version="0.1.0", bundle="ba", source="gh:org"
            )
        ],
    )
    assert (tmp_path / ".lock").is_file()
    assert not (tmp_path / ".lock.tmp").exists()


def test_read_lock_malformed_yaml_raises(tmp_path: Path) -> None:
    (tmp_path / ".lock").write_text(": : :\n")
    with pytest.raises(plugin_lock.LockFileError):
        plugin_lock.read_lock(tmp_path)


def test_read_lock_wrong_schema_raises(tmp_path: Path) -> None:
    (tmp_path / ".lock").write_text("schema: 99\nplugins: []\n")
    with pytest.raises(plugin_lock.LockFileError):
        plugin_lock.read_lock(tmp_path)


def test_read_lock_missing_field_raises(tmp_path: Path) -> None:
    (tmp_path / ".lock").write_text(
        "schema: 1\nplugins:\n  - name: alpha\n    version: 0.1.0\n    bundle: ba\n"
    )
    with pytest.raises(plugin_lock.LockFileError):
        plugin_lock.read_lock(tmp_path)


def test_upsert_replaces_existing(tmp_path: Path) -> None:
    existing = [
        plugin_lock.LockEntry(
            name="alpha", version="0.1.0", bundle="ba", source="gh:org"
        ),
    ]
    new = [
        plugin_lock.LockEntry(
            name="alpha", version="0.2.0", bundle="ba", source="gh:org"
        ),
        plugin_lock.LockEntry(
            name="beta", version="0.1.0", bundle="bb", source="gh:org"
        ),
    ]
    out = plugin_lock.upsert(existing, new)
    by_name = {e.name: e for e in out}
    assert by_name["alpha"].version == "0.2.0"
    assert by_name["beta"].version == "0.1.0"
    assert len(out) == 2


def test_remove_drops_named_rows() -> None:
    entries = [
        plugin_lock.LockEntry(
            name="alpha", version="0.1.0", bundle="ba", source="gh:org"
        ),
        plugin_lock.LockEntry(
            name="beta", version="0.1.0", bundle="bb", source="gh:org"
        ),
    ]
    out = plugin_lock.remove(entries, ["alpha", "nonexistent"])
    assert [e.name for e in out] == ["beta"]


def test_plan_sync_installs_missing_and_groups_by_bundle() -> None:
    lock_entries = [
        plugin_lock.LockEntry(
            name="foo", version="0.1.0", bundle="bundle-x", source="gh:org"
        ),
        plugin_lock.LockEntry(
            name="bar", version="0.1.0", bundle="bundle-x", source="gh:org"
        ),
        plugin_lock.LockEntry(
            name="solo", version="0.1.0", bundle="bundle-y", source="gh:org"
        ),
    ]
    plan = plugin_lock.plan_sync(lock_entries, [], prune=False)
    bundles = {bundle: names for _source, bundle, names in plan.install_bundles}
    assert bundles == {"bundle-x": ["bar", "foo"], "bundle-y": ["solo"]}
    assert plan.prune == []


def test_plan_sync_flags_version_upgrade() -> None:
    lock_entries = [
        plugin_lock.LockEntry(
            name="foo", version="0.2.0", bundle="bundle-x", source="gh:org"
        ),
    ]
    installed = [
        plugin_lock.InstalledView(
            name="foo", version="0.1.0", bundle="bundle-x"
        ),
    ]
    plan = plugin_lock.plan_sync(lock_entries, installed, prune=False)
    assert plan.upgrades == [("foo", "0.1.0", "0.2.0")]
    assert plan.install_bundles == [("gh:org", "bundle-x", ["foo"])]


def test_plan_sync_in_sync_when_versions_match() -> None:
    lock_entries = [
        plugin_lock.LockEntry(
            name="foo", version="0.1.0", bundle="bundle-x", source="gh:org"
        ),
    ]
    installed = [
        plugin_lock.InstalledView(
            name="foo", version="0.1.0", bundle="bundle-x"
        ),
    ]
    plan = plugin_lock.plan_sync(lock_entries, installed, prune=False)
    assert plan.install_bundles == []
    assert plan.upgrades == []
    assert plan.in_sync == ["foo"]


def test_plan_sync_prune_only_targets_bundled_plugins() -> None:
    """Repo-shipped (no bundle stanza) plugins are never prune candidates."""
    installed = [
        plugin_lock.InstalledView(
            name="repo-core", version="0.1.0", bundle=None
        ),
        plugin_lock.InstalledView(
            name="orphan-paid", version="0.1.0", bundle="bundle-z"
        ),
    ]
    plan = plugin_lock.plan_sync([], installed, prune=True)
    assert plan.prune == ["orphan-paid"]


def test_plan_sync_prune_off_by_default() -> None:
    installed = [
        plugin_lock.InstalledView(
            name="orphan-paid", version="0.1.0", bundle="bundle-z"
        ),
    ]
    plan = plugin_lock.plan_sync([], installed, prune=False)
    assert plan.prune == []


def test_write_lock_wraps_oserror_as_lockfile_error(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A filesystem failure mid-write surfaces as ``LockFileError``.

    Callers (``plugin install`` / ``plugin remove``) catch
    ``LockFileError`` and treat lock-write failures as non-fatal; an
    unwrapped ``OSError`` would crash the CLI after the plugin files
    are already on disk.
    """

    def _boom(self: Path, *_args: object, **_kwargs: object) -> None:
        raise OSError("disk full")

    monkeypatch.setattr(Path, "write_text", _boom)
    with pytest.raises(plugin_lock.LockFileError):
        plugin_lock.write_lock(
            tmp_path,
            [
                plugin_lock.LockEntry(
                    name="alpha",
                    version="0.1.0",
                    bundle="ba",
                    source="gh:org",
                )
            ],
        )
