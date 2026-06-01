#!/bin/bash
# One-time post-clone setup for the eidan repo.
#
# Wires git's `core.hooksPath` to the tracked `.githooks/` dir so
# every operator gets the same hooks without having to install
# them under .git/hooks manually. Also does the initial `uv tool
# install` of the CLI so the operator's `eidan` command is ready
# immediately.
#
# Idempotent: safe to re-run. Doesn't touch operator-private state
# (no edits to .eidan/, no edits to .git/config beyond hooksPath).

set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$repo_root"

# Sanity: are we inside a git repo? bootstrap.sh shipped via the
# eidan checkout, so this should always be true; the check exists
# so a confused invocation prints a useful error rather than
# silently configuring nothing.
if ! git rev-parse --git-dir >/dev/null 2>&1; then
    echo "ERROR: $repo_root is not a git repo." >&2
    echo "Bootstrap is for an eidan clone — clone the repo first:" >&2
    echo "  git clone https://github.com/sielay/eidan.git" >&2
    exit 1
fi

echo "→ wiring git hooks via core.hooksPath = .githooks"
git config core.hooksPath .githooks

# uv is a hard prerequisite — the CLI install goes through it.
if ! command -v uv >/dev/null 2>&1; then
    cat >&2 <<'EOM'

ERROR: `uv` is not on PATH.

Install it first (one-liner):
  curl -LsSf https://astral.sh/uv/install.sh | sh

Then re-run ./scripts/bootstrap.sh.
EOM
    exit 1
fi

echo "→ installing eidan-cli into uv's tool dir..."
uv tool install --from ./apps/cli eidan-cli >&2

# uv puts tool binaries at ~/.local/bin by default. Operators with
# an unusual PATH may need to add it; surface the location so they
# can verify.
# Everything user-facing goes through a single-quoted heredoc so
# nothing in the message is interpreted. The earlier echo-with-
# double-quotes form ran `eidan` via command substitution when
# `eidan` was wrapped in backticks — which after the menu shipped
# (issue #110) deadlocks the bootstrap waiting on stdin.
cat <<'EOM'

Done. Quick check:
  eidan --help        # should show the CLI
  eidan               # menu

If "eidan" is not on your PATH, add ~/.local/bin:
  echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc   # or ~/.bashrc
EOM
