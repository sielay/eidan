# SPDX-License-Identifier: AGPL-3.0-or-later
"""`eidan init` scaffolder — materialises starter deploy config.

Two flavours, same template content:

- ``eidan init <name>`` → ``./<name>/`` (sibling-directory mode).
  Useful when the operator wants to keep deploy state in a
  separate private repo from the eidan source.
- ``eidan init --here`` → ``./.eidan/`` (in-checkout mode).
  The ``.eidan/`` path is already gitignored at the eidan repo
  root, so operator-private files (``topology.yml``,
  ``.vault-pass``) live next to the source they were cloned from
  without polluting the public history. This is the lighter
  workflow for solo operators who clone eidan and stay there.

The scaffolder is intentionally **non-interactive** — no Questionary
wizard, no prompts. The operator edits the YAML by hand. If
friction shows up here it's worth adding interactive prompts in a
follow-up; for now, the small surface keeps the implementation
trivial and the upgrade path clean.

Template files are bundled with the ``eidan_cli`` Python package
(``importlib.resources``) so this works regardless of whether the
CLI is installed via pipx, run from a checkout, or shipped on PyPI
in the future.
"""

from __future__ import annotations

import shutil
from importlib import resources
from pathlib import Path

# Template file → destination name in the scaffolded repo. Dotfiles
# are stored without a leading dot in the package so they're not
# treated as hidden by some build tools / package indexers; we
# re-dot them on copy here.
_TEMPLATE_RENAMES: dict[str, str] = {
    "gitignore": ".gitignore",
    "vault-pass.example": ".vault-pass.example",
}


class ScaffoldError(Exception):
    """Base class for scaffold failures (target exists, …)."""


class ScaffoldTargetExists(ScaffoldError):
    """Raised when the destination directory already exists and
    ``--force`` was not passed. Separate class so the CLI can show
    a tailored error instead of a generic Exception."""


def _template_root() -> Path:
    """Resolve the on-disk path of the bundled template directory.

    ``importlib.resources.files`` returns a :class:`Traversable`;
    for filesystem-backed packages (which eidan-cli is, both as a
    dev install and as a wheel) the result has ``.fspath``-like
    semantics so we can cast to :class:`Path` cleanly. If we ever
    package eidan-cli as a zip we'd swap this for
    ``as_file(...)`` context manager.
    """
    files = resources.files("eidan_cli.templates")
    return Path(str(files / "ops-scaffold"))


def scaffold(
    name: str | None = None,
    *,
    parent: Path | None = None,
    force: bool = False,
    here: bool = False,
) -> Path:
    """Materialise the starter template into a target directory.

    Two shapes:

    - sibling: ``scaffold("my-deployment")`` → ``<parent>/my-deployment/``
    - in-checkout: ``scaffold(here=True)`` → ``<parent>/.eidan/``

    Pass exactly one of ``name`` / ``here=True``. Returns the
    absolute path to the created directory.

    Raises:
        ScaffoldError: ``name`` and ``here`` are both unset or both set.
        ScaffoldTargetExists: target already exists and ``force=False``.
        ScaffoldError: a template file could not be copied.
    """
    if here and name is not None:
        raise ScaffoldError(
            "scaffold(): pass either `name` or `here=True`, not both"
        )
    if not here and name is None:
        raise ScaffoldError(
            "scaffold(): pass `name` (sibling dir) or `here=True` "
            "(in-checkout `.eidan/`)"
        )

    parent = parent or Path.cwd()
    target = parent / (".eidan" if here else name)

    if target.exists():
        if not force:
            raise ScaffoldTargetExists(
                f"refusing to scaffold over existing path {target} "
                "(pass --force to overwrite)"
            )
        # Force mode: drop the existing tree so the copy lands cleanly.
        # We don't try to merge — operator's edits to a previous scaffold
        # are easier to recover from git than from a half-merged tree.
        shutil.rmtree(target)

    target.mkdir(parents=True)
    template_root = _template_root()

    for src in sorted(template_root.iterdir()):
        if src.name == "__init__.py":
            # Present only so importlib.resources treats the dir as a
            # package; not part of the user-facing template.
            continue
        dest_name = _TEMPLATE_RENAMES.get(src.name, src.name)
        try:
            shutil.copyfile(src, target / dest_name)
        except OSError as exc:
            raise ScaffoldError(
                f"could not copy template file {src.name} to {target}: {exc}"
            ) from exc

    return target


__all__ = [
    "ScaffoldError",
    "ScaffoldTargetExists",
    "scaffold",
]
