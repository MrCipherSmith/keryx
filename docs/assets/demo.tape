# Keryx README demo, recorded with VHS (https://github.com/charmbracelet/vhs).
#
# Render from the repository root:
#
#   vhs docs/assets/demo.tape
#   cp docs/assets/demo.gif docs/docs/assets/demo.gif
#
# The recording runs the CLI from this checkout (`bun src/cli.ts`) in a fresh
# temporary git repository with a clean environment: a throwaway HOME, no
# provider keys, and a neutral `$ ` prompt. Nothing is written outside the
# temporary directory. Needs bun, git and ripgrep on PATH.

Output docs/assets/demo.gif

Require bun
Require git
Require rg

Set Shell "bash"
Set FontSize 16
Set Width 1200
Set Height 800
Set Padding 20
Set Framerate 12
Set PlaybackSpeed 1.0
Set TypingSpeed 40ms
Set CursorBlink false
Set WindowBar Colorful
Set WindowBarSize 36
Set BorderRadius 10
Set Margin 0
Set Theme { "name": "keryx", "background": "#23243a", "foreground": "#e4e1f5", "cursor": "#a99cf2", "selection": "#3d3a63", "black": "#1b1c2c", "red": "#e07a8a", "green": "#7fd1a0", "yellow": "#f2cf86", "blue": "#8aa8f0", "magenta": "#a99cf2", "cyan": "#7fc8d8", "white": "#d8d5ea", "brightBlack": "#6e6a8e", "brightRed": "#f0909f", "brightGreen": "#95e0b4", "brightYellow": "#f7dca0", "brightBlue": "#a3bbf5", "brightMagenta": "#c3b8fa", "brightCyan": "#9ad8e5", "brightWhite": "#f5f3ff" }

# Setup, not recorded: a wrapper that runs this checkout's CLI, a three-file
# TypeScript project (checkout.ts -> cart.ts -> price.ts), one commit, then a
# clean shell inside it.
Hide
Type `export KERYX_SRC="$PWD/src/cli.ts" DEMO="$(mktemp -d)"` Enter
Type `mkdir -p "$DEMO/bin" "$DEMO/home" "$DEMO/demo/src" && printf '#!/bin/sh\nexec bun "%s" "$@"\n' "$KERYX_SRC" > "$DEMO/bin/keryx" && chmod +x "$DEMO/bin/keryx"` Enter
Type `cd "$DEMO/demo" && printf 'export function applyDiscount(total: number, percent: number): number {\n  return Math.round(total * (100 - percent)) / 100;\n}\n' > src/price.ts` Enter
Type `printf 'import { applyDiscount } from "./price";\n\nexport function cartTotal(prices: number[], discount = 0): number {\n  return applyDiscount(prices.reduce((a, b) => a + b, 0), discount);\n}\n' > src/cart.ts` Enter
Type `printf 'import { cartTotal } from "./cart";\n\nexport const checkout = (prices: number[]) => cartTotal(prices, 10);\n' > src/checkout.ts` Enter
Type `exec env -i HOME="$DEMO/home" PATH="$DEMO/bin:$PATH" TERM=xterm-256color LANG=en_US.UTF-8 GIT_AUTHOR_NAME=Demo GIT_AUTHOR_EMAIL=demo@example.com GIT_COMMITTER_NAME=Demo GIT_COMMITTER_EMAIL=demo@example.com bash --noprofile --norc` Enter
Sleep 500ms
Type `PS1='$ '; git init -q && git add -A && git commit -qm "Initial commit"; clear` Enter
Sleep 1s
Show

# 1. A small project with no Keryx yet.
Type "ls src" Sleep 300ms Enter
Sleep 1s

# 2. Create the workspace with the recommended defaults.
Type "keryx init --yes" Sleep 300ms Enter
Sleep 4.5s
Hide
Type "clear" Enter
Sleep 300ms
Show

# 3. Commit it; the post-commit hook builds the code graph.
Type `git add -A && git commit -qm "Add keryx workspace"` Sleep 300ms Enter
Sleep 2.5s

# 4. Check the setup.
Type "keryx doctor" Sleep 300ms Enter
Sleep 5s
Hide
Type "clear" Enter
Sleep 300ms
Show

# 5. Ask the code graph what depends on price.ts.
Type "keryx gdgraph build" Sleep 300ms Enter
Sleep 1.5s
Type "keryx gdgraph affected src/price.ts" Sleep 300ms Enter
Sleep 3.5s
Hide
Type "clear" Enter
Sleep 300ms
Show

# 6. The wiki is ready for its first pages.
Type "keryx wiki status" Sleep 300ms Enter
Sleep 4s
