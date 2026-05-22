#!/usr/bin/env python3
"""Enforce AGPL-3.0-or-later headers on new source files in a PR.

Run from the `License Header Check` workflow. Walks the set of files
*added* in the PR (status ``A`` against the base sha), keeps only the
extensions we care about (``.py``, ``.ts``, ``.tsx``), drops anything
matched by the exempt-file globs, and prints the violators.

Existing files without a header are not touched: the spec calls for a
one-time backfill PR (`docs/020`, AC#3) to land separately. The check
runs PR-scoped on additions so the policy can roll forward without
flagging the entire pre-existing tree.
"""

from __future__ import annotations

import argparse
import fnmatch
import subprocess
import sys
from pathlib import Path

# The literal SPDX expression we look for in the first ~30 lines of an
# added file. A file is compliant if either token is present — covers
# `# SPDX-License-Identifier: AGPL-3.0-or-later` (Python) and the
# `* SPDX-License-Identifier: AGPL-3.0-or-later` JS/TS block-comment
# form, plus any handcrafted prose that mentions "AGPL-3.0-or-later".
_TOKENS: tuple[str, ...] = (
    "SPDX-License-Identifier: AGPL-3.0-or-later",
    "AGPL-3.0-or-later",
)

_TARGET_EXTS: frozenset[str] = frozenset({".py", ".ts", ".tsx"})

_HEADER_LOOKAHEAD_LINES = 30


def _load_exempts(path: Path) -> list[str]:
    if not path.exists():
        return []
    patterns: list[str] = []
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        patterns.append(line)
    return patterns


def _is_exempt(file_path: str, patterns: list[str]) -> bool:
    for pat in patterns:
        if fnmatch.fnmatch(file_path, pat):
            return True
    return False


def _added_files(base_sha: str, head_sha: str) -> list[str]:
    """Return the list of paths added between ``base_sha`` and ``head_sha``.

    ``--diff-filter=A`` restricts to additions; modifications of files
    that already lack the header are out of scope for this check.
    """
    result = subprocess.run(
        [
            "git",
            "diff",
            "--name-only",
            "--diff-filter=A",
            f"{base_sha}...{head_sha}",
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    return [line.strip() for line in result.stdout.splitlines() if line.strip()]


def _file_has_header(path: Path) -> bool:
    try:
        with path.open("r", encoding="utf-8", errors="replace") as fh:
            head = "".join(next(fh, "") for _ in range(_HEADER_LOOKAHEAD_LINES))
    except OSError:
        return False
    return any(tok in head for tok in _TOKENS)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base-sha", required=True)
    parser.add_argument("--head-sha", required=True)
    parser.add_argument("--exempt-file", required=True)
    args = parser.parse_args()

    exempts = _load_exempts(Path(args.exempt_file))
    added = _added_files(args.base_sha, args.head_sha)

    violators: list[str] = []
    for rel in added:
        if Path(rel).suffix not in _TARGET_EXTS:
            continue
        if _is_exempt(rel, exempts):
            continue
        if not Path(rel).exists():
            # File was added then deleted in the same PR — nothing to check.
            continue
        if not _file_has_header(Path(rel)):
            violators.append(rel)

    if not violators:
        print(
            f"OK — no header violations across {len(added)} added file(s).",
            flush=True,
        )
        return 0

    print(
        "The following NEW source files are missing the AGPL header:\n",
        file=sys.stderr,
    )
    for v in violators:
        print(f"  - {v}", file=sys.stderr)
    print(
        "\nAdd either an `SPDX-License-Identifier: AGPL-3.0-or-later`\n"
        "line or a prose AGPL header at the top of each file. See\n"
        "CONTRIBUTING.md and .github/license_header_exempt.txt for\n"
        "the exempt list.",
        file=sys.stderr,
    )
    return 1


if __name__ == "__main__":
    sys.exit(main())
