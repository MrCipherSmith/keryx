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

The downloaded binary is verified against the sha256 digest GitHub records for
that release asset. What that does and does not buy you is stated under
"Integrity" below -- read it before relying on it.

Environment:
  KERYX_REPO          GitHub "owner/repo" to fetch releases from. Defaults to MrCipherSmith/keryx.
  KERYX_RELEASE_TAG    Release tag to install, e.g. v0.2.49. Defaults to latest.
  KERYX_BIN_DIR        Install directory. Defaults to ~/.local/bin (same as install.sh --global).
  KERYX_ACKNOWLEDGE_NO_CHECKSUM=1
                       Install WITHOUT verifying the digest. Needed only where no
                       sha256 tool exists or the release metadata cannot be read.
                       It is an explicit acknowledgement, not a default: the
                       script refuses rather than skipping the check quietly.

Integrity:
  The expected digest comes from the GitHub API, and the binary comes from the
  same GitHub release. So this detects a corrupted or truncated download and a
  tampered CDN copy -- it does NOT defend against a compromised GitHub account
  or a compromised API, because both halves would then come from the same
  attacker. Verifying against an independently published digest would be a
  stronger claim, and this script does not make it.
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
  API_URL="https://api.github.com/repos/${REPO}/releases/latest"
else
  DOWNLOAD_URL="https://github.com/${REPO}/releases/download/${RELEASE_TAG}/${ASSET}"
  API_URL="https://api.github.com/repos/${REPO}/releases/tags/${RELEASE_TAG}"
fi

# The sha256 tool differs by platform: coreutils on Linux, shasum on macOS.
sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | cut -d' ' -f1
  else
    return 1
  fi
}

# GitHub records a `digest` per release asset ("sha256:<hex>"). Prefer jq; fall
# back to a whitespace-stripped scan when it is absent, since this script's only
# hard dependency is curl and adding jq would change who can run it.
expected_digest() {
  if command -v jq >/dev/null 2>&1; then
    jq -r --arg n "$ASSET" '.assets[] | select(.name == $n) | .digest // empty'
  else
    tr -d ' \n\t' \
      | sed 's/},{/}\
{/g' \
      | grep -F "\"name\":\"${ASSET}\"" \
      | sed -n 's/.*"digest":"sha256:\([0-9a-f]\{64\}\).*/sha256:\1/p' \
      | head -n 1
  fi
}

# Fail closed on every branch that cannot establish the expected digest. A
# verification step that silently degrades to "installed anyway" is the shape
# this check was added to remove.
refuse_unverified() {
  if [ "${KERYX_ACKNOWLEDGE_NO_CHECKSUM:-}" = "1" ]; then
    echo "warning: installing WITHOUT digest verification ($1)." >&2
    echo "         KERYX_ACKNOWLEDGE_NO_CHECKSUM=1 was set, so this is your explicit choice." >&2
    return 0
  fi
  echo "Refusing to install: $1" >&2
  echo "Set KERYX_ACKNOWLEDGE_NO_CHECKSUM=1 to install without verifying the digest." >&2
  exit 1
}

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

EXPECTED="$(curl -fsSL "$API_URL" 2>/dev/null | expected_digest || true)"

if [ -z "$EXPECTED" ]; then
  refuse_unverified "could not read a sha256 digest for '$ASSET' from $API_URL"
else
  if ! ACTUAL="$(sha256_of "$TMP_FILE")"; then
    refuse_unverified "no sha256sum or shasum on this machine, so the download cannot be checked"
  else
    if [ "sha256:$ACTUAL" != "$EXPECTED" ]; then
      # Deliberately not installed, and deliberately not left behind: the trap
      # removes it. A mismatched binary kept "for inspection" is a mismatched
      # binary somebody eventually runs.
      echo "Digest mismatch for $ASSET -- refusing to install." >&2
      echo "  expected: $EXPECTED" >&2
      echo "  actual:   sha256:$ACTUAL" >&2
      echo "The download does not match what GitHub records for this release." >&2
      exit 1
    fi
    echo "Verified sha256:$ACTUAL"
  fi
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
