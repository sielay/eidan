# SPDX-License-Identifier: AGPL-3.0-or-later
"""First-boot volume seeding for ``EIDAN_PLUGINS_DIR``-mounted deploys.

The lifespan handler calls :func:`_seed_plugins_volume_if_needed` after
resolving the plugins dir. When the resolved path is a fresh, empty
volume (Fly volume, k8s emptyDir, …) the seeder copies the image-baked
``_DEFAULT_PLUGINS_DIR`` contents into it so the host has its core
plugins available before the first ``eidan admin plugin install`` call.

These tests run the seeder in isolation with a fake "image-baked"
default so the behaviour is deterministic regardless of which plugins
live in the real source tree at test time.
"""

from __future__ import annotations

from pathlib import Path

import pytest
from eidan_backend.http import app as app_module


@pytest.fixture
def fake_image_default(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> Path:
    """Stand in for ``_DEFAULT_PLUGINS_DIR`` with a controlled fixture.

    Manifests carry ``tier: core`` because the seeder filters out
    paid-tier plugins (see :func:`app_module._seed_plugins_volume_if_needed`
    — only tier:core is eligible for unattended seeding). The paid-tier
    case has its own dedicated test below.
    """
    src = tmp_path / "image-plugins"
    src.mkdir()
    (src / "core-plugin-a").mkdir()
    (src / "core-plugin-a" / "plugin.yaml").write_text(
        "schema: 1\nname: core-plugin-a\nversion: 0.1.0\ntier: core\n"
    )
    (src / "core-plugin-b").mkdir()
    (src / "core-plugin-b" / "plugin.yaml").write_text(
        "schema: 1\nname: core-plugin-b\nversion: 0.1.0\ntier: core\n"
    )
    monkeypatch.setattr(app_module, "_DEFAULT_PLUGINS_DIR", src)
    return src


def test_empty_volume_gets_seeded(
    fake_image_default: Path, tmp_path: Path
) -> None:
    volume = tmp_path / "volume"
    app_module._seed_plugins_volume_if_needed(volume)
    assert (volume / "core-plugin-a" / "plugin.yaml").is_file()
    assert (volume / "core-plugin-b" / "plugin.yaml").is_file()


def test_existing_paid_plugins_survive_alongside_seeded_core(
    fake_image_default: Path, tmp_path: Path
) -> None:
    """Operator-installed plugins are never overwritten, and image-baked
    plugins still seed into the gaps around them.

    Per-plugin idempotency means a volume that the operator has
    already populated with paid bundles still gets the image-baked
    tier:core plugins filled in. That covers the
    ``v0.N+1`` deploy that ships a new tier:core: it lands next to
    the existing paid plugins without a manual ``plugin install``.
    """
    volume = tmp_path / "volume"
    volume.mkdir()
    (volume / "paid-plugin").mkdir()
    (volume / "paid-plugin" / "plugin.yaml").write_text(
        "schema: 1\nname: paid-plugin\nversion: 0.1.0\n"
    )
    app_module._seed_plugins_volume_if_needed(volume)
    # Operator's paid plugin survived untouched.
    assert (volume / "paid-plugin" / "plugin.yaml").is_file()
    # And the image-baked core plugins landed alongside it.
    assert (volume / "core-plugin-a" / "plugin.yaml").is_file()
    assert (volume / "core-plugin-b" / "plugin.yaml").is_file()


def test_existing_core_plugin_is_not_overwritten(
    fake_image_default: Path, tmp_path: Path
) -> None:
    """A plugin directory of the same name as an image-baked one is left alone.

    The seeder checks ``target.exists()`` per plugin — if the operator
    hand-edited a core plugin or pinned an older copy, the boot does
    not clobber it.
    """
    volume = tmp_path / "volume"
    volume.mkdir()
    (volume / "core-plugin-a").mkdir()
    (volume / "core-plugin-a" / "plugin.yaml").write_text(
        "schema: 1\nname: core-plugin-a\nversion: 0.0.9-pinned\n"
    )
    app_module._seed_plugins_volume_if_needed(volume)
    # Existing copy untouched.
    assert (
        "0.0.9-pinned" in (volume / "core-plugin-a" / "plugin.yaml").read_text()
    )
    # Sibling that was missing still gets seeded.
    assert (volume / "core-plugin-b" / "plugin.yaml").is_file()


def test_partial_seed_recovers_missing_plugins(
    fake_image_default: Path, tmp_path: Path
) -> None:
    """A partial seed (one plugin landed, one failed) heals on next boot.

    Without per-plugin idempotency, the next boot would see a
    non-empty volume and skip seeding — leaving the volume
    permanently missing the late-half plugins. The fix iterates per
    plugin and copies any that are still absent.
    """
    volume = tmp_path / "volume"
    volume.mkdir()
    # Simulate a previous partial seed: core-plugin-a copied OK,
    # core-plugin-b never landed (disk full, OOM, etc.).
    (volume / "core-plugin-a").mkdir()
    (volume / "core-plugin-a" / "plugin.yaml").write_text(
        "schema: 1\nname: core-plugin-a\nversion: 0.1.0\n"
    )
    app_module._seed_plugins_volume_if_needed(volume)
    assert (volume / "core-plugin-a" / "plugin.yaml").is_file()
    assert (volume / "core-plugin-b" / "plugin.yaml").is_file()


def test_seed_is_idempotent(
    fake_image_default: Path, tmp_path: Path
) -> None:
    """A second seed call must not clobber a seeded plugin's contents."""
    volume = tmp_path / "volume"
    app_module._seed_plugins_volume_if_needed(volume)
    # Mutate one of the seeded plugins so we can detect re-seeding.
    sentinel = volume / "core-plugin-a" / "marker"
    sentinel.write_text("operator-edit")
    app_module._seed_plugins_volume_if_needed(volume)
    assert sentinel.read_text() == "operator-edit"


def test_no_volume_no_seed(
    fake_image_default: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """When resolved == _DEFAULT_PLUGINS_DIR the seeder is a no-op."""
    # Should not raise even though the path equals itself; the early
    # return is what we're checking.
    app_module._seed_plugins_volume_if_needed(fake_image_default)
    # No new directory was created alongside the fake default.
    assert sorted(p.name for p in fake_image_default.iterdir()) == [
        "core-plugin-a",
        "core-plugin-b",
    ]


def test_volume_with_only_lockfile_still_gets_seeded(
    fake_image_default: Path, tmp_path: Path
) -> None:
    """A pre-staged ``.lock`` (or other dotfile) must not block seeding.

    An operator can hand-seed ``plugins/.lock`` on a fresh volume to
    declare which paid bundles ``plugin sync`` should pull on first
    boot. The seeder's emptiness check looks for child *directories*
    so this dotfile-only volume is still treated as empty and the
    image-baked tier-core plugins land before the host boots.
    """
    volume = tmp_path / "volume"
    volume.mkdir()
    (volume / ".lock").write_text("schema: 1\nplugins: []\n")
    app_module._seed_plugins_volume_if_needed(volume)
    # Pre-existing lock survived; the image-baked plugins were copied
    # in alongside it.
    assert (volume / ".lock").is_file()
    assert (volume / "core-plugin-a" / "plugin.yaml").is_file()
    assert (volume / "core-plugin-b" / "plugin.yaml").is_file()


def test_missing_image_default_is_noop(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Running from a source tree (no baked plugins next to the resolved path)
    must not crash the lifespan."""
    nonexistent = tmp_path / "no-image-baked"
    monkeypatch.setattr(app_module, "_DEFAULT_PLUGINS_DIR", nonexistent)
    volume = tmp_path / "volume"
    app_module._seed_plugins_volume_if_needed(volume)
    # Volume directory is created (mkdir) but stays empty.
    assert volume.is_dir()
    assert list(volume.iterdir()) == []


def test_paid_tier_plugins_are_not_seeded(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Only ``tier: core`` plugins are eligible for unattended seeding.

    A paid-tier plugin baked into the image (via build-arg) would
    otherwise leak onto an operator volume without the explicit
    ``eidan admin plugin install`` handshake and without a row in
    ``plugins/.lock``. The seeder MUST skip it.
    """
    src = tmp_path / "image-plugins"
    src.mkdir()
    (src / "core-one").mkdir()
    (src / "core-one" / "plugin.yaml").write_text(
        "schema: 1\nname: core-one\nversion: 0.1.0\ntier: core\n"
    )
    (src / "paid-one").mkdir()
    (src / "paid-one" / "plugin.yaml").write_text(
        "schema: 1\nname: paid-one\nversion: 0.1.0\ntier: pro\n"
    )
    (src / "no-tier").mkdir()
    (src / "no-tier" / "plugin.yaml").write_text(
        "schema: 1\nname: no-tier\nversion: 0.1.0\n"
    )
    monkeypatch.setattr(app_module, "_DEFAULT_PLUGINS_DIR", src)

    volume = tmp_path / "volume"
    app_module._seed_plugins_volume_if_needed(volume)

    assert (volume / "core-one" / "plugin.yaml").is_file()
    assert not (volume / "paid-one").exists()
    # No `tier:` ⇒ skip (safer than guessing — a manifest the loader
    # would reject shouldn't auto-seed either).
    assert not (volume / "no-tier").exists()


def test_orphan_seed_tempdir_from_prior_crash_is_swept(
    fake_image_default: Path, tmp_path: Path
) -> None:
    """A leftover ``.seed-<name>.tmp`` from a prior partial copy is removed.

    Without the sweep, the per-plugin tempdir + rename loop would
    refuse to retry the failed seed (``tmp.exists()`` ⇒ skip) on the
    next boot and the volume would stay permanently missing the
    plugin.
    """
    volume = tmp_path / "volume"
    volume.mkdir()
    orphan = volume / ".seed-core-plugin-a.tmp"
    orphan.mkdir()
    (orphan / "leftover.txt").write_text("partial copy from prior crash")

    app_module._seed_plugins_volume_if_needed(volume)

    # Sweep + retry: the orphan tempdir is gone and the real plugin
    # landed.
    assert not orphan.exists()
    assert (volume / "core-plugin-a" / "plugin.yaml").is_file()
    assert (volume / "core-plugin-b" / "plugin.yaml").is_file()


def test_failed_copy_leaves_no_partial_target(
    fake_image_default: Path,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A ``copytree`` failure must not leave a half-populated target.

    Without the temp+rename, a partial ``target/`` would be present
    on the next boot and the seeder's ``target.exists()`` guard would
    skip it forever. We force ``copytree`` to fail for one plugin and
    verify (a) no ``target/`` was created and (b) the OTHER plugin
    still seeded — failure for one plugin must not poison the loop.
    """
    real_copytree = app_module.shutil.copytree
    calls: list[str] = []

    def flaky_copytree(src: Path, dst: Path, *args: object, **kwargs: object) -> str:
        calls.append(Path(src).name)
        if Path(src).name == "core-plugin-a":
            # Mid-copy failure: simulate the partial-tempdir that
            # copytree leaves behind on its way out.
            Path(dst).mkdir(parents=True, exist_ok=True)
            (Path(dst) / "half.txt").write_text("partial")
            raise OSError("simulated disk-full")
        return real_copytree(src, dst, *args, **kwargs)

    monkeypatch.setattr(app_module.shutil, "copytree", flaky_copytree)

    volume = tmp_path / "volume"
    app_module._seed_plugins_volume_if_needed(volume)

    # No partial target — the temp-dir cleanup ran on failure.
    assert not (volume / "core-plugin-a").exists()
    assert not (volume / ".seed-core-plugin-a.tmp").exists()
    # The other plugin's seed succeeded despite the sibling failure.
    assert (volume / "core-plugin-b" / "plugin.yaml").is_file()
    assert sorted(calls) == ["core-plugin-a", "core-plugin-b"]


def test_unreadable_image_default_does_not_crash_lifespan(
    fake_image_default: Path,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """``OSError`` listing the image-baked dir must not propagate.

    Permissions or corruption on the read side would otherwise crash
    the lifespan during boot rather than just log a warning and
    continue without seeding.
    """
    original_iterdir = Path.iterdir

    def boom(self: Path) -> object:
        if self == fake_image_default:
            raise OSError("permission denied")
        return original_iterdir(self)

    monkeypatch.setattr(Path, "iterdir", boom)
    volume = tmp_path / "volume"

    with caplog.at_level("WARNING", logger=app_module.logger.name):
        app_module._seed_plugins_volume_if_needed(volume)

    assert any(
        "could not list" in record.message for record in caplog.records
    )
    # Nothing was seeded — the seeder bailed out cleanly.
    assert not (volume / "core-plugin-a").exists()


def test_seed_blocks_while_external_lock_is_held(
    fake_image_default: Path, tmp_path: Path
) -> None:
    """Concurrent seed callers serialize on the volume's ``.seed.lock``.

    Models the multi-worker boot case raised on PR #19 (round 10):
    without a lock, one worker's sweep or per-plugin ``tmp.exists()``
    rmtree can wipe another worker's in-progress ``.seed-<name>.tmp/``
    mid-copy. With the lock, a second caller blocks until the first
    releases — by which point every plugin already exists on disk
    and the loop skips them.

    We hold the lock from the test thread, run the seeder in a
    background thread, confirm it blocks, then release and confirm
    the seeder proceeds. ``fcntl.flock`` is per-file-description on
    Linux/macOS, so two ``os.open`` calls on the same path produce
    independent FDs that contend correctly even within one process.
    """
    import fcntl
    import os
    import threading

    volume = tmp_path / "volume"
    volume.mkdir()
    lock_path = volume / ".seed.lock"

    held_fd = os.open(lock_path, os.O_WRONLY | os.O_CREAT, 0o644)
    fcntl.flock(held_fd, fcntl.LOCK_EX)

    completed = threading.Event()

    def seed() -> None:
        app_module._seed_plugins_volume_if_needed(volume)
        completed.set()

    worker = threading.Thread(target=seed)
    worker.start()
    try:
        # Seeder is blocked on flock — nothing should have landed.
        assert not completed.wait(timeout=0.5)
        assert not (volume / "core-plugin-a").exists()
        assert not (volume / "core-plugin-b").exists()
    finally:
        fcntl.flock(held_fd, fcntl.LOCK_UN)
        os.close(held_fd)

    assert completed.wait(timeout=5), "seeder did not finish after lock release"
    worker.join(timeout=1)
    assert not worker.is_alive()

    assert (volume / "core-plugin-a" / "plugin.yaml").is_file()
    assert (volume / "core-plugin-b" / "plugin.yaml").is_file()


def test_unreadable_volume_during_sweep_does_not_crash_lifespan(
    fake_image_default: Path,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """``OSError`` listing the volume in the sweep must not propagate."""
    volume = tmp_path / "volume"
    volume.mkdir()
    original_iterdir = Path.iterdir

    def boom(self: Path) -> object:
        if self == volume:
            raise OSError("permission denied")
        return original_iterdir(self)

    monkeypatch.setattr(Path, "iterdir", boom)

    with caplog.at_level("WARNING", logger=app_module.logger.name):
        app_module._sweep_orphan_seed_tempdirs(volume)

    assert any(
        "could not list" in record.message
        and "sweep" in record.message
        for record in caplog.records
    )
