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


def test_read_lock_empty_file_raises(tmp_path: Path) -> None:
    """A truncated / hand-cleared lock must not look like first-install.

    YAML parses empty (or whitespace / comments-only) content to
    ``None``. Treating that as ``[]`` would let
    ``plugin sync --prune`` against a half-edited lock wipe out every
    bundle-installed plugin on disk. The first-install record is
    ``schema: 1\\nplugins: []``, not an empty file.
    """
    (tmp_path / ".lock").write_text("")
    with pytest.raises(plugin_lock.LockFileError):
        plugin_lock.read_lock(tmp_path)


def test_read_lock_whitespace_only_raises(tmp_path: Path) -> None:
    (tmp_path / ".lock").write_text("# just a comment\n   \n")
    with pytest.raises(plugin_lock.LockFileError):
        plugin_lock.read_lock(tmp_path)


def test_read_lock_null_plugins_key_raises(tmp_path: Path) -> None:
    """``plugins:`` set to YAML null (or omitted) must not look like ``[]``.

    A hand-edited lock with `plugins:` (no value) parses as null and,
    if we silently coalesce to ``[]``, ``plugin sync --prune`` would
    treat every bundle-installed plugin on disk as drift. The
    empty-install record is `plugins: []` — explicit only.
    """
    (tmp_path / ".lock").write_text("schema: 1\nplugins:\n")
    with pytest.raises(plugin_lock.LockFileError):
        plugin_lock.read_lock(tmp_path)


def test_read_lock_missing_plugins_key_raises(tmp_path: Path) -> None:
    (tmp_path / ".lock").write_text("schema: 1\n")
    with pytest.raises(plugin_lock.LockFileError):
        plugin_lock.read_lock(tmp_path)


def test_read_lock_non_utf8_raises(tmp_path: Path) -> None:
    """A non-UTF8 hand-edit must surface as ``LockFileError``.

    The lock is operator-editable. An editor that wrote CP1252 /
    latin-1 / etc. would otherwise raise ``UnicodeDecodeError`` from
    ``read_text(encoding="utf-8")``, crashing the CLI instead of
    routing through the "fix your lock" exit path.
    """
    (tmp_path / ".lock").write_bytes(b"schema: 1\nplugins:\n  - name: \xff\n")
    with pytest.raises(plugin_lock.LockFileError):
        plugin_lock.read_lock(tmp_path)


def test_read_lock_duplicate_names_raises(tmp_path: Path) -> None:
    """Two rows for the same plugin name are ambiguous; reject."""
    (tmp_path / ".lock").write_text(
        "schema: 1\n"
        "plugins:\n"
        "  - name: foo\n    version: 0.1.0\n    bundle: bx\n    source: gh:org\n"
        "  - name: foo\n    version: 0.2.0\n    bundle: bx\n    source: gh:org\n"
    )
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


def test_write_lock_cleans_up_tempfile_on_failure(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A failed ``write_lock`` must not leave ``.lock.tmp`` behind.

    ``write_text`` (partial write on disk-full) or ``replace``
    (cross-device, permission flip) can leave the sibling tempfile
    on disk after the failure. Without best-effort cleanup, the
    next operator ``ls`` shows a stray ``.lock.tmp`` next to the
    real lock and they wonder which one is authoritative. The
    cleanup is best-effort: the original ``OSError`` is what we
    want to surface, not a secondary unlink failure.
    """
    real_write_text = Path.write_text

    def _flaky_write_text(
        self: Path, *args: object, **kwargs: object
    ) -> object:
        if self.name == plugin_lock.LOCK_FILENAME + ".tmp":
            # Write part of the file then fail, modelling a disk-full
            # mid-write rather than a write that never started.
            real_write_text(self, "partial\n", encoding="utf-8")
            raise OSError("disk full")
        return real_write_text(self, *args, **kwargs)

    monkeypatch.setattr(Path, "write_text", _flaky_write_text)
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

    assert not (tmp_path / (plugin_lock.LOCK_FILENAME + ".tmp")).exists()
    assert not (tmp_path / plugin_lock.LOCK_FILENAME).exists()
