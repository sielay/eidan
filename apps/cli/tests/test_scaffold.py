# SPDX-License-Identifier: AGPL-3.0-or-later
"""Unit tests for ``eidan_cli.scaffold``.

Covers the materialise-template-into-fresh-directory path:

- Happy path: creates target dir + every template file
- Refuses to overwrite an existing dir without ``--force``
- ``--force`` overwrites cleanly (replaces, doesn't merge)
- Dotfile renames (``gitignore`` → ``.gitignore``, etc.) work
- The scaffolded ``topology.yml`` is parseable by ``load_topology``
"""

from __future__ import annotations

from pathlib import Path

import pytest
from eidan_cli.scaffold import (
    ScaffoldError,
    ScaffoldTargetExists,
    scaffold,
)
from eidan_cli.topology import load_topology

_EXPECTED_FILES = {
    "topology.yml",
    ".gitignore",
    ".vault-pass.example",
    "README.md",
}


def test_scaffold_creates_directory_and_template_files(tmp_path: Path) -> None:
    """Happy path — every template file lands at the right name, the
    target dir is created if absent."""
    target = scaffold("my-deploy", parent=tmp_path)

    assert target == tmp_path / "my-deploy"
    assert target.is_dir()
    on_disk = {p.name for p in target.iterdir()}
    assert _EXPECTED_FILES.issubset(on_disk), (
        f"missing template files: {_EXPECTED_FILES - on_disk}"
    )


def test_scaffold_refuses_to_overwrite(tmp_path: Path) -> None:
    """If the target path already exists and ``--force`` is not
    passed, fail with a typed error so the CLI can render a
    tailored message rather than wiping out operator edits."""
    target = tmp_path / "my-deploy"
    target.mkdir()
    (target / "important.txt").write_text("operator notes", encoding="utf-8")

    with pytest.raises(ScaffoldTargetExists):
        scaffold("my-deploy", parent=tmp_path)

    # Confirm the existing tree is untouched.
    assert (target / "important.txt").read_text(encoding="utf-8") == (
        "operator notes"
    )


def test_force_overwrites_existing_directory(tmp_path: Path) -> None:
    """``force=True`` drops the existing tree and re-scaffolds. We
    don't merge — operator's edits to the previous scaffold are
    easier to recover from git than from a half-applied overlay."""
    target = tmp_path / "my-deploy"
    target.mkdir()
    (target / "stale.txt").write_text("old", encoding="utf-8")

    fresh = scaffold("my-deploy", parent=tmp_path, force=True)

    assert fresh == target
    assert not (target / "stale.txt").exists()  # dropped by force
    assert (target / "topology.yml").is_file()  # re-scaffolded


def test_template_dotfiles_are_renamed(tmp_path: Path) -> None:
    """Dotfiles are stored without leading dots in the package (so
    they survive any build-tool quirks around hidden files) and
    renamed on copy."""
    target = scaffold("my-deploy", parent=tmp_path)

    # Renamed entries land with the leading dot.
    assert (target / ".gitignore").is_file()
    assert (target / ".vault-pass.example").is_file()
    # The pre-rename names do NOT leak through.
    assert not (target / "gitignore").exists()
    assert not (target / "vault-pass.example").exists()


def test_scaffolded_topology_yaml_is_parseable(tmp_path: Path) -> None:
    """The starter ``topology.yml`` parses cleanly via
    ``load_topology`` — operators can run ``eidan deploy`` straight
    after scaffolding (it will hit the placeholder node and fail
    later, but the parse step must succeed)."""
    target = scaffold("my-deploy", parent=tmp_path)
    topology = load_topology(target / "topology.yml")

    assert topology.schema_version == 1
    assert "placeholder" in topology.node_names()


def test_scaffold_error_subclass_caught_by_base(tmp_path: Path) -> None:
    """Callers can catch :class:`ScaffoldError` to handle every
    scaffold failure uniformly."""
    target = tmp_path / "my-deploy"
    target.mkdir()
    with pytest.raises(ScaffoldError):
        scaffold("my-deploy", parent=tmp_path)


# ---------- in-checkout (`--here`) mode ----------------------------------------


def test_scaffold_here_writes_into_dot_eidan(tmp_path: Path) -> None:
    """`scaffold(here=True)` drops the template into `.eidan/` of the
    parent (i.e. the cwd when invoked via CLI)."""
    target = scaffold(here=True, parent=tmp_path)

    assert target == tmp_path / ".eidan"
    assert target.is_dir()
    on_disk = {p.name for p in target.iterdir()}
    assert _EXPECTED_FILES.issubset(on_disk)


def test_scaffold_here_refuses_to_overwrite(tmp_path: Path) -> None:
    """An existing `.eidan/` (e.g. from a previous deploy) isn't blown
    away without `--force` — same protection as the sibling-dir mode."""
    (tmp_path / ".eidan").mkdir()
    (tmp_path / ".eidan" / "topology.yml").write_text(
        "existing", encoding="utf-8"
    )

    with pytest.raises(ScaffoldTargetExists):
        scaffold(here=True, parent=tmp_path)

    assert (tmp_path / ".eidan" / "topology.yml").read_text(encoding="utf-8") == (
        "existing"
    )


def test_scaffold_here_force_overwrites(tmp_path: Path) -> None:
    (tmp_path / ".eidan").mkdir()
    (tmp_path / ".eidan" / "stale.txt").write_text("old", encoding="utf-8")

    target = scaffold(here=True, parent=tmp_path, force=True)

    assert not (target / "stale.txt").exists()
    assert (target / "topology.yml").is_file()


def test_scaffold_rejects_name_and_here_together(tmp_path: Path) -> None:
    """Mutually exclusive — caller picks one."""
    with pytest.raises(ScaffoldError, match="not both"):
        scaffold("my-deploy", here=True, parent=tmp_path)


def test_scaffold_rejects_neither_name_nor_here(tmp_path: Path) -> None:
    with pytest.raises(ScaffoldError, match="pass `name`"):
        scaffold(parent=tmp_path)
