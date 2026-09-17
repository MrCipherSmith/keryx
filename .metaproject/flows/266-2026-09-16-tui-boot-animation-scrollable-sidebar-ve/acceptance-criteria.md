# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: `src/tui/boot-animation.ts` exists, exports `playBootAnimation(otui, renderer, opts?)`, imports `@opentui/core` only structurally (no top-level import — `src/capability/no-optional-imports.test.ts` and the ADR-0005 dependency-floor tests still pass), and builds its box/text renderables from the injected `otui` parameter, never a static import.
- AC2: `playBootAnimation` reads `getTheme()` for all colors used (no hardcoded hex/palette literals for the box/text it paints).
- AC3: `playBootAnimation` resolves immediately, with no renderable added to `renderer.root`, when `process.env.KERYX_SKIP_BOOT === "1"` or `opts?.skip === true`.
- AC4: `playBootAnimation` resolves on any keypress via the `r._internalKeyInput.onInternal("keypress", …)`/`offInternal` pattern, and unsubscribes its own listener before returning (no leaked listener across repeated calls).
- AC5: `playBootAnimation` is called from `tui-shell.ts`'s `launchTuiAgentShell` agent-mode path only, between `createShellRenderer` and `selectProviderModelInTui`/`createShellChrome`; `chat-shell.ts` is unmodified by this flow.
- AC6: `shell-pty-launch.smoke.test.ts`'s `runPtyShell` env block sets `KERYX_SKIP_BOOT: "1"`, and the existing pty assertions (alt-screen entry, mouse SGR, drawn chrome labels, clean exit) still pass conceptually against the modified launch path (verified by reading the test and the modified `tui-shell.ts`, since the suite is `darwin`+real-subprocess gated and may not run in every environment — record which was possible).
- AC7: `shell-chrome.ts`'s `sidebarTop` is constructed as `new otui.ScrollBoxRenderable(...)`  with `sidebarTop` bound to its `.content`; `ShellChrome.sidebarTop`'s declared type remains `Box`.
- AC8: `sidebarSpacer` and the toast `TextRenderable` remain direct children of `sidebar` (siblings of the new scrollbox), not inside `sidebarTop`/its content.
- AC9: A headless test (via the project's existing `createTestRenderer`-based TUI test pattern) demonstrates that sidebar content added past what fits the test terminal's height is reachable through the scrollbox (e.g., scroll position/height API, or content presence in `.content`'s children) where it was previously clipped by a plain `BoxRenderable`.
- AC10: All pre-existing `shell-chrome.test.ts` and `tui-shell.test.ts` assertions that reference `chrome.sidebarTop` / `sb-top` / the panels mounted into it (Model, Usage, Directory, Branch, PR, Context, Tools, Status, etc.) still pass unmodified in behavior (same `.add()` call sites, same ids).
- AC11: `tui-shell.ts`'s `sb-title` renderable shows `packageJson.version` in dim/secondary style alongside the bold "keryx" title, using a renderable id distinct from `sb-version-${uid++}` (the unrelated conditional update-available advisory in `shell-chrome.ts`).
- AC12: A test asserts the sidebar title content contains both "keryx" and the running `packageJson.version` string.
- AC13: `bun test` (or the project's declared test runner) passes for every file touched or added by this flow, and `keryx health run` / lint / type-check report no new failures attributable to this flow's changes.
- AC14: The three open decisions (smoke-test skip hatch, animation duration, agent-mode-only vs. chat-mode) are recorded with their chosen values and rationale in this flow's `journal.md`.
