# TUI boot animation + sidebar fixes — design notes

Captured from a planning conversation on 2026-09-16. Implemented and merged;
see flow 266 (`.metaproject/flows/266-2026-09-16-tui-boot-animation-scrollable-sidebar-ve/`)
for the full record. Three independent pieces, one TUI surface:

1. A one-time branded boot animation on launch.
2. A pre-existing defect: the sidebar's content below "Branch" was
   unreachable.
3. The current running version, shown in the sidebar header.

## 1. Boot animation

### Motivation

A comparable terminal coding agent's TUI ships a proven-out first-launch
animation: ASCII logo, line-by-line reveal, spinner, eased progress bar, and
status lines before the main app takes over. Purely cosmetic, but a
memorable first-launch moment keryx's TUI had none of.

### Decided: no `@opentui/react`

The declarative pattern that makes an animated component like this quick to
write (JSX over `@opentui/core`) was considered and **rejected**.

keryx has a hard, ADR-gated invariant against it
(`docs/decisions/keryx-harness/ADR-0005-opentui-shell-dependency.md`):

- `dependencies == {}` — zero runtime-dependency floor. `optionalDependencies`
  is pinned to an EXACT set — `@modelcontextprotocol/sdk`, `@opentui/core`,
  `web-tree-sitter` — enforced by `src/testing/block-d-no-network.test.ts`
  AC15 and `src/capability/no-optional-imports.test.ts`. The ADR states any
  further dependency needs its own ADR.
- `@opentui/react` pulls in React itself as a runtime dependency — not "one
  more small package," a direct violation of the zero-dependency floor.
- `@opentui/core` is loaded only via `await import()` inside
  `src/tui/tui-shell.ts`, never a top-level import, with mandatory fallback
  to the `node:readline` shell if the package/TTY/renderer isn't available.
  A React tree would need the same discipline and its own headless-test
  mocking layer, on top of the imperative `BoxRenderable`/`TextRenderable`
  mocking every existing TUI test already uses (see `shell-fallback.test.ts`).

Built on plain `@opentui/core` instead — `BoxRenderable`/`TextRenderable` +
`setInterval`, matching every other screen in `src/tui/` (e.g.
`theme-picker.ts`'s pattern of `new otui.BoxRenderable(renderer, {...})`,
OpenTUI injected as a parameter, never statically imported).

### Shipped shape

`src/tui/boot-animation.ts`:

```ts
export async function playBootAnimation(
  otui: OpenTui,
  renderer: Renderer,
  opts: { onKeypress: (handler: (key) => void) => () => void; durationMs?: number; skip?: boolean },
): Promise<void>
```

- Full-screen `BoxRenderable` on `renderer.root`, colors from `getTheme()`
  (`src/tui/theme.ts`) — follows the active theme/light-dark mode, no
  hardcoded palette.
- ASCII "KERYX" wordmark, revealed via `setInterval` at ~120ms cadence
  (matches `shell-chrome.ts`'s spinner cadence).
- Status lines specific to keryx's own subsystems ("Reading .metaproject
  index", "Connecting provider", "Warming graph").
- Any keypress skips immediately, via an injected `onKeypress` subscription
  (mirrors `theme-picker.ts`'s DI shape) — listener unsubscribed before the
  animation resolves.
- `KERYX_SKIP_BOOT=1` or `opts.skip === true` bypass it entirely, before
  mounting anything — the escape hatch for `shell-pty-launch.smoke.test.ts`,
  which spawns the real launch path.
- Called from `launchTuiAgentShell` (`tui-shell.ts`, agent mode) only,
  between `createShellRenderer` and `selectProviderModelInTui`/
  `createShellChrome`; `chat-shell.ts` is unmodified.
- Default duration: 350ms.

## 2. Sidebar scroll fix

**Root cause**: `src/tui/shell-chrome.ts`'s `sidebarTop` ("sb-top", where
every sidebar panel is appended — title, Model, Usage, Context, Directory,
Branch, PR, and more) was a plain `BoxRenderable` with `flexShrink: 0`: on a
short terminal, content past the visible sidebar height was silently
clipped, not scrollable.

**Fix**: rebuilt as a `ScrollBoxRenderable` — the same primitive the main
transcript already uses — with `sidebarTop` bound to its `.content`.
`sidebarSpacer` and the toast stay outside the new scroll container, as
before, still pinned to the bottom regardless of scroll position.

## 3. Current version in the sidebar header

Shows `packageJson.version`, dim, on the same line as the bold "keryx"
title. Extracted into an exported `mountTitlePanel(otui, r, sidebarTop)`
(mirrors `mountCwdPanel`'s existing shape) so it is independently testable.
Uses a renderable id distinct from `sb-version-${uid++}` (`shell-chrome.ts`),
the unrelated, conditional update-available advisory.

## Decisions on the items left open during design

1. **Smoke-test skip hatch**: `KERYX_SKIP_BOOT=1`, checked first in
   `playBootAnimation`, wired into `shell-pty-launch.smoke.test.ts`'s env
   block.
2. **Duration**: 350ms default — short enough not to delay a returning user,
   long enough to read as an animation.
3. **Agent-mode only, not chat-mode.**
4. **Sidebar scroll UX**: default `ScrollBoxRenderable` behavior (mouse
   wheel / focus-scroll) is enough for v1 — no new keybinding, matching the
   transcript's own scrollbox, which has none either.
5. **Version placement**: same line as the "keryx" title.
