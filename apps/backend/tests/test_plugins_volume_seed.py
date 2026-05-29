# SPDX-License-Identifier: AGPL-3.0-or-later
"""First-boot volume seeding for ``EIDAN_PLUGINS_DIR``-mounted deploys.

The lifespan handler calls :func:`_seed_plugins_volume_if_empty` after
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
    """Stand in for ``_DEFAULT_PLUGINS_DIR`` with a controlled fixture."""
    src = tmp_path / "image-plugins"
    src.mkdir()
    (src / "core-plugin-a").mkdir()
    (src / "core-plugin-a" / "plugin.yaml").write_text(
        "schema: 1\nname: core-plugin-a\nversion: 0.1.0\n"
    )
    (src / "core-plugin-b").mkdir()
    (src / "core-plugin-b" / "plugin.yaml").write_text(
        "schema: 1\nname: core-plugin-b\nversion: 0.1.0\n"
    )
    monkeypatch.setattr(app_module, "_DEFAULT_PLUGINS_DIR", src)
    return src


def test_empty_volume_gets_seeded(
    fake_image_default: Path, tmp_path: Path
) -> None:
    volume = tmp_path / "volume"
    app_module._seed_plugins_volume_if_empty(volume)
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
    app_module._seed_plugins_volume_if_empty(volume)
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
    app_module._seed_plugins_volume_if_empty(volume)
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
    app_module._seed_plugins_volume_if_empty(volume)
    assert (volume / "core-plugin-a" / "plugin.yaml").is_file()
    assert (volume / "core-plugin-b" / "plugin.yaml").is_file()


def test_seed_is_idempotent(
    fake_image_default: Path, tmp_path: Path
) -> None:
    """A second seed call must not clobber a seeded plugin's contents."""
    volume = tmp_path / "volume"
    app_module._seed_plugins_volume_if_empty(volume)
    # Mutate one of the seeded plugins so we can detect re-seeding.
    sentinel = volume / "core-plugin-a" / "marker"
    sentinel.write_text("operator-edit")
    app_module._seed_plugins_volume_if_empty(volume)
    assert sentinel.read_text() == "operator-edit"


def test_no_volume_no_seed(
    fake_image_default: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """When resolved == _DEFAULT_PLUGINS_DIR the seeder is a no-op."""
    # Should not raise even though the path equals itself; the early
    # return is what we're checking.
    app_module._seed_plugins_volume_if_empty(fake_image_default)
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
    app_module._seed_plugins_volume_if_empty(volume)
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
    app_module._seed_plugins_volume_if_empty(volume)
    # Volume directory is created (mkdir) but stays empty.
    assert volume.is_dir()
    assert list(volume.iterdir()) == []
