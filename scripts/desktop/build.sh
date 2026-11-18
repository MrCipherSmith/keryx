#!/usr/bin/env bash
# Build the Keryx desktop app (.app and .dmg).
#
# Usage: scripts/desktop/build.sh [--universal]
#   default      host-arch sidecar, host-arch bundle
#   --universal  both sidecars, `--target universal-apple-darwin`
#
# Signing: ad-hoc (identity "-") unless APPLE_SIGNING_IDENTITY is already set
# in the environment (the release workflow sets it for Developer ID builds).
# tauri.conf.json is deliberately not edited for this.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
UNIVERSAL=0
for arg in "$@"; do
  case "$arg" in
    --universal) UNIVERSAL=1 ;;
    -h | --help) sed -n '2,10p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done

export PATH="$HOME/.cargo/bin:$PATH"
export APPLE_SIGNING_IDENTITY="${APPLE_SIGNING_IDENTITY:--}"

if [ "$UNIVERSAL" = 1 ]; then
  bash "$ROOT/scripts/desktop/build-sidecar.sh" --target all
  TAURI_ARGS=(--target universal-apple-darwin)
  BUNDLE_DIR="$ROOT/apps/desktop/src-tauri/target/universal-apple-darwin/release/bundle"
else
  bash "$ROOT/scripts/desktop/build-sidecar.sh"
  TAURI_ARGS=()
  BUNDLE_DIR="$ROOT/apps/desktop/src-tauri/target/release/bundle"
fi

cd "$ROOT/apps/desktop"
bun install --frozen-lockfile || bun install
bun run tauri build --bundles app,dmg ${TAURI_ARGS[@]+"${TAURI_ARGS[@]}"}

echo
echo "signing identity: $APPLE_SIGNING_IDENTITY"
find "$BUNDLE_DIR" -maxdepth 2 \( -name '*.app' -o -name '*.dmg' \) -print
