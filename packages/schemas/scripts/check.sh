#!/usr/bin/env bash
# CI sync check (docs/004 §6.3). Regenerates both surfaces and fails if
# the working tree drifts — proving the committed generated/ trees
# match the .schema.json sources.

set -euo pipefail

PKG_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ROOT="$(cd "$PKG_DIR/../.." && pwd)"

cd "$PKG_DIR"

pnpm gen:ts
pnpm gen:py

cd "$REPO_ROOT"

if ! git diff --exit-code -- \
  packages/schemas/src/generated \
  packages/schemas/eidan_schemas/generated; then
  echo "" >&2
  echo "[@eidan/schemas] generated outputs are out of date." >&2
  echo "Run \`pnpm schemas:gen\` and commit the result." >&2
  exit 1
fi
