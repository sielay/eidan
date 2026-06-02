# SPDX-License-Identifier: AGPL-3.0-or-later
"""Local build context assembly — shared between deploy targets.

The Fly target uses this to build a Docker image with bundle
plugins baked in (no remote install). The Pi target uses it to
rsync the assembled tree (eidan core + bundle plugins) onto the
Pi (no remote git clone, no remote PAT). Both targets get the
same trust boundary: the operator's laptop, where bundle repos
are already checked out.

Layout the assembler produces::

    <context>/
      pyproject.toml
      uv.lock
      apps/
      packages/
      migrations/
      infra/
      plugins/
        <core-plugin-1>/    ← from eidan checkout's plugins/
        <core-plugin-2>/
        ...
        <bundle-plugin>/    ← from <bundle_root>/<bundle>/<plugin>/
        ...

Bundle resolution: operator-local bundle repos under
``<eidan-parent>/<bundle>/`` by convention (the sibling-repo
layout the README already suggests). ``EIDAN_BUNDLE_ROOT`` env
overrides for non-conventional layouts (CI, separate drives).
"""

from __future__ import annotations

import os
import shutil
import subprocess
from dataclasses import dataclass, field
from pathlib import Path
from typing import TYPE_CHECKING

from .targets import TargetReconcileError

if TYPE_CHECKING:
    from eidan_cli.topology import ResolvedNode


# Branches we treat as "the canonical release line". Operators
# working on a feature branch get warned; on main we proceed
# silently. Lowercase compared; ``HEAD`` (detached state) never
# matches and surfaces as a warning.
_RELEASE_BRANCHES = frozenset({"main", "master"})


@dataclass(frozen=True, slots=True)
class BundleHealth:
    """Result of inspecting one bundle repo's git state.

    The reconciler reads ``problems`` to decide whether to warn /
    prompt / abort. ``branch`` and ``dirty_files`` are included
    for the message we render to the operator — they want to see
    WHICH file is dirty and WHICH branch is checked out, not just
    "something is off"."""

    name: str
    bundle_dir: Path
    is_git_repo: bool
    branch: str
    is_dirty: bool
    is_behind_origin: bool
    dirty_files: tuple[str, ...] = field(default_factory=tuple)

    @property
    def is_clean(self) -> bool:
        """True when nothing the operator would call wrong is wrong:
        on a release branch, working tree clean, in sync with
        origin. Non-git-repo bundles are NOT clean — we don't try
        to bake from a directory we can't audit."""
        return (
            self.is_git_repo
            and self.branch.lower() in _RELEASE_BRANCHES
            and not self.is_dirty
            and not self.is_behind_origin
        )

    @property
    def problems(self) -> list[str]:
        """Human-readable problem list. Empty when ``is_clean``."""
        out: list[str] = []
        if not self.is_git_repo:
            out.append("not a git repo (can't audit)")
            return out
        if self.branch.lower() not in _RELEASE_BRANCHES:
            out.append(f"on branch {self.branch!r} (expected main/master)")
        if self.is_dirty:
            preview = ", ".join(self.dirty_files[:3])
            if len(self.dirty_files) > 3:
                preview += f", … (+{len(self.dirty_files) - 3} more)"
            out.append(f"working tree has uncommitted changes: {preview}")
        if self.is_behind_origin:
            out.append("local is behind origin (run `git pull` first)")
        return out


def _run_git(args: list[str], cwd: Path) -> tuple[int, str]:
    """Thin wrapper around ``git`` so the audit functions stay
    readable. Returns (returncode, stdout). stderr is suppressed
    — the audit treats any non-zero exit as a signal, not as
    something to surface verbatim."""
    try:
        result = subprocess.run(  # noqa: S603
            ["git", *args],
            cwd=cwd,
            capture_output=True,
            text=True,
            check=False,
            timeout=15,
        )
    except (subprocess.TimeoutExpired, OSError):
        return -1, ""
    return result.returncode, result.stdout


def bundle_health(name: str, bundle_dir: Path) -> BundleHealth:
    """Inspect a single bundle's git state.

    ``git fetch`` runs (with ``--quiet``) so the ``is_behind_origin``
    check reflects the latest remote state rather than a stale
    fetch from days ago. The fetch is a no-op when offline (we
    just don't catch new commits — better than failing the audit).
    """
    if not (bundle_dir / ".git").exists():
        return BundleHealth(
            name=name,
            bundle_dir=bundle_dir,
            is_git_repo=False,
            branch="",
            is_dirty=False,
            is_behind_origin=False,
        )

    # Current branch (or "HEAD" for detached state). Treat detached
    # the same as "not on main".
    rc, stdout = _run_git(["rev-parse", "--abbrev-ref", "HEAD"], bundle_dir)
    branch = stdout.strip() if rc == 0 else ""

    # Dirty tree → list of changed files, capped for display.
    rc, stdout = _run_git(["status", "--porcelain"], bundle_dir)
    # NB: don't .strip() the whole stdout before splitting — `git
    # status --porcelain` lines start with the index/worktree status
    # chars, e.g. " M plugin.yaml" (leading space when there's no
    # staged change). .strip() on the whole multiline string eats
    # that leading space and shifts the slice by one. Use raw
    # splitlines + drop trailing empties.
    dirty_lines = [
        line for line in stdout.splitlines() if line.strip()
    ] if rc == 0 else []
    is_dirty = bool(dirty_lines)
    dirty_files = tuple(
        # `status --porcelain` lines are "XY <path>" (XY is two
        # single-char status fields, then a space, then the path).
        # `line[3:]` peels off the prefix; .strip() only normalises
        # the path itself.
        line[3:].strip() for line in dirty_lines
    )

    # Refresh remote refs so the behind-check is meaningful. We
    # don't gate on rc — offline machines can't fetch and that's
    # fine; the behind-check then compares against whatever was
    # last fetched.
    _run_git(["fetch", "--quiet"], bundle_dir)

    # `rev-list --count HEAD..origin/<branch>` counts commits the
    # remote has that we don't. Non-zero means behind.
    is_behind = False
    if branch and branch.lower() in _RELEASE_BRANCHES:
        rc, stdout = _run_git(
            ["rev-list", "--count", f"HEAD..origin/{branch}"], bundle_dir
        )
        if rc == 0:
            try:
                is_behind = int(stdout.strip() or "0") > 0
            except ValueError:
                is_behind = False

    return BundleHealth(
        name=name,
        bundle_dir=bundle_dir,
        is_git_repo=True,
        branch=branch,
        is_dirty=is_dirty,
        is_behind_origin=is_behind,
        dirty_files=dirty_files,
    )


def audit_bundles(
    node: ResolvedNode, *, eidan_dir: Path
) -> list[BundleHealth]:
    """Run :func:`bundle_health` against every bundle the node
    declares. Returns the results in declaration order so the
    operator-facing message lines up with what they put in
    ``topology.yml``.

    Bundles missing from disk are silently skipped here — the
    actual bake step (:func:`assemble_build_context`) raises a
    typed error when it can't find them, with a clearer message.
    The audit's job is to gate ON-DISK-but-not-fresh, not to
    re-implement the missing-bundle check.
    """
    bundles = getattr(node, "bundles", None) or []
    bundle_names = [
        b.root if hasattr(b, "root") else str(b) for b in bundles
    ]
    if not bundle_names:
        return []
    bundle_root = resolve_bundle_root(eidan_dir)
    results: list[BundleHealth] = []
    for name in bundle_names:
        bundle_dir = bundle_root / name
        if not bundle_dir.is_dir():
            continue
        results.append(bundle_health(name, bundle_dir))
    return results


BUILD_CONTEXT_IGNORE = shutil.ignore_patterns(
    "__pycache__",
    ".pytest_cache",
    ".mypy_cache",
    ".ruff_cache",
    "node_modules",
    ".next",
    ".venv",
    ".git",
    "dist",
    "build",
    "*.egg-info",
    ".eidan",
    ".eidan-runtime",
    ".DS_Store",
)


def resolve_bundle_root(eidan_dir: Path) -> Path:
    """Where to look for operator-local bundle repos.

    ``EIDAN_BUNDLE_ROOT`` wins if set; otherwise we use the eidan
    checkout's parent directory — the conventional sibling-repo
    layout (``~/Documents/GitHub/eidan`` + ``~/Documents/GitHub/eidan-pro``
    etc.). Convention covers the single-operator default; the env
    var is for operators who keep bundles elsewhere (CI, separate
    drive) without committing the path into the public-mirror
    topology schema.
    """
    env_value = os.environ.get("EIDAN_BUNDLE_ROOT", "").strip()
    if env_value:
        return Path(env_value).expanduser().resolve()
    return eidan_dir.parent.resolve()


def discover_bundle_plugins(bundle_dir: Path) -> list[Path]:
    """Find every subdir of ``bundle_dir`` containing ``plugin.yaml``.

    Mirrors the discovery logic in
    :func:`eidan_cli.admin._install_plugins_from_bundle` so a local
    bake produces the same plugin set as a remote install used to.
    """
    return [
        child
        for child in sorted(bundle_dir.iterdir())
        if child.is_dir() and (child / "plugin.yaml").is_file()
    ]


def assemble_build_context(
    node: ResolvedNode,
    *,
    eidan_dir: Path,
    runtime_dir: Path,
) -> Path:
    """Materialise a temp build context at ``<runtime_dir>/build-context/``.

    The context is wiped + recreated on every call. Excludes
    `.git/`, `.venv/`, `node_modules/`, `__pycache__/`, etc. so
    downstream consumers (Docker BuildKit upload, rsync over SSH)
    stay bounded even when the operator's `apps/web/` tree has a
    populated Next.js cache.

    Raises :class:`TargetReconcileError` on:
    - missing bundle dir under ``EIDAN_BUNDLE_ROOT`` / eidan parent
    - bundle dir with no ``plugin.yaml`` subdirs
    - plugin-name collision between a core plugin and a bundle one

    The returned context Path is always **absolute** — relative
    paths cause flyctl to incorrectly concatenate ``--dockerfile``
    against the context dir, producing a doubly-nested ``<ctx>/<ctx>``
    that fails the build. Resolving once here keeps every downstream
    consumer (subprocess args, error messages) unambiguous.
    """
    context = (runtime_dir / "build-context").resolve()
    if context.exists():
        shutil.rmtree(context)
    context.mkdir(parents=True)

    for filename in ("pyproject.toml", "uv.lock"):
        src = eidan_dir / filename
        if not src.is_file():
            raise TargetReconcileError(
                f"build context: {filename} not found at {src}. "
                "Run `eidan deploy` from the eidan checkout root, or "
                "set EIDAN_SOURCE_DIR."
            )
        shutil.copy2(src, context / filename)

    for subdir in ("apps", "packages", "migrations", "infra", "plugins"):
        src = eidan_dir / subdir
        if not src.is_dir():
            raise TargetReconcileError(
                f"build context: {subdir}/ not found at {src}."
            )
        shutil.copytree(src, context / subdir, ignore=BUILD_CONTEXT_IGNORE)

    bundles = getattr(node, "bundles", None) or []
    bundle_names = [
        b.root if hasattr(b, "root") else str(b) for b in bundles
    ]
    if not bundle_names:
        return context

    bundle_root = resolve_bundle_root(eidan_dir)
    plugins_target = context / "plugins"

    for bundle_name in bundle_names:
        bundle_dir = bundle_root / bundle_name
        if not bundle_dir.is_dir():
            raise TargetReconcileError(
                f"bundle {bundle_name!r}: directory not found at {bundle_dir}. "
                "Clone the bundle repo there, or set EIDAN_BUNDLE_ROOT to "
                "its parent dir."
            )
        plugin_dirs = discover_bundle_plugins(bundle_dir)
        if not plugin_dirs:
            raise TargetReconcileError(
                f"bundle {bundle_name!r}: no plugin.yaml found under any "
                f"subdir of {bundle_dir}."
            )
        for plugin_src in plugin_dirs:
            plugin_dst = plugins_target / plugin_src.name
            if plugin_dst.exists():
                raise TargetReconcileError(
                    f"plugin name collision: bundle {bundle_name!r} brings "
                    f"plugin {plugin_src.name!r}, but a plugin by that name "
                    "already exists in the build context (likely a core "
                    "plugin). Rename one or the other."
                )
            shutil.copytree(
                plugin_src, plugin_dst, ignore=BUILD_CONTEXT_IGNORE
            )

    return context


__all__ = [
    "BUILD_CONTEXT_IGNORE",
    "assemble_build_context",
    "discover_bundle_plugins",
    "resolve_bundle_root",
]
