#!/usr/bin/env bash
set -euo pipefail

REPO_URL="${KERYX_REPO_URL:-https://github.com/MrCipherSmith/keryx.git}"
REF="${KERYX_REF:-main}"
MODE="project"
YES_FLAG=""
NO_GDGRAPH_FLAG=""
NO_GDCTX_FLAG=""

usage() {
  cat <<'USAGE'
Usage:
  install.sh --project [--yes] [--no-gdgraph] [--no-gdctx]
  install.sh --global

Modes:
  --project     Install runtime into .metaproject/runtime/keryx and run init.
  --global      Install CLI into ~/.keryx and write a wrapper script at ~/.local/bin/keryx.

Environment:
  KERYX_REPO_URL   Git repository URL. Defaults to https://github.com/MrCipherSmith/keryx.git
  KERYX_REF        Git ref to checkout. Defaults to main.
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
    --no-gdctx)
      NO_GDCTX_FLAG="--no-gdctx"
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

# Print a file indented, with control characters removed and both the line
# count and each line's length bounded.
#
# `probe.ts` sanitizes and caps the launcher output it quotes, but that code is
# not on this path: here the keryx process has already FAILED, so whatever it
# wrote is unfiltered and unbounded. Left raw it can drive an operator's
# terminal with escape sequences or flood the install transcript.
#
# Pure bash on purpose — no `tr`/`head` pipeline, because this script runs under
# `set -o pipefail` and a failing pipe stage here would abort an install that
# has already succeeded.
print_bounded_output() {
  local file="$1"
  local max_lines=50
  local max_chars=500
  local shown=0
  local line

  while IFS= read -r line || [ -n "$line" ]; do
    # Strip CR (would redraw the line and escape the indent that marks this as
    # the failed process's words) and ESC (ANSI control sequences).
    line="${line//$'\r'/}"
    line="${line//$'\033'/}"
    if [ "${#line}" -gt "$max_chars" ]; then
      line="${line:0:$max_chars}... (line truncated)"
    fi
    echo "    $line"
    shown=$((shown + 1))
    if [ "$shown" -ge "$max_lines" ]; then
      echo "    ... (output truncated)"
      break
    fi
  done < "$file"
}

# Report OS-sandbox containment by asking the keryx that was just installed.
#
# This used to be `command -v bwrap`, and it was wrong in the way that matters:
# on Ubuntu 23.10+ bubblewrap installs cleanly, `command -v` finds it, and every
# contained run then dies with `bwrap: setting up uid map: Permission denied` —
# so the installer told users "Filesystem containment and network-off are
# available" on hosts where nothing was contained.
#
# `keryx sandbox status` now runs one trivial contained command and reports its
# actual outcome, so the installer delegates rather than re-deriving. One source
# of truth, and no wording here that can drift from the CLI's.
#
# $@ — the command that runs keryx (a wrapper path, or `bun /path/to/cli.ts`).
report_sandbox_status() {
  echo
  echo "OS sandbox containment:"

  # Captured rather than piped so a half-written report is never printed, and
  # so the exit status observed is keryx's own. stderr is captured too: on the
  # one path where the installer admits it does not know, the reason why is the
  # only useful thing it has to say.
  #
  # `local` is declared on its own line deliberately — `local x="$(cmd)"` makes
  # the exit status `local`'s, not the command's, which would make the failure
  # branch below unreachable.
  local status_output
  local status_error
  # `|| true` because this whole function is a report and must never gate the
  # install. Under `set -e` a bare `mktemp` failure (unwritable or full TMPDIR)
  # would abort the installer AFTER it had already printed "keryx installed" —
  # turning the containment report into exactly the gate it must not be. An
  # empty value simply means "no stderr capture"; the report still runs.
  status_error="$(mktemp 2>/dev/null || true)"
  # Clean up even if the probe is interrupted mid-run (it may take seconds).
  # shellcheck disable=SC2064 -- expand $status_error now, not at trap time
  trap "rm -f '${status_error}'" RETURN

  if ! status_output="$("$@" sandbox status 2>"${status_error:-/dev/null}")"; then
    # A report, never a gate: if the probe cannot be run at all, say exactly
    # that and carry on. The one thing this must never do is guess
    # optimistically — an unknown result reported as "available" is the defect
    # this function was rewritten to remove.
    echo "  Could not determine containment status — 'keryx sandbox status' did not run here."
    echo "  Nothing is claimed either way. Run it yourself once keryx is on PATH:"
    echo "    keryx sandbox status"
    if [ -n "$status_error" ] && [ -s "$status_error" ]; then
      echo "  It said:"
      print_bounded_output "$status_error"
    fi
    return 0
  fi

  # Indented in-shell rather than through `sed`: this script runs under
  # `set -o pipefail`, so a missing or failing `sed` would abort the installer
  # after it had already reported success.
  while IFS= read -r line; do
    if [ -n "$line" ]; then
      echo "  $line"
    else
      echo
    fi
  done <<EOF
$status_output
EOF
  echo "  Check anytime: keryx sandbox status"
}

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

resolve_command() {
  local name="$1"
  shift

  if command -v "$name" >/dev/null 2>&1; then
    command -v "$name"
    return
  fi

  for candidate in "$@"; do
    if [ -x "$candidate" ]; then
      echo "$candidate"
      return
    fi
  done

  echo ""
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

BUN_BIN="$(resolve_command bun "$HOME/.bun/bin/bun" "/opt/homebrew/bin/bun")"
if [ -z "$BUN_BIN" ]; then
  echo "Missing required command: bun" >&2
  echo "Install Bun first: https://bun.sh" >&2
  exit 1
fi

GH_BIN="$(resolve_command gh "/opt/homebrew/bin/gh" "/usr/local/bin/gh")"
if [ -n "$GH_BIN" ]; then
  "$GH_BIN" auth setup-git >/dev/null 2>&1 || true
fi

if [ "$MODE" = "global" ]; then
  INSTALL_DIR="${KERYX_HOME:-$HOME/.keryx/keryx}"
  BIN_DIR="${KERYX_BIN_DIR:-$HOME/.local/bin}"

  clone_or_update "$INSTALL_DIR"
  # Install pinned deps (bun.lock) so runtime optional features — notably the
  # gdgraph tree-sitter symbol layer's `web-tree-sitter` dep — resolve to a known
  # version instead of a floating global cache. Never fatal (offline is fine).
  ( cd "$INSTALL_DIR" && "$BUN_BIN" install --frozen-lockfile >/dev/null 2>&1 \
      || "$BUN_BIN" install >/dev/null 2>&1 ) || true
  mkdir -p "$BIN_DIR"
  rm -f "$BIN_DIR/keryx"
  cat > "$BIN_DIR/keryx" <<EOF
#!/usr/bin/env bash
exec "$BUN_BIN" "$INSTALL_DIR/src/cli.ts" "\$@"
EOF
  chmod +x "$BIN_DIR/keryx"

  echo "keryx installed globally:"
  echo "  $BIN_DIR/keryx"
  echo
  echo "Make sure this directory is in PATH:"
  echo "  export PATH=\"$BIN_DIR:\$PATH\""
  # The wrapper that was just written — so the probe runs through exactly the
  # keryx this install produced, not some other one already on PATH.
  report_sandbox_status "$BIN_DIR/keryx"
  exit 0
fi

PROJECT_ROOT="$(pwd)"
RUNTIME_DIR="$PROJECT_ROOT/.metaproject/runtime/keryx"

clone_or_update "$RUNTIME_DIR"
"$BUN_BIN" "$RUNTIME_DIR/src/cli.ts" init ${YES_FLAG:+$YES_FLAG} ${NO_GDGRAPH_FLAG:+$NO_GDGRAPH_FLAG} ${NO_GDCTX_FLAG:+$NO_GDCTX_FLAG}

echo "keryx installed for project:"
echo "  $RUNTIME_DIR"
report_sandbox_status "$BUN_BIN" "$RUNTIME_DIR/src/cli.ts"
