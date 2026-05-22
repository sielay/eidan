#!/usr/bin/env python3
"""Forbidden-string gate for repo sanitisation (`docs/016 §3.6`).

Reads `release/forbidden-strings.txt`, walks the tree, and exits
non-zero if any literal / regex entry hits a tracked file. Runs in CI
(``release-sanitisation.yml``) and from the CLI
(``eidan admin release sanitise --dry-run``).

Files that are themselves *about* the forbidden list are allowlisted
by path so the catalogue and its specs can mention items without
self-tripping the gate. The allowlist is keyed on substring match
against the relative path — small, explicit, easy to audit.

Behaviour per spec:

- Literal entries match with substring contains (the spec uses
  ``rg -F``; substring is the stdlib equivalent that avoids a ripgrep
  dependency on the runner).
- Regex entries are prefixed ``re:``; the body compiles via
  :mod:`re`.
- A single hit is fatal — the script reports every hit before exiting
  so the operator can fix in one pass.
"""

from __future__ import annotations

import argparse
import re
import subprocess
import sys
from pathlib import Path

# Paths that are *expected* to mention forbidden strings (the catalogue
# itself, the spec that documents it, this script that reads it).
# Substring match against the relative path.
_ALLOWLIST_SUBSTRINGS: tuple[str, ...] = (
    "release/forbidden-strings.txt",
    "release/env-example-forbidden-keys.txt",
    "docs/016_REPO_SANITISATION.md",
    "docs/018_DISTRIBUTION_AND_BUNDLES.md",
    ".github/scripts/sanitise_check.py",
    ".github/workflows/release-sanitisation.yml",
)


def _load_entries(path: Path) -> list[tuple[str, str]]:
    """Return ``[(kind, value), ...]`` where kind is ``literal`` or ``regex``."""
    entries: list[tuple[str, str]] = []
    if not path.exists():
        return entries
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("re:"):
            entries.append(("regex", line[3:]))
        else:
            entries.append(("literal", line))
    return entries


def _tracked_files(root: Path) -> list[Path]:
    """Tracked-file enumeration via ``git ls-files`` — respects
    ``.gitignore`` for free and skips untracked artefacts."""
    result = subprocess.run(
        ["git", "ls-files"],
        cwd=str(root),
        check=True,
        capture_output=True,
        text=True,
    )
    return [
        root / line.strip()
        for line in result.stdout.splitlines()
        if line.strip()
    ]


def _is_allowlisted(rel_path: str) -> bool:
    return any(s in rel_path for s in _ALLOWLIST_SUBSTRINGS)


def _scan_file(
    file_path: Path,
    rel_path: str,
    entries: list[tuple[str, str]],
) -> list[tuple[str, int, str]]:
    """Return ``[(entry, line_number, line_excerpt), ...]`` for every hit."""
    hits: list[tuple[str, int, str]] = []
    try:
        text = file_path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return hits
    for line_no, line in enumerate(text.splitlines(), start=1):
        for kind, value in entries:
            if kind == "literal" and value in line:
                hits.append((value, line_no, line[:120]))
            elif kind == "regex" and re.search(value, line):
                hits.append((value, line_no, line[:120]))
    return hits


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--catalogue",
        default="release/forbidden-strings.txt",
        help="Path to the forbidden-strings catalogue.",
    )
    parser.add_argument(
        "--root",
        default=".",
        help="Tree root to scan (defaults to CWD).",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Print hits but always exit 0 (CLI inspection mode).",
    )
    args = parser.parse_args()

    root = Path(args.root).resolve()
    entries = _load_entries(root / args.catalogue)
    if not entries:
        print(
            f"OK — catalogue at {args.catalogue} has no entries; gate is open.",
            flush=True,
        )
        return 0

    files = _tracked_files(root)
    violations: list[tuple[str, str, int, str]] = []
    for fp in files:
        rel = str(fp.relative_to(root))
        if _is_allowlisted(rel):
            continue
        for entry, line_no, excerpt in _scan_file(fp, rel, entries):
            violations.append((rel, entry, line_no, excerpt))

    if not violations:
        print(
            f"OK — scanned {len(files)} tracked file(s) against "
            f"{len(entries)} forbidden entr(y/ies); no hits.",
            flush=True,
        )
        return 0

    print(
        f"\n✗ Found {len(violations)} forbidden-string hit(s):\n",
        file=sys.stderr,
    )
    for rel, entry, line_no, excerpt in violations:
        print(f"  {rel}:{line_no} — {entry!r}", file=sys.stderr)
        print(f"      {excerpt}", file=sys.stderr)
    if args.dry_run:
        print(
            "\n(--dry-run set; exiting 0 anyway so the operator can "
            "iterate locally.)",
            file=sys.stderr,
        )
        return 0
    return 1


if __name__ == "__main__":
    sys.exit(main())
