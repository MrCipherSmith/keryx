#!/bin/sh
# Dev keryx (flow 481 worktree) for the isolated herdr-core session.
# - XDG_CONFIG_HOME is restored to the operator default so provider credentials resolve.
# - cwd is a scratch project so no session lands in the worktree's .metaproject.
# - `shell` gets a fixed provider/model so no interactive picker can hold the start
#   (the herdr-core template command is still exactly `keryx shell`).
S=/private/tmp/claude-502/-Users-tsaitler-aleksandr-goodea-keryx/471f0119-3094-4a52-8b5e-d403c1962c80/scratchpad/k481
WT=/Users/tsaitler.aleksandr/goodea/keryx/.claude/worktrees/herdr-app
cd "$S/project" || exit 1
if [ "$1" = "shell" ]; then
  shift
  exec env -u XDG_CONFIG_HOME /Users/tsaitler.aleksandr/.bun/bin/bun run "$WT/src/cli.ts" shell \
    --provider "${K481_PROVIDER:-deepseek}" --model "${K481_MODEL:-deepseek-chat}" --ask "$@"
fi
exec env -u XDG_CONFIG_HOME /Users/tsaitler.aleksandr/.bun/bin/bun run "$WT/src/cli.ts" "$@"
