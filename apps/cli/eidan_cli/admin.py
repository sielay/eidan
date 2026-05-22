"""Admin commands — `eidan admin db ...`, `eidan admin plugin ...`.

Env-var driven. These never read the user's stored JWT. The operator
running them is whoever can set `DATABASE_URL` on the process — i.e.
whoever can run the host.

Phase 1 implemented `db migrate` / `db reset`. Phase 4 implements
`plugin install`, `plugin list`, and `plugin remove`
(per `docs/018 §3`).
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from uuid import UUID

import yaml

_REPO_ROOT = Path(__file__).resolve().parents[3]
ALEMBIC_INI = _REPO_ROOT / "migrations" / "alembic.ini"
PLUGINS_DIR = _REPO_ROOT / "plugins"


def _need_database_url() -> str:
    url = os.environ.get("DATABASE_URL")
    if not url:
        print(
            "DATABASE_URL is not set. Admin commands read it from the "
            "environment.",
            file=sys.stderr,
        )
        raise SystemExit(2)
    return url


def db_migrate() -> int:
    """Apply all pending migrations to head — core first, then plugins.

    Per `docs/002 §4` the runner is strictly ordered: core's ``eidan``
    schema migrations under ``migrations/`` first, then each installed
    plugin's private-schema migrations in topological order over
    ``depends_on`` (the order the plugin loader returns). The first
    plugin failure aborts the run.
    """
    database_url = _need_database_url()
    rc = subprocess.call(
        ["alembic", "-c", str(ALEMBIC_INI), "upgrade", "head"],
        cwd=str(_REPO_ROOT),
    )
    if rc != 0:
        return rc

    # Local import: keep the CLI's import-time cost low and avoid
    # pulling in the backend's alembic / asyncpg surface for commands
    # that don't touch the database.
    from eidan_backend.plugins import run_plugin_migrations_sync

    try:
        run_plugin_migrations_sync(PLUGINS_DIR, database_url)
    except Exception as exc:  # noqa: BLE001 — surface any plugin-runner failure as exit code
        print(f"plugin migrations failed: {exc}", file=sys.stderr)
        return 1
    return 0


def db_reset() -> int:
    """Drop the eidan schema and re-run migrations from empty.

    Refuses to run if EIDAN_DEPLOYMENT_MODE=production per `002 §6.1`.
    """
    if os.environ.get("EIDAN_DEPLOYMENT_MODE") == "production":
        print(
            "Refusing `db reset` in production "
            "(EIDAN_DEPLOYMENT_MODE=production).",
            file=sys.stderr,
        )
        return 1

    import asyncio

    import asyncpg

    async def _reset() -> None:
        url = _need_database_url().replace("postgresql+asyncpg://", "postgresql://", 1)
        conn = await asyncpg.connect(url)
        try:
            await conn.execute("DROP SCHEMA IF EXISTS eidan CASCADE")
        finally:
            await conn.close()

    asyncio.run(_reset())
    return db_migrate()


# ---------------------------------------------------------------------------
# release sanitise (`docs/016 §3.6`)
# ---------------------------------------------------------------------------


def release_sanitise(*, dry_run: bool = True) -> int:
    """Run the forbidden-string gate from `docs/016 §3.6` locally.

    Defers to ``.github/scripts/sanitise_check.py`` so CI and the CLI
    exercise the same code path. The script's ``--dry-run`` flag maps
    onto the CLI's ``--dry-run`` toggle: dry-run prints hits but
    always exits 0, ``--enforce`` returns the script's exit code (1
    on any hit) so the runbook can abort.
    """
    script = _REPO_ROOT / ".github" / "scripts" / "sanitise_check.py"
    if not script.is_file():
        print(
            f"sanitise gate script not found at {script} — has the repo "
            "been initialised with the release tooling?",
            file=sys.stderr,
        )
        return 2
    cmd = [sys.executable, str(script), "--root", str(_REPO_ROOT)]
    if dry_run:
        cmd.append("--dry-run")
    rc = subprocess.call(cmd, cwd=str(_REPO_ROOT))
    return rc


# ---------------------------------------------------------------------------
# plugin install (Phase 4 — docs/018 §3)
# ---------------------------------------------------------------------------


class PluginInstallError(Exception):
    """Raised on a recoverable install failure that should map to a non-zero exit."""


def _load_manifest_name(plugin_dir: Path) -> str | None:
    """Return the ``name`` field of ``plugin_dir/plugin.yaml`` if it parses, else None.

    The CLI deliberately does not import the backend's full Pydantic
    validator here — a partial manifest (e.g. mid-edit) on the source
    side should not crash discovery. The host's loader is the
    authoritative validator at activation time (`docs/001 §1`).
    """
    manifest_path = plugin_dir / "plugin.yaml"
    if not manifest_path.is_file():
        return None
    try:
        raw = yaml.safe_load(manifest_path.read_text(encoding="utf-8"))
    except (OSError, yaml.YAMLError):
        return None
    if not isinstance(raw, dict):
        return None
    name = raw.get("name")
    return name if isinstance(name, str) and name else None


def _discover_plugins(bundle_root: Path) -> list[tuple[str, Path]]:
    """Return ``(plugin_name, source_dir)`` for each plugin directory under ``bundle_root``.

    A plugin directory is any immediate child whose ``plugin.yaml``
    declares a ``name``. Hidden directories are skipped.
    """
    found: list[tuple[str, Path]] = []
    if not bundle_root.is_dir():
        return found
    for child in sorted(bundle_root.iterdir()):
        if not child.is_dir() or child.name.startswith("."):
            continue
        name = _load_manifest_name(child)
        if name is not None:
            found.append((name, child))
    return found


def _resolve_local_bundle_root(local_path: Path, bundle: str | None) -> Path:
    """Pick the directory that directly contains plugin subdirectories.

    Two layouts are accepted:

    - ``local_path`` is itself a bundle root (its immediate children
      are plugin directories). Returned as-is.
    - ``local_path`` is a parent of bundle roots. If ``bundle`` is
      given and ``local_path/<bundle>/`` exists, return that. Else
      fall back to ``local_path``.
    """
    if bundle:
        candidate = local_path / bundle
        if candidate.is_dir():
            return candidate
    return local_path


def _copy_or_link_plugin(src: Path, dst: Path, link: bool) -> None:
    """Materialise the plugin at ``dst``. Caller has already removed any prior tree."""
    if link:
        os.symlink(src.resolve(), dst, target_is_directory=True)
    else:
        shutil.copytree(src, dst)


def _install_plugins_from_bundle(
    bundle_root: Path,
    *,
    force: bool,
    link: bool,
    plugins_dir: Path,
) -> list[str]:
    """Install every plugin discovered under ``bundle_root``.

    Conflicts (existing ``plugins/<name>/``) are checked across the
    whole bundle before any plugin is materialised, so a refusal in
    the middle of a multi-plugin bundle does not leave a
    half-installed tree behind.
    """
    discovered = _discover_plugins(bundle_root)
    if not discovered:
        raise PluginInstallError(
            f"no plugin.yaml found under {bundle_root}"
        )

    if not force:
        conflicts = [
            name for name, _ in discovered if (plugins_dir / name).exists()
        ]
        if conflicts:
            raise PluginInstallError(
                f"plugins/{conflicts[0]}/ already exists; "
                "pass --force to overwrite."
            )

    plugins_dir.mkdir(parents=True, exist_ok=True)
    installed: list[str] = []
    for name, src in discovered:
        dst = plugins_dir / name
        if dst.exists() or dst.is_symlink():
            if dst.is_symlink() or dst.is_file():
                dst.unlink()
            else:
                shutil.rmtree(dst)
        _copy_or_link_plugin(src, dst, link)
        installed.append(name)
    return installed


def _load_bundle_dependencies(bundle_root: Path) -> list[str]:
    """Optional sibling-bundle dependencies declared by ``bundle.yaml``.

    The bundle-level manifest is not yet pinned in a spec; we accept a
    minimal shape so the paid-baseline auto-install promised by
    `docs/018 §3` works once a bundle declares it. Missing file →
    empty list. Malformed file → empty list (the host's loader is the
    authoritative validator).
    """
    bundle_yaml = bundle_root / "bundle.yaml"
    if not bundle_yaml.is_file():
        return []
    try:
        raw = yaml.safe_load(bundle_yaml.read_text(encoding="utf-8"))
    except (OSError, yaml.YAMLError):
        return []
    if not isinstance(raw, dict):
        return []
    deps = raw.get("depends_on") or []
    if not isinstance(deps, list):
        return []
    return [d for d in deps if isinstance(d, str) and d]


def _parse_plugin_source(value: str) -> tuple[str, str]:
    """Split ``EIDAN_PLUGIN_SOURCE`` into ``(scheme, target)``.

    Accepts ``local:<path>`` and ``gh:<org>``. Unknown schemes raise.
    """
    if ":" not in value:
        raise PluginInstallError(
            f"EIDAN_PLUGIN_SOURCE={value!r} is not in the form "
            "'local:<path>' or 'gh:<org>'."
        )
    scheme, _, target = value.partition(":")
    if scheme not in {"local", "gh"}:
        raise PluginInstallError(
            f"EIDAN_PLUGIN_SOURCE scheme {scheme!r} is not supported "
            "(use 'local:<path>' or 'gh:<org>')."
        )
    if not target:
        raise PluginInstallError(
            f"EIDAN_PLUGIN_SOURCE={value!r} is missing a target after the scheme."
        )
    return scheme, target


def _clone_github_bundle(org: str, bundle: str, dest: Path) -> None:
    """Clone ``<org>/<bundle>`` into ``dest`` using ``EIDAN_GITHUB_TOKEN``.

    Uses the ``x-access-token`` URL form so the PAT never lands on
    disk in a git config file. A failure (non-zero exit) is surfaced
    as a :class:`PluginInstallError` with a single actionable message.
    """
    token = os.environ.get("EIDAN_GITHUB_TOKEN", "").strip()
    if not token:
        raise PluginInstallError(
            "EIDAN_GITHUB_TOKEN is not set; cannot clone "
            f"{org}/{bundle} from GitHub."
        )
    url = f"https://x-access-token:{token}@github.com/{org}/{bundle}.git"
    proc = subprocess.run(
        ["git", "clone", "--depth", "1", url, str(dest)],
        capture_output=True,
        text=True,
    )
    if proc.returncode != 0:
        stderr = proc.stderr or ""
        masked = stderr.replace(token, "***")
        lowered = masked.lower()
        if (
            "authentication failed" in lowered
            or "could not read username" in lowered
            or "invalid username or password" in lowered
            or ("fatal: repository" in lowered and "not found" in lowered)
        ):
            raise PluginInstallError(
                "auth failed; check EIDAN_GITHUB_TOKEN "
                f"(or membership of {org}/{bundle})."
            )
        raise PluginInstallError(
            f"git clone {org}/{bundle} failed:\n{masked.strip()}"
        )


@dataclass(frozen=True)
class _Source:
    """Where to fetch a bundle from.

    ``kind`` is ``"local"`` or ``"gh"``; ``root`` is the directory that
    contains bundle subdirectories (local) or the GitHub org (gh).
    """

    kind: str
    root: str


def _resolve_initial_source(bundle: str | None, from_dir: str | None) -> tuple[_Source, Path]:
    """Pick the source for the top-level install and the bundle root within it.

    Returns ``(source, bundle_root)``. ``source`` carries the parent
    dir / org so dependency recursion can reuse the same context. The
    returned ``bundle_root`` is the directory that directly contains
    plugin subdirectories; for the gh case it is realised inside a
    temp dir that the caller is responsible for cleaning up.
    """
    if from_dir is not None:
        local_root = Path(from_dir).expanduser()
        if not local_root.is_dir():
            raise PluginInstallError(f"--from-dir {from_dir!r} does not exist.")
        bundle_root = _resolve_local_bundle_root(local_root, bundle)
        # The sibling-bundle parent is whatever directory holds the
        # bundle we just resolved — either local_root itself (when
        # bundle was found as a child) or local_root's parent (when
        # local_root *was* the bundle root).
        sibling_root = local_root if bundle_root != local_root else local_root.parent
        return _Source("local", str(sibling_root)), bundle_root

    source_env = os.environ.get("EIDAN_PLUGIN_SOURCE", "").strip()
    if not source_env:
        raise PluginInstallError(
            "no install source: pass --from-dir or set EIDAN_PLUGIN_SOURCE "
            "(e.g. 'local:./bundles' or 'gh:<org>')."
        )
    scheme, target = _parse_plugin_source(source_env)
    if scheme == "local":
        local_root = Path(target).expanduser()
        if not local_root.is_dir():
            raise PluginInstallError(
                f"EIDAN_PLUGIN_SOURCE=local:{target} does not exist."
            )
        bundle_root = _resolve_local_bundle_root(local_root, bundle)
        return _Source("local", str(local_root)), bundle_root

    # gh
    if not bundle:
        raise PluginInstallError(
            "bundle name is required when installing from GitHub."
        )
    tmp = Path(tempfile.mkdtemp(prefix="eidan-bundle-"))
    try:
        _clone_github_bundle(target, bundle, tmp / bundle)
    except Exception:
        shutil.rmtree(tmp, ignore_errors=True)
        raise
    return _Source("gh", target), tmp / bundle


def _materialise_dep(source: _Source, bundle: str) -> tuple[Path, Path | None]:
    """Resolve a dependency bundle from the *same* source as its parent.

    Returns ``(bundle_root, cleanup_tmp_dir_or_None)``.
    """
    if source.kind == "local":
        local_root = Path(source.root)
        bundle_root = local_root / bundle
        if not bundle_root.is_dir():
            raise PluginInstallError(
                f"bundle dependency {bundle!r} not found under {local_root}."
            )
        return bundle_root, None
    # gh
    tmp = Path(tempfile.mkdtemp(prefix="eidan-bundle-"))
    try:
        _clone_github_bundle(source.root, bundle, tmp / bundle)
    except Exception:
        shutil.rmtree(tmp, ignore_errors=True)
        raise
    return tmp / bundle, tmp


def _install_bundle_tree(
    source: _Source,
    bundle_name: str,
    bundle_root: Path,
    *,
    force: bool,
    plugins_dir: Path,
    link: bool,
    visited: set[str],
) -> list[str]:
    """Install ``bundle_root`` and depth-first recurse on its ``depends_on``."""
    installed = _install_plugins_from_bundle(
        bundle_root, force=force, link=link, plugins_dir=plugins_dir
    )
    visited.add(bundle_name)
    for dep in _load_bundle_dependencies(bundle_root):
        if dep in visited:
            continue
        dep_root, dep_cleanup = _materialise_dep(source, dep)
        try:
            installed.extend(
                _install_bundle_tree(
                    source,
                    dep,
                    dep_root,
                    force=force,
                    plugins_dir=plugins_dir,
                    link=link,
                    visited=visited,
                )
            )
        finally:
            if dep_cleanup is not None:
                shutil.rmtree(dep_cleanup, ignore_errors=True)
    return installed


def _do_install(
    bundle: str | None,
    from_dir: str | None,
    *,
    force: bool,
    plugins_dir: Path,
    link: bool,
    visited: set[str],
) -> list[str]:
    """Install a single bundle and recurse into its declared bundle deps."""
    source, bundle_root = _resolve_initial_source(bundle, from_dir)
    # For the gh path the bundle_root sits inside a tempdir the caller
    # made; clean that tempdir up after we're done copying out of it.
    top_cleanup: Path | None = (
        bundle_root.parent if (source.kind == "gh" and from_dir is None) else None
    )
    try:
        return _install_bundle_tree(
            source,
            bundle or bundle_root.name,
            bundle_root,
            force=force,
            plugins_dir=plugins_dir,
            link=link,
            visited=visited,
        )
    finally:
        if top_cleanup is not None:
            shutil.rmtree(top_cleanup, ignore_errors=True)


def plugin_install(
    bundle: str | None,
    from_dir: str | None,
    *,
    force: bool = False,
) -> int:
    """Install a bundle's plugins into ``plugins/<name>/``.

    Two source paths (`docs/018 §3`):

    - ``--from-dir <path>``: copy / symlink plugins from a local
      checkout. ``EIDAN_PLUGIN_LINK=1`` switches the copy to a
      symlink for live editing.
    - default: clone ``<org>/<bundle>`` from GitHub using
      ``EIDAN_GITHUB_TOKEN``. The org comes from
      ``EIDAN_PLUGIN_SOURCE=gh:<org>``.

    Refuses to overwrite an existing ``plugins/<name>/`` unless
    ``--force`` is passed. If the bundle declares sibling-bundle
    dependencies in a top-level ``bundle.yaml``, those are installed
    by the same mechanism (per `docs/018 §3` — the paid baseline is
    installed as a dependency of any thematic bundle).
    """
    link = os.environ.get("EIDAN_PLUGIN_LINK") == "1"
    try:
        installed = _do_install(
            bundle,
            from_dir,
            force=force,
            plugins_dir=PLUGINS_DIR,
            link=link,
            visited=set(),
        )
    except PluginInstallError as exc:
        print(str(exc), file=sys.stderr)
        return 1

    verb = "linked" if link else "installed"
    for name in installed:
        print(f"{verb} plugins/{name}/")
    if not installed:
        print("nothing to install.", file=sys.stderr)
        return 1

    # Auto-migrate so the plugin's tables exist before the host's
    # lifespan-time activation tries to use them (`docs/018 §3`,
    # `docs/002 §4`). The operator can disable by unsetting
    # DATABASE_URL OR by setting EIDAN_PLUGIN_INSTALL_NO_MIGRATE=1.
    # Migration failure is non-fatal: the files are on disk, the
    # operator can re-run `eidan admin db migrate` after fixing
    # whatever's wrong with their DB connection.
    if os.environ.get("EIDAN_PLUGIN_INSTALL_NO_MIGRATE") == "1":
        return 0
    if not os.environ.get("DATABASE_URL"):
        print(
            "note: DATABASE_URL unset; run `eidan admin db migrate` "
            "after configuring the database.",
            file=sys.stderr,
        )
        return 0
    try:
        from eidan_backend.plugins import run_plugin_migrations_sync

        run_plugin_migrations_sync(PLUGINS_DIR, os.environ["DATABASE_URL"])
    except Exception as exc:  # noqa: BLE001 — files are landed; migrate is rerun-able
        print(
            f"warning: plugin migrations failed ({exc}); "
            "re-run `eidan admin db migrate` after resolving.",
            file=sys.stderr,
        )
    return 0


# ---------------------------------------------------------------------------
# plugin list / remove (Phase 4 — docs/018 §3)
# ---------------------------------------------------------------------------


class PluginRemoveError(Exception):
    """Raised on a recoverable remove failure that should map to a non-zero exit."""


def _load_manifest_raw(plugin_dir: Path) -> dict[str, Any] | None:
    """Return ``plugin_dir/plugin.yaml`` parsed as a dict, or ``None``.

    Mirrors :func:`_load_manifest_name` — list / remove want every
    declared field, not just ``name``, but should still tolerate a
    partially-edited manifest without crashing the whole listing.
    The host loader (`docs/001 §1`) is the authoritative validator.
    """
    manifest_path = plugin_dir / "plugin.yaml"
    if not manifest_path.is_file():
        return None
    try:
        raw = yaml.safe_load(manifest_path.read_text(encoding="utf-8"))
    except (OSError, yaml.YAMLError):
        return None
    if not isinstance(raw, dict):
        return None
    return raw


@dataclass(frozen=True)
class _PluginEntry:
    """A row in the on-disk view of installed plugins.

    The CLI's list / remove path parses every ``plugins/<name>/plugin.yaml``
    into one of these. ``bundle_name`` / ``bundle_kind`` are ``None``
    for plugins shipped in this repo (no ``bundle:`` stanza).
    """

    name: str
    version: str
    tier: str
    plugin_dir: Path
    bundle_name: str | None
    bundle_kind: str | None


def _entry_from_manifest(plugin_dir: Path) -> _PluginEntry | None:
    raw = _load_manifest_raw(plugin_dir)
    if raw is None:
        return None
    name = raw.get("name")
    version = raw.get("version")
    tier = raw.get("tier")
    if not (isinstance(name, str) and name):
        return None
    bundle = raw.get("bundle")
    bundle_name: str | None = None
    bundle_kind: str | None = None
    if isinstance(bundle, dict):
        bn = bundle.get("name")
        bk = bundle.get("kind", "thematic")
        if isinstance(bn, str) and bn:
            bundle_name = bn
        if isinstance(bk, str) and bk in {"thematic", "baseline"}:
            bundle_kind = bk
    return _PluginEntry(
        name=name,
        version=version if isinstance(version, str) else "",
        tier=tier if isinstance(tier, str) else "",
        plugin_dir=plugin_dir,
        bundle_name=bundle_name,
        bundle_kind=bundle_kind,
    )


def _scan_plugins(plugins_dir: Path) -> list[_PluginEntry]:
    """Return every parsable plugin under ``plugins_dir``, sorted by name."""
    if not plugins_dir.is_dir():
        return []
    entries: list[_PluginEntry] = []
    for child in sorted(plugins_dir.iterdir()):
        if not child.is_dir() or child.name.startswith("."):
            continue
        entry = _entry_from_manifest(child)
        if entry is not None:
            entries.append(entry)
    return entries


async def _fetch_installed_names(database_url: str) -> set[str]:
    """Return the set of plugin names with a row in ``eidan.plugin_state``.

    Used by ``plugin list`` to mark which plugins have had their
    ``on_install`` hook recorded. A connection failure short-circuits
    to "we don't know" — the listing still prints, with the installed
    column blank, so an operator running ``plugin list`` against a
    misconfigured ``DATABASE_URL`` still sees their on-disk inventory.
    """
    import asyncpg

    plain = database_url.replace("postgresql+asyncpg://", "postgresql://", 1)
    conn = await asyncpg.connect(plain)
    try:
        rows = await conn.fetch("SELECT name FROM eidan.plugin_state")
    finally:
        await conn.close()
    return {row["name"] for row in rows}


def _format_table(rows: list[tuple[str, str, str, str, str]]) -> str:
    """Pretty-print a fixed-width table with the `name | version | tier | bundle | installed` columns."""
    headers = ("NAME", "VERSION", "TIER", "BUNDLE", "INSTALLED")
    widths = [len(h) for h in headers]
    for row in rows:
        for i, cell in enumerate(row):
            widths[i] = max(widths[i], len(cell))
    fmt = "  ".join("{:<" + str(w) + "}" for w in widths)
    out = [fmt.format(*headers)]
    for row in rows:
        out.append(fmt.format(*row))
    return "\n".join(out)


def plugin_list() -> int:
    """Print every plugin installed under ``plugins/`` with bundle + state.

    Reads each ``plugins/<name>/plugin.yaml`` and joins against
    ``eidan.plugin_state`` so the operator can see at a glance which
    plugins are merely on disk and which have actually had their
    ``on_install`` hook recorded. Connection failure on the state-row
    lookup degrades gracefully — the on-disk inventory still prints.
    """
    import asyncio

    entries = _scan_plugins(PLUGINS_DIR)
    if not entries:
        print("(no plugins installed)")
        return 0

    installed: set[str]
    try:
        url = _need_database_url()
    except SystemExit:
        installed = set()
        print(
            "warning: DATABASE_URL not set; "
            "installed-state column will be blank.",
            file=sys.stderr,
        )
    else:
        try:
            installed = asyncio.run(_fetch_installed_names(url))
        except Exception as exc:  # noqa: BLE001 — degrade gracefully on any DB error
            installed = set()
            print(
                f"warning: could not query eidan.plugin_state: {exc}",
                file=sys.stderr,
            )

    rows: list[tuple[str, str, str, str, str]] = []
    for entry in entries:
        bundle_label = (
            entry.bundle_name if entry.bundle_name else "-"
        )
        if entry.bundle_kind == "baseline" and entry.bundle_name:
            bundle_label = f"{entry.bundle_name} (baseline)"
        rows.append(
            (
                entry.name,
                entry.version or "-",
                entry.tier or "-",
                bundle_label,
                "yes" if entry.name in installed else "no",
            )
        )
    print(_format_table(rows))
    return 0


def _resolve_remove_targets(
    target: str,
    entries: list[_PluginEntry],
) -> list[_PluginEntry]:
    """Return the plugin entries to remove for ``target``.

    ``target`` matches first by **bundle name** (every plugin whose
    manifest declares ``bundle.name == target``) and falls back to a
    single-plugin match on ``name``. This is the (bundle | name)
    overload the issue specifies — the CLI does not require the
    operator to disambiguate; if both interpretations would match the
    bundle wins because it is the more deliberate operation.
    """
    by_bundle = [e for e in entries if e.bundle_name == target]
    if by_bundle:
        return by_bundle
    by_name = [e for e in entries if e.name == target]
    return by_name


def _make_uninstall_context(plugin_name: str) -> Any:
    """Build a minimal :class:`PluginContext` for an out-of-band uninstall.

    The CLI runs without the host's HTTP / DB pool, so the context's
    capability fields are stubbed to no-ops. Plugins that need a real
    DB at uninstall time should put their teardown SQL in the
    migration's ``downgrade()`` (which the CLI runs separately) rather
    than in ``on_uninstall``.
    """
    from eidan_backend.plugins import PluginContext

    async def _no_secret(_key: str) -> str | None:
        return None

    class _NoDb:
        def acquire(self, *_args: Any, **_kwargs: Any) -> Any:
            raise RuntimeError(
                "ctx.db is not available during `eidan admin plugin remove`. "
                "Put teardown DDL in the migration's downgrade() instead."
            )

    def _no_router(_router: Any) -> None:
        return None

    def _no_behaviours(_behaviours: Any) -> None:
        return None

    def _no_tools(_tools: Any) -> None:
        return None

    return PluginContext(
        name=plugin_name,
        db=_NoDb(),
        secret=_no_secret,
        register_router=_no_router,
        register_behaviours=_no_behaviours,
        register_tools=_no_tools,
        identity=None,
    )


async def _remove_one_batch(
    targets: list[_PluginEntry],
    *,
    plugins_dir: Path,
    database_url: str,
) -> None:
    """Run lifecycle teardown + migration downgrade for one batch of plugins.

    The batch is ordered by the loader's topological sort over
    ``depends_on``. The lifecycle helper iterates in reverse so a
    plugin's ``on_deactivate`` / ``on_uninstall`` runs before any of
    its dependencies'; the migration helper does the same.
    """
    import asyncpg
    from eidan_backend.plugins import (
        AsyncpgPluginStateStore,
        downgrade_plugin_migrations,
        load_plugins,
        uninstall,
    )

    target_names = {e.name for e in targets}

    loaded = load_plugins(plugins_dir)
    by_name = {p.manifest.name: p for p in loaded}
    missing = sorted(n for n in target_names if n not in by_name)
    if missing:
        raise PluginRemoveError(
            f"plugins not loadable for removal: {missing!r}"
        )

    ordered = [p for p in loaded if p.manifest.name in target_names]

    plain = database_url.replace("postgresql+asyncpg://", "postgresql://", 1)
    pool = await asyncpg.create_pool(plain, min_size=1, max_size=2)
    try:
        state = AsyncpgPluginStateStore(pool)
        await uninstall(
            ordered,
            state=state,
            context_factory=lambda lp: _make_uninstall_context(lp.manifest.name),
        )
    finally:
        await pool.close()

    await downgrade_plugin_migrations(ordered, database_url=database_url)


def _remove_directories(targets: list[_PluginEntry]) -> None:
    """Delete each ``plugins/<name>/`` directory after teardown succeeds."""
    for entry in targets:
        if entry.plugin_dir.is_symlink() or entry.plugin_dir.is_file():
            entry.plugin_dir.unlink()
        elif entry.plugin_dir.exists():
            shutil.rmtree(entry.plugin_dir)


def _baseline_bundles_to_auto_remove(
    remaining: list[_PluginEntry],
) -> list[str]:
    """Return baseline bundle names eligible for auto-removal.

    Per `docs/018 §3` the paid baseline survives only as long as ANY
    thematic bundle is installed. With no thematic plugins remaining,
    every baseline bundle becomes eligible for removal. Returns a
    sorted, deduplicated list (a typical install has one baseline
    bundle, but the contract does not forbid more).
    """
    has_thematic = any(e.bundle_kind == "thematic" for e in remaining)
    if has_thematic:
        return []
    baseline_names = sorted(
        {e.bundle_name for e in remaining if e.bundle_kind == "baseline" and e.bundle_name}
    )
    return baseline_names


def _do_remove(
    target: str,
    *,
    plugins_dir: Path,
    database_url: str,
) -> list[str]:
    """Resolve, tear down, delete; recurse on baseline auto-removal."""
    import asyncio

    entries = _scan_plugins(plugins_dir)
    targets = _resolve_remove_targets(target, entries)
    if not targets:
        raise PluginRemoveError(
            f"no plugin or bundle named {target!r} is installed."
        )

    asyncio.run(
        _remove_one_batch(
            targets,
            plugins_dir=plugins_dir,
            database_url=database_url,
        )
    )
    _remove_directories(targets)
    removed = [e.name for e in targets]

    remaining = _scan_plugins(plugins_dir)
    for baseline_bundle in _baseline_bundles_to_auto_remove(remaining):
        removed.extend(
            _do_remove(
                baseline_bundle,
                plugins_dir=plugins_dir,
                database_url=database_url,
            )
        )
    return removed


def plugin_remove(target: str | None) -> int:
    """Uninstall a bundle (or single plugin) and clean up its state.

    Per `docs/018 §3`:

    1. Resolve ``target`` to one or more on-disk plugins. ``target``
       matches a manifest ``bundle.name`` (multi-plugin removal) or,
       failing that, a manifest ``name`` (single-plugin removal).
    2. For each resolved plugin (in reverse topological order): run
       ``on_deactivate`` then ``on_uninstall``, ``alembic downgrade
       base`` against the plugin's migrations, drop the
       ``plugin_<name>`` schema, delete the ``plugins/<name>/`` tree,
       and clear the ``eidan.plugin_state`` row.
    3. Per `docs/018 §3`, the paid baseline is auto-removed when no
       thematic bundle remains installed. Detection is metadata-only
       (`bundle.kind`); the CLI does not hard-code bundle names per
       `docs/018 §7` forbidden-string posture.
    """
    if not target:
        print(
            "usage: eidan admin plugin remove <bundle|plugin-name>",
            file=sys.stderr,
        )
        return 2

    try:
        database_url = _need_database_url()
    except SystemExit as exc:
        return int(exc.code) if isinstance(exc.code, int) else 2

    try:
        removed = _do_remove(
            target,
            plugins_dir=PLUGINS_DIR,
            database_url=database_url,
        )
    except PluginRemoveError as exc:
        print(str(exc), file=sys.stderr)
        return 1

    for name in removed:
        print(f"removed plugins/{name}/")
    return 0


# ---------------------------------------------------------------------------
# agent — operator-mode read/write of the per-user agent_context row.
#
# The row is created on first turn (the loop's ensure_default_agent_context),
# so a freshly-deployed install has nothing to show until the operator has
# logged in at least once. These commands let the operator inspect and
# edit ``user_overrides.system_prompt`` — the persona layer that ships
# on top of the hardcoded EIDAN_BASE_IDENTITY (see turn_header.py).
# ---------------------------------------------------------------------------


class AgentCommandError(Exception):
    """Raised on a recoverable agent-command failure → non-zero exit."""


async def _resolve_user_id(
    conn: Any, *, email: str | None
) -> tuple[UUID, str]:
    """Pick the eidan.users row to operate on.

    With ``--email`` supplied, fetch that row exactly. Without ``--email``
    and exactly one user in the table, fall back to that user — the
    single-operator default. Anything else (zero users, or multiple
    users + no ``--email``) is an error the operator must disambiguate.
    """
    if email is not None:
        row = await conn.fetchrow(
            "SELECT id, email FROM eidan.users WHERE email = $1", email
        )
        if row is None:
            raise AgentCommandError(
                f"no user with email {email!r} in eidan.users. "
                "Have they signed in at least once?"
            )
        return UUID(str(row["id"])), row["email"] or ""

    rows = await conn.fetch(
        "SELECT id, email FROM eidan.users ORDER BY created_at ASC LIMIT 2"
    )
    if not rows:
        raise AgentCommandError(
            "no users in eidan.users yet. Sign in once via `eidan login` "
            "+ `eidan repl` (or the web UI) so the loop creates your "
            "agent_context row, then re-run."
        )
    if len(rows) > 1:
        raise AgentCommandError(
            "multiple users found in eidan.users — pass --email <addr> "
            "to pick which one to edit."
        )
    return UUID(str(rows[0]["id"])), rows[0]["email"] or ""


async def _agent_show_async(*, email: str | None, database_url: str) -> int:
    """Print the resolved user's default agent_context row + parsed persona."""
    import json

    import asyncpg
    from eidan_backend.persistence import (
        DEFAULT_AGENT_SLUG,
        ensure_default_agent_context,
    )

    plain = database_url.replace("postgresql+asyncpg://", "postgresql://", 1)
    conn = await asyncpg.connect(plain)
    try:
        user_id, resolved_email = await _resolve_user_id(conn, email=email)
        # ensure_default_agent_context idempotently creates the row so an
        # operator can `agent show` even before the first turn lands.
        async with conn.transaction():
            agent_id, persona = await ensure_default_agent_context(
                conn, user_id=user_id
            )
        row = await conn.fetchrow(
            """
            SELECT display_name, description,
                   code_defaults, user_overrides, enabled,
                   created_at, updated_at
            FROM eidan.agent_context
            WHERE id = $1
            """,
            agent_id,
        )
    finally:
        await conn.close()

    assert row is not None
    print(f"user_id:        {user_id}")
    if resolved_email:
        print(f"email:          {resolved_email}")
    print(f"agent_id:       {agent_id}")
    print(f"agent_slug:     {DEFAULT_AGENT_SLUG}")
    print(f"display_name:   {row['display_name']}")
    print(f"description:    {row['description'] or '-'}")
    print(f"enabled:        {row['enabled']}")
    print(f"created_at:     {row['created_at'].isoformat()}")
    print(f"updated_at:     {row['updated_at'].isoformat()}")

    code_defaults = row["code_defaults"]
    user_overrides = row["user_overrides"]
    code_defaults_dict = (
        json.loads(code_defaults) if isinstance(code_defaults, str) else code_defaults
    )
    user_overrides_dict = (
        json.loads(user_overrides) if isinstance(user_overrides, str) else user_overrides
    )
    print()
    print("code_defaults:")
    print(f"  {json.dumps(code_defaults_dict, indent=2, default=str)}")
    print("user_overrides:")
    print(f"  {json.dumps(user_overrides_dict, indent=2, default=str)}")
    print()
    print("effective persona prompt:")
    if persona:
        for line in persona.splitlines() or [""]:
            print(f"  {line}")
    else:
        print("  (none — only EIDAN_BASE_IDENTITY will render)")
    return 0


def agent_show(email: str | None) -> int:
    """`eidan admin agent show` — print the resolved user's agent_context row."""
    import asyncio

    try:
        database_url = _need_database_url()
    except SystemExit as exc:
        return int(exc.code) if isinstance(exc.code, int) else 2
    try:
        return asyncio.run(_agent_show_async(email=email, database_url=database_url))
    except AgentCommandError as exc:
        print(str(exc), file=sys.stderr)
        return 1


async def _agent_set_persona_async(
    *, email: str | None, persona: str, database_url: str
) -> int:
    """Merge ``{"system_prompt": persona}`` into the user's user_overrides."""
    import json

    import asyncpg
    from eidan_backend.persistence import ensure_default_agent_context

    plain = database_url.replace("postgresql+asyncpg://", "postgresql://", 1)
    conn = await asyncpg.connect(plain)
    try:
        user_id, _ = await _resolve_user_id(conn, email=email)
        async with conn.transaction():
            agent_id, _ = await ensure_default_agent_context(
                conn, user_id=user_id
            )
            # Merge so any sibling keys the operator has stashed in
            # user_overrides survive the edit. jsonb's `||` operator is
            # a shallow merge — the right operand wins on key conflict.
            await conn.execute(
                """
                UPDATE eidan.agent_context
                SET user_overrides = COALESCE(user_overrides, '{}'::jsonb) || $2::jsonb
                WHERE id = $1
                """,
                agent_id,
                json.dumps({"system_prompt": persona}),
            )
    finally:
        await conn.close()
    print(
        f"persona set for agent_id={agent_id} ({len(persona)} chars). "
        f"Next turn will render the new prompt."
    )
    return 0


def _read_persona(persona: str | None) -> str:
    """Resolve the persona text from the CLI arg.

    A literal ``-`` reads the whole prompt from stdin so multi-line
    prompts pipe in cleanly (``eidan admin agent set-persona - < persona.md``).
    """
    if persona is None:
        raise AgentCommandError(
            "set-persona requires a prompt. Pass the text directly or "
            "use '-' to read it from stdin."
        )
    if persona == "-":
        return sys.stdin.read()
    return persona


def agent_set_persona(persona: str | None, email: str | None) -> int:
    """`eidan admin agent set-persona <text>` — write user_overrides.system_prompt."""
    import asyncio

    try:
        text = _read_persona(persona)
    except AgentCommandError as exc:
        print(str(exc), file=sys.stderr)
        return 2
    text = text.strip()
    if not text:
        print("refusing to set an empty persona.", file=sys.stderr)
        return 2
    try:
        database_url = _need_database_url()
    except SystemExit as exc:
        return int(exc.code) if isinstance(exc.code, int) else 2
    try:
        return asyncio.run(
            _agent_set_persona_async(
                email=email, persona=text, database_url=database_url
            )
        )
    except AgentCommandError as exc:
        print(str(exc), file=sys.stderr)
        return 1


async def _agent_clear_persona_async(
    *, email: str | None, database_url: str
) -> int:
    """Drop the ``system_prompt`` key from user_overrides (keeps other keys)."""
    import asyncpg
    from eidan_backend.persistence import ensure_default_agent_context

    plain = database_url.replace("postgresql+asyncpg://", "postgresql://", 1)
    conn = await asyncpg.connect(plain)
    try:
        user_id, _ = await _resolve_user_id(conn, email=email)
        async with conn.transaction():
            agent_id, _ = await ensure_default_agent_context(
                conn, user_id=user_id
            )
            await conn.execute(
                """
                UPDATE eidan.agent_context
                SET user_overrides = user_overrides - 'system_prompt'
                WHERE id = $1
                """,
                agent_id,
            )
    finally:
        await conn.close()
    print(f"persona cleared for agent_id={agent_id}.")
    return 0


def agent_clear_persona(email: str | None) -> int:
    """`eidan admin agent clear-persona` — remove user_overrides.system_prompt."""
    import asyncio

    try:
        database_url = _need_database_url()
    except SystemExit as exc:
        return int(exc.code) if isinstance(exc.code, int) else 2
    try:
        return asyncio.run(
            _agent_clear_persona_async(email=email, database_url=database_url)
        )
    except AgentCommandError as exc:
        print(str(exc), file=sys.stderr)
        return 1


__all__ = [
    "ALEMBIC_INI",
    "PLUGINS_DIR",
    "AgentCommandError",
    "PluginInstallError",
    "PluginRemoveError",
    "agent_clear_persona",
    "agent_set_persona",
    "agent_show",
    "db_migrate",
    "db_reset",
    "plugin_install",
    "plugin_list",
    "plugin_remove",
]
