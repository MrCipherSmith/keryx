#!/bin/sh
# Dev keryx (flow 481 worktree) for the isolated herdr-core session.
# - XDG_CONFIG_HOME is restored to the operator default so provider credentials resolve.
# - cwd is a scratch project so no session lands in the worktree's .metaproject.
# - `shell` gets a fixed provider/model so no interactive picker can hold the start
#   (the herdr-core template command is still exactly `keryx shell`).
#
# Environment:
#   K481_SCRATCH  required; the same scratch directory hci.sh uses (needs project/).
#   K481_WORKTREE the keryx checkout to run; default: the checkout holding this script's
#                 real file (the script is usually run through a scratch bin/keryx symlink).
#   K481_BUN      bun binary (default: bun on PATH).
#   K481_PROVIDER, K481_MODEL  provider/model fixed for `shell` (deepseek / deepseek-chat).
S="${K481_SCRATCH:?set K481_SCRATCH to the scratch directory of the run}"
# Real directory of this script, resolved through symlinks (portable: no readlink -f).
SELF="$0"
while [ -h "$SELF" ]; do
  LINK=$(readlink "$SELF")
  case "$LINK" in
    /*) SELF="$LINK" ;;
    *) SELF="$(dirname "$SELF")/$LINK" ;;
  esac
done
HERE=$(cd "$(dirname "$SELF")" && pwd -P) || exit 1
WT="${K481_WORKTREE:-$(git -C "$HERE" rev-parse --show-toplevel 2>/dev/null)}"
[ -n "$WT" ] && [ -f "$WT/src/cli.ts" ] || { echo "keryx checkout not found (looked for src/cli.ts in '${WT:-<none>}'); set K481_WORKTREE" >&2; exit 1; }
BUN="${K481_BUN:-$(command -v bun)}"
[ -n "$BUN" ] || { echo "bun not found on PATH; set K481_BUN" >&2; exit 1; }
cd "$S/project" || exit 1
if [ "$1" = "shell" ]; then
  shift
  exec env -u XDG_CONFIG_HOME "$BUN" run "$WT/src/cli.ts" shell \
    --provider "${K481_PROVIDER:-deepseek}" --model "${K481_MODEL:-deepseek-chat}" --ask "$@"
fi
exec env -u XDG_CONFIG_HOME "$BUN" run "$WT/src/cli.ts" "$@"
