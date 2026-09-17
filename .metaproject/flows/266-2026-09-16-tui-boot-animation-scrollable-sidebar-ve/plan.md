# Implementation Plan

Status: formalized directly from the design doc (no brainstorm dispatch — the
approach was already decided in the source planning conversation; only the
three open decisions below needed resolving, and they are constrained enough
by the doc's own leanings and the existing codebase that no interview was
needed either).

## Approach

Three independent pieces, one flow, likely three commits:

### P1 — Boot animation (`src/tui/boot-animation.ts`)

`export async function playBootAnimation(otui: OpenTui, renderer: Renderer, opts?: { durationMs?: number; skip?: boolean }): Promise<void>`

- Full-screen `BoxRenderable` on `renderer.root`, colored from `getTheme()`
  (never a hardcoded palette).
- Own ASCII "KERYX" wordmark, revealed line-by-line via
  `setInterval` at the 120ms cadence `shell-chrome.ts`'s `SPINNER_MS` already
  uses, plus a couple of keryx-specific status lines ("Reading .metaproject
  index", "Connecting provider", "Warming graph").
- Skip-on-any-key: reuse the `r._internalKeyInput.onInternal("keypress", …)` /
  `offInternal` pattern `modal-host.ts`'s local `onKeypress` helper already
  uses (not exported — reimplement the same two-line pattern locally).
- On completion or skip: `.remove()` the box from `renderer.root`; never
  `destroy()` the renderer.
- Insertion: `tui-shell.ts`, inside `launchTuiAgentShell`'s try block, right
  after `r.on("theme_mode", onThemeMode)` (~line 2374) and before
  `selectProviderModelInTui(...)` (~line 2377) — one more pre-chrome step in
  the sequence that already has one (the picker). Agent mode only; no change
  to `chat-shell.ts`.
- Skip hatch: `KERYX_SKIP_BOOT=1` checked at the top of `playBootAnimation` —
  short-circuits to an immediate resolve with no renderable ever built, so it
  costs nothing when set. Wire `KERYX_SKIP_BOOT: "1"` into the `env` block
  `shell-pty-launch.smoke.test.ts`'s `runPtyShell` passes to the spawned
  process, alongside the existing `PATH`/`HOME`/`XDG_DATA_HOME`/`TERM` —
  required because that smoke test's `readyMarker: ALT_ENTER` fires as soon
  as the renderer enters the alt screen (before the picker/chrome exist), and
  its Ctrl+C-then-assert-on-drawn-chrome flow has no slack for an animation
  sitting in front of the picker.

### P2 — Sidebar scroll (`src/tui/shell-chrome.ts`)

Replace:
```ts
const sidebarTop = new otui.BoxRenderable(r, { id: "sb-top", flexShrink: 0, flexDirection: "column" });
sidebar.add(sidebarTop);
```
with a `ScrollBoxRenderable` mirroring the transcript's own construction
(`scroll`/`transcript = scroll.content` at line ~583-593):
```ts
const sidebarTopScroll = new otui.ScrollBoxRenderable(r, {
  id: "sb-top",
  flexShrink: 1,
  minHeight: 0,
  scrollY: true,
  contentOptions: { flexDirection: "column" },
});
sidebar.add(sidebarTopScroll);
const sidebarTop = sidebarTopScroll.content;
```
`flexShrink: 1` + `minHeight: 0` (not `flexGrow`) is deliberate: `sidebarSpacer`
(line ~523, `flexGrow: 1`) must keep being the only growing sibling so the
toast stays pinned at the bottom when content is short (unchanged behavior);
when content overflows, standard flexbox shrink math puts nearly all the
negative space on `sidebarTop` (large flex-basis) rather than the ~0-basis
spacer, bounding `sidebarTop`'s rendered height and making the scrollbox
actually scroll instead of merely being tall-and-clipped. No other file
changes: `ShellChrome.sidebarTop` stays typed `Box` (now `.content`, exactly
how `transcript` already relates to `scroll`), so `tui-shell.ts`'s
`chrome.sidebarTop`/`mountCwdPanel(..., sidebarTop: Box, ...)` call sites are
unaffected. `recolorThemeTree(sidebarTop, remap)` in `applyTheme` keeps
working unchanged for the same reason.

### P3 — Sidebar version (`tui-shell.ts:2465`)

```ts
sidebar.add(new otui.TextRenderable(r, { id: "sb-title", content: otui.t`${otui.bold("keryx")} ${otui.dim(`v${packageJson.version}`)}` }));
```
Same line as the title (decision below), distinct id space from
`sb-version-${uid++}` (the conditional update-available advisory in
`shell-chrome.ts`, unrelated).

## Open Decisions (resolved)

1. **Smoke-test skip hatch**: `KERYX_SKIP_BOOT=1`, checked first thing inside
   `playBootAnimation`, wired into `shell-pty-launch.smoke.test.ts`'s
   `runPtyShell` env block. Chosen because it is the doc's own named
   candidate and the smoke test's timing budget (750ms post-`ALT_ENTER` hold)
   has no slack for a real animation sitting in front of the already-timed
   picker step.
2. **Duration**: 350ms default (`durationMs` opt overrides). Short enough
   that a returning user is not meaningfully delayed by a one-time flourish,
   long enough for a handful of 120ms-cadence reveal ticks to actually read
   as an animation rather than a flicker.
3. **Agent mode only, or chat mode too?**: Agent-mode only, matching the
   doc's own leaning. `chat-shell.ts` is out of scope for this flow; revisit
   separately if wanted later.
4. **Sidebar scroll UX**: default `ScrollBoxRenderable` behavior (mouse
   wheel / trackpad; the box is keyboard-focusable per the existing comment
   at `shell-chrome.ts:818`) is enough for v1 — the transcript's own
   scrollbox has no dedicated keybinding either, so this matches the
   existing pattern rather than inventing a new one.
5. **Version placement**: same line as the "keryx" title (`keryx v0.2.111`
   style), saves a sidebar row on an already content-dense panel.

## Risks

- OpenTUI flex-shrink semantics for `ScrollBoxRenderable` are inferred from
  the transcript's working pattern and the flexbox shrink model, not proven
  against `@opentui/core`'s actual implementation — must be verified against
  a headless `createTestRenderer` test (short sidebar content vs. long
  sidebar content on a small terminal height) before this is accepted, not
  just read from the diff.
- `shell-pty-launch.smoke.test.ts` is gated `darwin`-only and real-subprocess
  -only; the env wiring must be verified by reading the test, since running
  it end-to-end may not be possible in every environment.
- Hand-authored ASCII wordmark must render as fixed-width, equal-length lines
  inside a `BoxRenderable`, verified by a quick throwaway print, not assumed.
