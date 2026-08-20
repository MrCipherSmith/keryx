#!/usr/bin/env bash
set -euo pipefail

REPO="${KERYX_REPO:-MrCipherSmith/keryx}"
RELEASE_TAG="${KERYX_RELEASE_TAG:-latest}"
BIN_DIR="${KERYX_BIN_DIR:-$HOME/.local/bin}"

usage() {
  cat <<'USAGE'
Usage:
  install-binary.sh [--yes]

Installs the standalone keryx binary (no bun/git/node dependency) for the
current platform from a GitHub Release.

Environment:
  KERYX_REPO          GitHub "owner/repo" to fetch releases from. Defaults to MrCipherSmith/keryx.
  KERYX_RELEASE_TAG    Release tag to install, e.g. v0.2.49. Defaults to latest.
  KERYX_BIN_DIR        Install directory. Defaults to ~/.local/bin (same as install.sh --global).
USAGE
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --yes|-y)
      # accepted for symmetry with install.sh; this script never prompts
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
  shift
done

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

require_command curl

OS_RAW="$(uname -s)"
ARCH_RAW="$(uname -m)"

case "$OS_RAW" in
  Darwin)
    PLATFORM="darwin"
    ;;
  Linux)
    PLATFORM="linux"
    ;;
  *)
    echo "Unsupported OS: $OS_RAW" >&2
    echo "keryx standalone binaries are only published for macOS (Darwin) and Linux." >&2
    exit 1
    ;;
esac

case "$ARCH_RAW" in
  arm64|aarch64)
    ARCH="arm64"
    ;;
  x86_64)
    ARCH="x64"
    ;;
  *)
    echo "Unsupported architecture: $ARCH_RAW" >&2
    echo "keryx standalone binaries are only published for arm64 and x64." >&2
    exit 1
    ;;
esac

ASSET="keryx-bun-${PLATFORM}-${ARCH}"

if [ "$RELEASE_TAG" = "latest" ]; then
  DOWNLOAD_URL="https://github.com/${REPO}/releases/latest/download/${ASSET}"
else
  DOWNLOAD_URL="https://github.com/${REPO}/releases/download/${RELEASE_TAG}/${ASSET}"
fi

TMP_FILE="$(mktemp)"
cleanup() {
  rm -f "$TMP_FILE"
}
trap cleanup EXIT

echo "Downloading $ASSET ($RELEASE_TAG) from $REPO..."
if ! curl -fsSL "$DOWNLOAD_URL" -o "$TMP_FILE"; then
  echo "Failed to download $DOWNLOAD_URL" >&2
  echo "Check that a release exists with a '$ASSET' asset attached." >&2
  exit 1
fi

if [ ! -s "$TMP_FILE" ]; then
  echo "Downloaded file is empty: $DOWNLOAD_URL" >&2
  exit 1
fi

mkdir -p "$BIN_DIR"
rm -f "$BIN_DIR/keryx"
mv "$TMP_FILE" "$BIN_DIR/keryx"
chmod +x "$BIN_DIR/keryx"
trap - EXIT

echo "keryx installed:"
echo "  $BIN_DIR/keryx"
echo
echo "Make sure this directory is in PATH:"
echo "  export PATH=\"$BIN_DIR:\$PATH\""
