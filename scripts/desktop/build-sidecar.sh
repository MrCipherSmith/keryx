#!/usr/bin/env bash
# Compile the keryx CLI into the Tauri sidecar binaries the desktop app bundles.
#
# Usage: scripts/desktop/build-sidecar.sh [--target arm64|x64|all]
#   Default target is the host architecture.
#
# SOURCE OF TRUTH: the compile command below mirrors the "Build and smoke-test
# the standalone binaries" step in .github/workflows/release.yml (same entry
# `src/cli.ts`, same R1-01 flags). If one changes, change the other.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OUT_DIR="$ROOT/apps/desktop/src-tauri/binaries"

case "$(uname -m)" in
  arm64 | aarch64) HOST=arm64 ;;
  x86_64) HOST=x64 ;;
  *) echo "unsupported host arch $(uname -m)" >&2; exit 1 ;;
esac

TARGET="$HOST"
while [ $# -gt 0 ]; do
  case "$1" in
    --target) TARGET="${2:-}"; shift 2 ;;
    --target=*) TARGET="${1#--target=}"; shift ;;
    -h | --help) sed -n '2,9p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

case "$TARGET" in
  arm64 | x64) TARGETS=("$TARGET") ;;
  all) TARGETS=(arm64 x64) ;;
  *) echo "--target must be arm64, x64 or all (got '$TARGET')" >&2; exit 2 ;;
esac

triple_for() {
  case "$1" in
    arm64) echo "aarch64-apple-darwin" ;;
    x64) echo "x86_64-apple-darwin" ;;
  esac
}

cd "$ROOT"
mkdir -p "$OUT_DIR"

# Per-platform optional native packages (e.g. @opentui/core-darwin-x64) are only
# installed for the current platform by a plain `bun install`; cross-compiling
# the other arch fails without every variant (see release.yml).
bun install --os='*' --cpu='*'

for arch in "${TARGETS[@]}"; do
  triple="$(triple_for "$arch")"
  out="$OUT_DIR/keryx-$triple"
  echo "building bun-darwin-$arch -> $out"
  # R1-01: a compiled binary has no shebang to carry --no-env-file /
  # --config=/dev/null, so the equivalent compile-time flags go here.
  bun build ./src/cli.ts --compile --target="bun-darwin-$arch" \
    --no-compile-autoload-dotenv --no-compile-autoload-bunfig \
    --outfile "$out"
  if [ ! -s "$out" ]; then
    echo "error: $out was not produced or is empty" >&2
    exit 1
  fi
  chmod +x "$out"
  echo "size: $(du -h "$out" | cut -f1) ($(wc -c <"$out" | tr -d ' ') bytes)"
  if [ "$arch" = "$HOST" ]; then
    echo "version: $("$out" --version)"
  else
    echo "$arch: cross-compiled, not executed on this host ($(file "$out" | cut -d: -f2-))"
  fi
done
