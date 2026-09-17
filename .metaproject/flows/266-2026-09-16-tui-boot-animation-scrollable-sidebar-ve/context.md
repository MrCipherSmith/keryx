# Context

Collected deterministically by `keryx flow init` at 2026-09-16T19:17:03.849Z.
The flow-init skill enriches this with formalization, brainstorm results, and
interview answers.

## Related Memory

1. [1.729] Theme switch repaints already-rendered chrome via old-slot value matching (lesson/accepted) - lessons/theme-switch-repaint.md
   `/theme` in the OpenTUI shell applied and persisted correctly on 0.2.66, but `applyTheme` (src/tui/shell-chrome.ts) only recolored the chrome's OWN surfaces (renderer background, sidebar border, docks, composer, `/`-menu). Every renderable painted EARLIER with `getTheme()` — transcript frames (user echoes, code-segment boxes, block bodies, side-worker boxes), tone-colored block headers (`theme.error`/`theme.tool`), dock/queue-dock buttons, sidebar panels — kept the old palette's hex in its `borderColor`/`backgroundColor`/`fg` props, so a dark→dark switch (groknight↔tokyonight) looked like "the theme did not apply". Fix: on every `applyTheme`, walk the renderable trees (transcript, docks, sidebarTop, menu, composer, header, footer) and rewrite any prop whose color equals an OLD theme slot hex to the NEW slot hex.
   claimType: lesson | confidence: high | version: 0.2.0
   scope: module:src/tui, entity:shell-chrome.ts
   provenance: source=manual link=unknown author=unknown confirmedBy=unknown
2. [1.54] The keryx on PATH is a stale build; the review pipeline does not exercise the code under review (constraint/accepted) - constraints/stale-installed-keryx-binary.md
   `~/.local/bin/keryx` is an installed build, and its version lags the working tree. It is NOT the working tree. Every `keryx …` invocation — including `keryx review ingest`, which is how a managed review package is recorded — runs that build, so the review pipeline routinely does not exercise the code being reviewed.
   claimType: constraint | confidence: high | version: 0.1.0
   scope: module:review, memory, entity:managed-review-package
   provenance: source=fix-round review of PR #220 (flow 133) link=https://github.com/MrCipherSmith/keryx/pull/220 author=unknown confirmedBy=unknown
3. [1.54] A fix round needs its own review: three consecutive rounds each introduced a blocker (lesson/accepted) - lessons/a-fix-round-needs-its-own-review-three-consecutive-rounds-each-introduced-a-blocker.md
   On PR #215 (flow 127, project registry) three consecutive review-fix rounds each introduced a new blocker while closing the previous one. The defect was not in any single fix; it was in treating a fix as finished once it addressed the reported symptom.
   claimType: lesson | confidence: high | version: 0.5.0
   scope: module:core, entity:project-registry
   provenance: source=review rounds on PR #215 (flow 127), PR #216 (flow 128), PR #220 (flow 133) link=https://github.com/MrCipherSmith/keryx/pull/215 author=unknown confirmedBy=unknown
4. [1.517] OpenTUI: alignSelf on a transcript box collapses its intrinsic height (lesson/accepted) - lessons/tui-alignself-height-collapse.md
   In a `@opentui/core` ScrollBox column, a child `BoxRenderable` carrying `alignSelf: "flex-start"` stops measuring its intrinsic HEIGHT: it collapses to the viewport height, squeezes its children, and makes the ScrollBox under-report `scrollHeight`. Hug content with `maxWidth` instead.
   claimType: lesson | confidence: high | version: 1.0.0
   scope: module:tui, entity:transcript-blocks, shell-chrome
   provenance: source=flow 115 link=.metaproject/flows/115-2026-07-21-tui-dim-collapsible-thought-blocks-fix-a author=unknown confirmedBy=unknown
5. [1.422] SAC: Напиши мне скрипт на питоне цикла от 1 до 10 с промежутка… (task-note/accepted) - task-notes/sac-proposal-d820f7ae5c4b43af.md
   Session fixed /theme perception bug: applyTheme in shell-chrome.ts now repaints already-rendered chrome (transcript frames, tone block headers, dock buttons, sidebar panels) via themeColorToHex/themeColorRemap/recolorThemeTree, because OpenTUI stores colors as RGBA objects. Committed a6dd8dd, pushed to main. Lesson already accepted directly: .metaproject/memory/lessons/theme-switch-repaint.md (created via keryx memory new, bypassing SAC because no slate was open). This proposal records the work for review/audit.
   claimType: task-note | confidence: medium | version: 0.1.0
   scope: unknown
   provenance: source=sac-proposal link=./.metaproject/workspaces/workspace-55936fb9858144ec/session-evidence/6728c7b5-7e93-43a6-9ab4-ea0e9720eaf2.wrap-up.md (sha256 7f281c7cb8399293e9c361fcb0a4f19815108e08a6dfda27db1acdbd29e7f52b) author=unknown confirmedBy=unknown

## Code Graph

- `.metaproject/data/gdgraph/artifacts/summary.md`
- `.metaproject/data/gdgraph/artifacts/module-map.json`

Use `keryx gdgraph affected <file>` for blast radius.

## Enabled Metaproject Modules

- gdgraph
- gdctx
- gdwiki
- gdskills
- health
- testing
- memory
- tasks
- security

## Agent Findings

Direct `keryx ctx rg` reads against the working tree (line numbers confirmed
current, doc's numbers had drifted only slightly):

- `src/tui/tui-shell.ts:57` — `import packageJson from "../../package.json" with { type: "json" };` (confirmed, no new import needed).
- `src/tui/tui-shell.ts:2329` — `const r = (renderer = await createShellRenderer(otui, {...`; `r.on("theme_mode", onThemeMode)` at 2374; `selectProviderModelInTui(...)` at 2377; `createShellChrome(...)` at 2407 — boot animation call site is between 2374 and 2377.
- `src/tui/tui-shell.ts:2465` — `sidebar.add(new otui.TextRenderable(r, { id: "sb-title", content: otui.t\`${otui.bold("keryx")}\` }));` where `const sidebar = chrome.sidebarTop;` (2464).
- `src/tui/shell-chrome.ts:327` — `readonly sidebarTop: Box;` on the `ShellChrome` interface.
- `src/tui/shell-chrome.ts:496-497` — `const sidebarTop = new otui.BoxRenderable(r, { id: "sb-top", flexShrink: 0, flexDirection: "column" }); sidebar.add(sidebarTop);`
- `src/tui/shell-chrome.ts:503` — `id: \`sb-version-${uid++}\`` (the conditional update-available advisory — distinct id space to avoid).
- `src/tui/shell-chrome.ts:523-526` — `sidebarSpacer` (`flexGrow: 1`) and the toast `TextRenderable` (`sb-toast`), both direct children of `sidebar`, must stay outside the new scrollbox.
- `src/tui/shell-chrome.ts:583-593` — the transcript's own `ScrollBoxRenderable` pattern to mirror: `const scroll = new otui.ScrollBoxRenderable(r, { id: "transcript", flexGrow: 1, minHeight: 0, scrollY: true, stickyScroll: true, stickyStart: "bottom", contentOptions: {...} }); main.add(scroll); const transcript = scroll.content;`
- `src/tui/shell-chrome.ts:818` — comment confirms `ScrollBoxRenderable` is self-focusable for keyboard scrolling and mouse-wheel scrollable by the renderer itself, no dedicated keybinding needed elsewhere in the codebase for the transcript's own scrollbox.
- `src/tui/shell-chrome.ts:1177-1194` — `recolorThemeTree(sidebarTop, remap)` in `applyTheme`, and the `return { ..., sidebarTop, ... }` — both keep working unchanged if `sidebarTop` stays typed `Box` (bound to the new scrollbox's `.content`).
- `src/tui/tui-shell.ts:723-747` (`mountCwdPanel`) and other call sites take `sidebarTop: Box` as a parameter — unaffected by the P2 fix for the same reason.
- `src/tui/shell-chrome.ts:122-123` — `const SPINNER = [...]; const SPINNER_MS = 120;` — the cadence P1's reveal ticks should match.
- `src/tui/modal-host.ts:67-70` — the keypress-subscription pattern to reuse (reimplemented locally, not exported): `function onKeypress(r, handler) { r._internalKeyInput.onInternal("keypress", handler); return () => r._internalKeyInput.offInternal("keypress", handler); }`
- `src/tui/theme-picker.ts` and `src/tui/theme.ts` — reference pattern for a plain-`@opentui/core`, OpenTUI-injected-as-parameter, `getTheme()`-driven screen; no static `@opentui/core` import anywhere in either file.
- `src/commands/shell-pty-launch.smoke.test.ts` — `runPtyShell`'s `env` block (`PATH`/`HOME`/`XDG_DATA_HOME`/`TERM`) is where `KERYX_SKIP_BOOT: "1"` must be added; `readyMarker: ALT_ENTER` fires as soon as the renderer enters the alt screen, well before the picker/chrome exist, and the test holds only 750ms after that before sending Ctrl+C — no slack for an un-skipped animation.
- `src/tui/shell-chrome.test.ts:296` — the only existing test reference to `sidebarTop` (`const sidebar = h.chrome.sidebarTop;`) — must keep working unchanged.
