#!/bin/sh
# hc against an ISOLATED herdr-core session for flow 481 T11.
# The operator's own session (HC_SOCKET / HC_TERMINAL_* / HC_SCOPE in this env) is
# never addressed: those variables are removed, HC_SESSION selects a separate core
# (~/.local/state/herdr-core/keryx481), and XDG_CONFIG_HOME points templates and
# config.toml at a scratch dir. PATH puts the dev-keryx wrapper first.
S=/private/tmp/claude-502/-Users-tsaitler-aleksandr-goodea-keryx/471f0119-3094-4a52-8b5e-d403c1962c80/scratchpad/k481
exec env -u HC_SOCKET -u HC_TERMINAL_SOCKET -u HC_SCOPE -u HC_TERMINAL_ID \
  HC_SESSION=keryx481 \
  XDG_CONFIG_HOME="$S/xdg-config" \
  PATH="$S/bin:$PATH" \
  /Users/tsaitler.aleksandr/.local/bin/hc "$@"
