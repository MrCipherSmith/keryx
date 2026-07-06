#!/usr/bin/env bash
set -euo pipefail

REPO_URL="${GD_METAPRO_REPO_URL:-https://github.com/MrCipherSmith/meta-project.git}"
REF="${GD_METAPRO_REF:-main}"
MODE="project"
YES_FLAG=""
NO_GDGRAPH_FLAG=""

usage() {
  cat <<'USAGE'
Usage:
  install.sh --project [--yes] [--no-gdgraph]
  install.sh --global

Modes:
  --project     Install runtime into .metaproject/runtime/gd-metapro and run init.
  --global      Install CLI into ~/.gd-metapro and symlink ~/.local/bin/gd-metapro.

Environment:
  GD_METAPRO_REPO_URL   Git repository URL. Defaults to https://github.com/MrCipherSmith/meta-project.git
  GD_METAPRO_REF        Git ref to checkout. Defaults to main.
USAGE
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --project)
      MODE="project"
      ;;
    --global)
      MODE="global"
      ;;
    --yes|-y)
      YES_FLAG="--yes"
      ;;
    --no-gdgraph)
      NO_GDGRAPH_FLAG="--no-gdgraph"
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

clone_or_update() {
  local target="$1"
  mkdir -p "$(dirname "$target")"

  if [ -d "$target/.git" ]; then
    git -C "$target" fetch --depth 1 origin "$REF"
    git -C "$target" checkout --force FETCH_HEAD
    return
  fi

  rm -rf "$target"
  git clone --depth 1 --branch "$REF" "$REPO_URL" "$target"
}

require_command git
require_command bun

if [ "$MODE" = "global" ]; then
  INSTALL_DIR="${GD_METAPRO_HOME:-$HOME/.gd-metapro/gd-metapro}"
  BIN_DIR="${GD_METAPRO_BIN_DIR:-$HOME/.local/bin}"

  clone_or_update "$INSTALL_DIR"
  mkdir -p "$BIN_DIR"
  ln -sf "$INSTALL_DIR/src/cli.ts" "$BIN_DIR/gd-metapro"

  echo "gd-metapro installed globally:"
  echo "  $BIN_DIR/gd-metapro"
  echo
  echo "Make sure this directory is in PATH:"
  echo "  export PATH=\"$BIN_DIR:\$PATH\""
  exit 0
fi

PROJECT_ROOT="$(pwd)"
RUNTIME_DIR="$PROJECT_ROOT/.metaproject/runtime/gd-metapro"

clone_or_update "$RUNTIME_DIR"
bun "$RUNTIME_DIR/src/cli.ts" init ${YES_FLAG:+$YES_FLAG} ${NO_GDGRAPH_FLAG:+$NO_GDGRAPH_FLAG}

echo "gd-metapro installed for project:"
echo "  $RUNTIME_DIR"
