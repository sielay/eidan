"""Plugin lint — `eidan admin plugin lint [<name>|--all]`.

Implements the CI-side enforcement of `docs/001 §1.2`. Two layers:

1. Manifest validation via the JSON Schema (reuses
   :func:`eidan_backend.plugins.manifest.load_manifest`), which also
   enforces the directory-name / `manifest.name` match.
2. Static AST scan of the plugin's Python sources for the obvious
   undeclared-access shapes that `docs/012 §3` and `§6.2` raise as
   ``UndeclaredAccessError`` at runtime:
   - ``os.environ["X"]`` / ``os.environ.get("X", ...)`` /
     ``os.getenv("X", ...)`` with literal keys — warned when the key
     is not declared in ``env:``.
   - ``ctx.secret.get(user_id, "X")`` / ``.set`` / ``.delete`` with a
     literal second positional argument — warned when the key is not
     declared in ``vault:``.

The scan handles literal string args only. Dynamic accesses
(``os.environ[var]``) cannot be statically resolved and are left to
the runtime ``UndeclaredAccessError`` per `docs/001 §1.2`.

Any finding produces a non-zero exit code so CI fails on undeclared
access without the operator having to wire a separate gate.
"""

from __future__ import annotations

import ast
import sys
import tomllib
from collections.abc import Iterable
from dataclasses import dataclass
from pathlib import Path

from eidan_backend.plugins.manifest import MalformedManifest, load_manifest


@dataclass(frozen=True)
class LintFinding:
    """A single lint observation against one plugin.

    ``plugin`` is the directory-derived plugin slug, ``location`` is a
    path or ``path:lineno`` for source-level findings, and ``message``
    is the human-readable explanation surfaced to the operator.
    """

    plugin: str
    location: str
    message: str


# Directories under plugins/<name>/ that lint never descends into.
# `migrations/` is generated Alembic boilerplate (`docs/001 §4.1`);
# `tests/` and `web/` may legitimately read process state in ways the
# runtime never invokes; `__pycache__` / `node_modules` are build
# artefacts.
_SKIP_DIRS = frozenset({"migrations", "tests", "web", "__pycache__", "node_modules"})


def _python_files(plugin_dir: Path) -> Iterable[Path]:
    """Yield Python files under ``plugin_dir`` that lint actually scans."""
    for path in sorted(plugin_dir.rglob("*.py")):
        rel = path.relative_to(plugin_dir)
        if any(part in _SKIP_DIRS or part.startswith(".") for part in rel.parts):
            continue
        yield path


def _string_literal(node: ast.AST) -> str | None:
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return node.value
    return None


def _attr_chain(node: ast.AST) -> list[str]:
    """Return the attribute chain for ``a.b.c`` as ``["a", "b", "c"]``.

    Returns an empty list when the chain does not bottom out in a
    plain ``Name`` (e.g. ``func().attr``), so the caller can skip
    expressions whose left-most binding we cannot statically resolve.
    """
    parts: list[str] = []
    cur: ast.AST | None = node
    while isinstance(cur, ast.Attribute):
        parts.append(cur.attr)
        cur = cur.value
    if isinstance(cur, ast.Name):
        parts.append(cur.id)
        parts.reverse()
        return parts
    return []


def _scan_for_env(tree: ast.AST) -> list[tuple[int, str]]:
    """Return ``[(lineno, key)]`` for literal env reads."""
    found: list[tuple[int, str]] = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Subscript):
            chain = _attr_chain(node.value)
            if chain in (["os", "environ"], ["environ"]):
                key = _string_literal(node.slice)
                if key is not None:
                    found.append((node.lineno, key))
            continue

        if isinstance(node, ast.Call):
            chain = _attr_chain(node.func)
            if chain in (["os", "getenv"], ["getenv"]):
                if node.args:
                    key = _string_literal(node.args[0])
                    if key is not None:
                        found.append((node.lineno, key))
            elif chain in (["os", "environ", "get"], ["environ", "get"]):
                if node.args:
                    key = _string_literal(node.args[0])
                    if key is not None:
                        found.append((node.lineno, key))
    return found


def _scan_for_vault(tree: ast.AST) -> list[tuple[int, str]]:
    """Return ``[(lineno, key)]`` for ``*.secret.{get,set,delete}`` calls with a literal key.

    The signature pinned in `docs/012 §6.2` is
    ``ctx.secret.get(user_id, name)`` — the *second* positional
    argument is the vault key. We match by attribute chain ending in
    ``secret.<op>`` regardless of the receiver identifier so plugins
    that rebind ``ctx`` (or use a subagent context with the same
    shape) still get caught.
    """
    found: list[tuple[int, str]] = []
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        chain = _attr_chain(node.func)
        if len(chain) < 2 or chain[-2] != "secret":
            continue
        if chain[-1] not in {"get", "set", "delete"}:
            continue
        if len(node.args) >= 2:
            key = _string_literal(node.args[1])
            if key is not None:
                found.append((node.lineno, key))
    return found


def _package_name_from_pyproject(plugin_dir: Path) -> str | None:
    """Return ``[project].name`` from ``plugin_dir/pyproject.toml`` or ``None``.

    Missing file → ``None`` (`docs/001 §2.1` permits omitting
    ``pyproject.toml``). Unparsable file or missing field → ``None``;
    lint surfaces a single targeted finding in that case rather than a
    stack trace.
    """
    pyproject = plugin_dir / "pyproject.toml"
    if not pyproject.is_file():
        return None
    try:
        data = tomllib.loads(pyproject.read_text(encoding="utf-8"))
    except (OSError, tomllib.TOMLDecodeError):
        return None
    project = data.get("project")
    if not isinstance(project, dict):
        return None
    name = project.get("name")
    return name if isinstance(name, str) else None


def lint_plugin(plugin_dir: Path) -> list[LintFinding]:
    """Run every lint check against ``plugin_dir`` and collect findings.

    Returns an empty list when the plugin is clean; otherwise the
    caller is expected to render the findings and exit non-zero.
    """
    plugin_name = plugin_dir.name
    findings: list[LintFinding] = []

    try:
        manifest = load_manifest(plugin_dir)
    except MalformedManifest as exc:
        # load_manifest's check also enforces the directory ==
        # manifest.name rule from `docs/001 §1.2`, so a mismatch
        # surfaces here as a single targeted manifest finding.
        findings.append(
            LintFinding(
                plugin_name,
                str(plugin_dir / "plugin.yaml"),
                f"manifest invalid: {exc}",
            )
        )
        return findings

    expected_pkg = manifest.name.replace("-", "_")
    pyproject_name = _package_name_from_pyproject(plugin_dir)
    if pyproject_name is not None and pyproject_name not in {
        expected_pkg,
        manifest.name,
    }:
        # pyproject.toml [project].name is a PEP 621 distribution name;
        # `docs/001 §2.1` ties the *import* package name to the
        # snake_case of manifest.name. Accept either spelling to match
        # the convention that PEP 621 names may keep hyphens while the
        # import package replaces them with underscores.
        findings.append(
            LintFinding(
                plugin_name,
                str(plugin_dir / "pyproject.toml"),
                f"pyproject.toml [project].name is {pyproject_name!r}; "
                f"expected {expected_pkg!r} or {manifest.name!r} "
                "(snake_case / hyphenated form of manifest name).",
            )
        )

    declared_env = {item.name for item in (manifest.env or [])}
    declared_vault = {item.key for item in (manifest.vault or [])}

    for path in _python_files(plugin_dir):
        try:
            source = path.read_text(encoding="utf-8")
        except OSError as exc:
            findings.append(
                LintFinding(plugin_name, str(path), f"could not read: {exc}")
            )
            continue
        try:
            tree = ast.parse(source, filename=str(path))
        except SyntaxError as exc:
            findings.append(
                LintFinding(plugin_name, str(path), f"could not parse: {exc}")
            )
            continue

        for lineno, key in _scan_for_env(tree):
            if key not in declared_env:
                findings.append(
                    LintFinding(
                        plugin_name,
                        f"{path}:{lineno}",
                        f"reads env var {key!r} but it is not declared "
                        "in plugin.yaml `env:`.",
                    )
                )

        for lineno, key in _scan_for_vault(tree):
            if key not in declared_vault:
                findings.append(
                    LintFinding(
                        plugin_name,
                        f"{path}:{lineno}",
                        f"reads vault key {key!r} but it is not declared "
                        "in plugin.yaml `vault:`.",
                    )
                )

    return findings


def _discover_targets(
    target: str | None, all_: bool, plugins_dir: Path
) -> tuple[list[Path] | None, int]:
    """Resolve the CLI arguments to a list of plugin directories.

    Returns ``(targets, exit_code)``. When ``targets`` is ``None`` the
    caller exits with ``exit_code`` immediately; otherwise the value
    is a (possibly empty) list of plugin directories to lint.
    """
    if all_ and target:
        print(
            "pass --all OR a plugin name, not both.",
            file=sys.stderr,
        )
        return None, 2

    if not all_ and not target:
        print(
            "usage: eidan admin plugin lint [<name>|--all]",
            file=sys.stderr,
        )
        return None, 2

    if all_:
        if not plugins_dir.is_dir():
            return [], 0
        targets = [
            child
            for child in sorted(plugins_dir.iterdir())
            if child.is_dir() and not child.name.startswith(".")
        ]
        return targets, 0

    assert target is not None  # narrowed by the early returns above
    candidate = plugins_dir / target
    if not candidate.is_dir():
        print(
            f"plugin {target!r} not found under {plugins_dir}.",
            file=sys.stderr,
        )
        return None, 1
    return [candidate], 0


def plugin_lint(
    target: str | None,
    all_: bool,
    *,
    plugins_dir: Path | None = None,
) -> int:
    """Lint one or every plugin under ``plugins/`` and return a CLI exit code.

    Per the issue's acceptance criteria, ``--all`` lints every plugin
    discovered under ``plugins/``; a single positional argument lints
    just that plugin. Any finding fails the run with exit code 1 so CI
    can gate merges on lint cleanliness without bespoke wiring.
    """
    from .admin import PLUGINS_DIR

    root = plugins_dir if plugins_dir is not None else PLUGINS_DIR

    targets, rc = _discover_targets(target, all_, root)
    if targets is None:
        return rc
    if not targets:
        print("(no plugins installed)")
        return 0

    findings: list[LintFinding] = []
    for plugin_dir in targets:
        findings.extend(lint_plugin(plugin_dir))

    if not findings:
        label = "every plugin" if all_ else (target or "")
        print(f"lint OK: {label}")
        return 0

    for finding in findings:
        print(f"{finding.plugin}: {finding.location}: {finding.message}")
    print(f"{len(findings)} lint finding(s).", file=sys.stderr)
    return 1


__all__ = ["LintFinding", "lint_plugin", "plugin_lint"]
