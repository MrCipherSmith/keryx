#!/bin/sh
# hc against an ISOLATED herdr-core session for flow 481 T11.
# The operator's own session (HC_SOCKET / HC_TERMINAL_* / HC_SCOPE in this env) is
# never addressed: those variables are removed, HC_SESSION selects a separate core
# (~/.local/state/herdr-core/keryx481), and XDG_CONFIG_HOME points templates and
# config.toml at a scratch dir. PATH puts the dev-keryx wrapper first.
#
# Environment:
#   K481_SCRATCH  required; a scratch directory holding xdg-config/, bin/ (keryx ->
#                 keryx-wrapper.sh) and project/. Nothing here falls back to a real config dir.
#   K481_HC       hc binary (default: hc on PATH).
# (K481_WORKTREE, K481_BUN, K481_PROVIDER, K481_MODEL are read by keryx-wrapper.sh.)
# This script does not locate the checkout, so it needs no symlink resolution.
S="${K481_SCRATCH:?set K481_SCRATCH to the scratch directory of the run}"
HC="${K481_HC:-$(command -v hc)}"
[ -n "$HC" ] || { echo "hc not found on PATH; set K481_HC" >&2; exit 1; }
exec env -u HC_SOCKET -u HC_TERMINAL_SOCKET -u HC_SCOPE -u HC_TERMINAL_ID \
  HC_SESSION=keryx481 \
  XDG_CONFIG_HOME="$S/xdg-config" \
  PATH="$S/bin:$PATH" \
  "$HC" "$@"
