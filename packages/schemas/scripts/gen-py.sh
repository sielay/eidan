#!/usr/bin/env bash
# JSON Schema -> Pydantic v2 codegen wrapper for eidan-schemas.
#
# Wraps `datamodel-codegen` per docs/004 §3.1. Generated output lands
# under packages/schemas/eidan_schemas/generated/ and is committed; CI
# enforces no diff (§6.3).
#
# datamodel-code-generator is not in the eidan-schemas runtime deps —
# it lives in the [codegen] extra (packages/schemas/pyproject.toml).
# We accept whichever invocation route is available, in order:
#   1. plain `datamodel-codegen` on PATH;
#   2. `uv run --extra codegen datamodel-codegen` if uv is installed;
#   3. `pipx run datamodel-code-generator==<pinned>` as last resort.
# Pick the first that resolves so contributors with any sane Python
# setup can run `pnpm schemas:gen`.

set -euo pipefail

PKG_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC_DIR="$PKG_DIR/schemas"
OUT_DIR="$PKG_DIR/eidan_schemas/generated"

run_codegen() {
  if command -v datamodel-codegen >/dev/null 2>&1; then
    datamodel-codegen "$@"
  elif command -v uv >/dev/null 2>&1; then
    (cd "$PKG_DIR" && uv run --extra codegen datamodel-codegen "$@")
  elif command -v pipx >/dev/null 2>&1; then
    pipx run --spec "datamodel-code-generator==0.25.9" datamodel-codegen "$@"
  else
    echo "[@eidan/schemas] gen:py: no datamodel-codegen available" >&2
    echo "  install one of: 'pip install datamodel-code-generator', 'uv sync --extra codegen', 'pipx install datamodel-code-generator'" >&2
    exit 1
  fi
}

rm -rf "$OUT_DIR"
mkdir -p "$OUT_DIR"

run_codegen \
  --input "$SRC_DIR" \
  --input-file-type jsonschema \
  --output "$OUT_DIR" \
  --output-model-type pydantic_v2.BaseModel \
  --target-python-version 3.11 \
  --use-schema-description \
  --use-field-description \
  --use-standard-collections \
  --use-union-operator \
  --collapse-root-models \
  --disable-timestamp \
  --field-constraints \
  --snake-case-field \
  --use-default \
  --use-double-quotes

# Ensure every directory under generated/ is an importable package even
# when datamodel-codegen omits a stub __init__.py.
find "$OUT_DIR" -type d -print0 | while IFS= read -r -d '' dir; do
  if [ ! -f "$dir/__init__.py" ]; then
    : > "$dir/__init__.py"
  fi
done

# Print the output path relative to the repo root. ``realpath
# --relative-to`` is GNU-only — macOS BSD realpath doesn't have it
# and the trailing echo would fail the whole script with a confusing
# "illegal option" after the codegen already succeeded. Compute the
# relative path with parameter expansion instead.
REPO_ROOT="$(cd "$PKG_DIR/../.." && pwd)"
REL_OUT="${OUT_DIR#"$REPO_ROOT"/}"
echo "[@eidan/schemas] gen:py wrote Pydantic models to $REL_OUT/"
