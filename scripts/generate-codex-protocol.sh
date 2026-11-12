#!/usr/bin/env bash
# Regenerates the Codex App Server protocol bindings from the installed CLI.
# The generated files are committed so the repo typechecks without Codex installed.
set -euo pipefail
cd "$(dirname "$0")/.."
OUT=apps/runtime/src/codex/generated
rm -rf "$OUT"
mkdir -p "$OUT"
codex app-server generate-ts --out "$OUT"
codex --version | sed 's/^codex-cli //' > "$OUT/CODEX_VERSION"
echo "Generated Codex protocol bindings for $(cat "$OUT/CODEX_VERSION") in $OUT"
