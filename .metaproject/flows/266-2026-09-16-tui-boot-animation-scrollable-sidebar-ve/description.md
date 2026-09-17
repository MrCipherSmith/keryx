# TUI boot animation, scrollable sidebar, version display

Status: formalized
Source: design doc `docs/requirements/keryx-boot-animation/README.md` (planning
conversation, 2026-09-16), committed to this branch as durable history.

## Problem

Three independent, already-scoped TUI gaps on `src/tui/`:

1. keryx's TUI has no first-launch boot moment (a comparable terminal coding
   agent proved this pattern out; keryx currently jumps straight to the
   provider/model picker).
2. `shell-chrome.ts`'s `sidebarTop` (`sb-top`, line ~496) is a plain
   `BoxRenderable` with `flexShrink: 0`: on a short terminal, sidebar content
   past "Branch" is clipped, not scrollable — a real defect, not cosmetic.
3. The sidebar header shows only the "keryx" title, not the running version,
   even though `packageJson` is already imported in `tui-shell.ts` for other
   purposes.

## Expected Outcome

- A new `src/tui/boot-animation.ts` module (`playBootAnimation`) built on
  plain `@opentui/core` primitives — never `@opentui/react` (ADR-0005) —
  wired into `launchTuiAgentShell`'s agent-mode path in `tui-shell.ts`,
  between `createShellRenderer` and the provider/model picker, themed via
  `getTheme()`, skippable on any key, with a `KERYX_SKIP_BOOT=1` escape
  hatch wired into `shell-pty-launch.smoke.test.ts`'s spawn environment so
  the smoke test's existing timing budget is untouched.
- `shell-chrome.ts`'s `sidebarTop` rebuilt as a `ScrollBoxRenderable`
  (mirroring the transcript's own `scroll` at line ~583), with
  `sidebarSpacer`/toast staying pinned outside it. The public `ShellChrome`
  API (`sidebarTop: Box`) does not change shape — it becomes the scrollbox's
  `.content`, exactly like `transcript` already is `scroll.content` — so no
  caller elsewhere in `tui-shell.ts` needs to change.
- The sidebar header (`sb-title` in `tui-shell.ts`) shows `packageJson.version`
  in dim/secondary style, under a distinct renderable id (not
  `sb-version-${uid++}`, which is the unrelated conditional update-available
  advisory).

## Out of Scope

- `@opentui/react` or any new runtime dependency (ADR-0005 is a hard gate).
- Chat mode (`chat-shell.ts`) getting the boot animation — agent-mode only
  (open question 3, resolved below).
- A dedicated scroll keybinding/affordance for the sidebar beyond what
  `ScrollBoxRenderable` already provides by default (open question 4,
  resolved below — same as the transcript, which has no dedicated sidebar
  scroll keys either).
