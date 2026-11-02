#!/bin/sh
# Dev keryx (flow 481 worktree) for the isolated herdr-core session.
# - XDG_CONFIG_HOME is restored to the operator default so provider credentials resolve.
# - cwd is a scratch project so no session lands in the worktree's .metaproject.
# - `shell` gets a fixed provider/model so no interactive picker can hold the start
#   (the herdr-core template command is still exactly `keryx shell`).
#
# K481_SCRATCH: the same scratch directory hci.sh uses (needs project/).
# K481_WORKTREE: the keryx checkout to run; defaults to the checkout holding this script.
S="${K481_SCRATCH:?set K481_SCRATCH to the scratch directory of the run}"
HERE=$(dirname "$0")
WT="${K481_WORKTREE:-$(git -C "$HERE" rev-parse --show-toplevel)}"
BUN="${K481_BUN:-$(command -v bun)}"
[ -n "$BUN" ] || { echo "bun not found on PATH; set K481_BUN" >&2; exit 1; }
cd "$S/project" || exit 1
if [ "$1" = "shell" ]; then
  shift
  exec env -u XDG_CONFIG_HOME "$BUN" run "$WT/src/cli.ts" shell \
    --provider "${K481_PROVIDER:-deepseek}" --model "${K481_MODEL:-deepseek-chat}" --ask "$@"
fi
exec env -u XDG_CONFIG_HOME "$BUN" run "$WT/src/cli.ts" "$@"
