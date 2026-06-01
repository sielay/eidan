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
from pathlib import Path
from typing import TYPE_CHECKING

from .targets import TargetReconcileError

if TYPE_CHECKING:
    from eidan_cli.topology import ResolvedNode


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
    """
    context = runtime_dir / "build-context"
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
