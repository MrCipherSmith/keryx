# TRD: TUI Main-Queue Dock + Region Click-to-Focus

Upstream: [prd.md](prd.md) (source of truth for scope/requirements). [README.md](README.md)
holds the discovery notes this TRD grounds against actual code. No BRD exists for this
package — PRD is the highest upstream document.

Grounding pass: read `src/tui/shell-chrome.ts`, `src/tui/composer-choice.ts`,
`src/tui/tui-shell.ts` (`paintMainQueue`/`removeMainQueue`/`editMainQueue`/
`forceMainQueue`, ~line 2414-2478), `src/tui/main-queue.ts` (2026-08-18).

Added 2026-08-18: §1.6 (click-to-focus routing) and the corresponding parts of §3/§4
ground PRD FR-11..FR-15, folded into this package after §1.1-1.5 were confirmed.
Grounding for that addition: `shell-chrome.ts`'s layout skeleton (`rootRow` →
`main`/`sidebar`, `main` → `header`/`scroll`(transcript)/`dock`/composer/footer,
~line 342-474), `composer-choice.ts`'s `onMouseDown` mechanism (already used in §1.3),
and the `chrome.input`/`input.focus()` call sites already present throughout
`tui-shell.ts` (14 existing call sites, none of them at startup — confirmed no
existing launch-time autofocus call to conflict with).

## 1. Architecture

### 1.1 Current layout (unchanged parts)

`shell-chrome.ts` builds the shell as a `main` flex-column container; children are
mounted via `main.add(...)` in visual top-to-bottom order (comment at
`shell-chrome.ts:219`: "header, transcript, dock, menu, composer, footer"):

```
main (flexDirection: column)
 ├─ header
 ├─ scroll (transcript)         ← main.add(scroll)   shell-chrome.ts:474
 ├─ dock ("choice-dock")        ← main.add(dock)     shell-chrome.ts:494
 ├─ /-menu
 ├─ composer
 └─ footer
```

`dock` (`shell-chrome.ts:480-493`) is a single, reused `BoxRenderable` — `{ id:
"choice-dock", flexShrink: 0, flexDirection: "column", visible: false,
backgroundColor: theme.panel, borderStyle: "rounded", border: true, borderColor:
theme.border }` — that every `showComposerChoice()` call (`composer-choice.ts`)
mounts into and tears down from. It is ephemeral and single-purpose: exactly one
choice prompt owns it at a time, and `dock.visible` is part of the shell's keyboard
arbitration (`overlayActive()`, `shell-chrome.ts:502-509` — while the dock is
visible, the `/`-menu router stays inert).

`paintMainQueue()` (`tui-shell.ts:2415-2442`) currently does not touch this layout
at all — it calls `appendUserEcho(otui, r, transcript, {...})` once per queue item,
mounting each item's marker box **inside `transcript`** (the scrollable conversation
history), interleaved with real turns.

### 1.2 New component: a persistent queue-dock Box

**Decision (resolves PRD FR-1, FR-10):** add a second, purpose-built `BoxRenderable`
— call it `queueDock` — constructed the same way as `dock` (same panel styling:
`flexShrink: 0`, rounded border, theme panel/border colors) but with different
semantics: **persistent and multi-item** rather than ephemeral and single-choice.
Insert it into `main`'s child order **between `scroll` and `dock`**:

```
main.add(scroll)     // unchanged
main.add(queueDock)  // NEW
main.add(dock)        // unchanged — existing choice-dock, still added right after
// ... /-menu, composer, footer additions: unchanged, same relative order
```

Rationale: `queueDock` is a passive, always-may-be-present status display (pending
work), while `dock` is an active, blocking decision that needs the user's immediate
attention. Keeping the active decision closest to the composer — where the user's
next keystroke lands — and the passive reminder one step further up mirrors how
`dock` already "opens upward into the transcript" (existing design intent per its
own comment at `shell-chrome.ts:478`). This requires **zero changes** to any
existing box's construction or add-order — `queueDock` is a pure insertion.

Ownership: `queueDock` is created in `shell-chrome.ts` alongside `dock` (same
function, same scope) and exposed on `ShellChrome`'s public interface next to the
existing `readonly dock: Box` field (`shell-chrome.ts:234-235`) as `readonly
queueDock: Box`, so `tui-shell.ts` consumes it the same way it already consumes
`chrome.dock`.

### 1.3 Per-item row: three independent click targets, not one

**Decision (resolves PRD FR-2):** `composer-choice.ts`'s proven pattern is "one row
= one `BoxRenderable` with one `onMouseDown`" (`composer-choice.ts:200-207`). A
queue item needs three independently-triggerable actions, so each item's row is a
`flexDirection: "row"` container holding:

```
[ q1 (2) <displayQuestion text, truncated>          ]  [Force] [Edit] [Delete]
```

— the text on the left (a `TextRenderable`, reusing `formatMainQueueMarker`'s `qN
(p)` text for the leading label, exactly as `paintMainQueue` renders it today, just
relocated) and three small `BoxRenderable` "buttons" on the right, each with its own
`onMouseDown`, same primitive as `composer-choice.ts:204-206`, just three sibling
targets instead of one row-sized target:

```ts
new otui.BoxRenderable(r, { id: `mq-force-${item.id}`, onMouseDown: () => forceMainQueue(index) });
new otui.BoxRenderable(r, { id: `mq-edit-${item.id}`,  onMouseDown: () => editMainQueue(index) });
new otui.BoxRenderable(r, { id: `mq-del-${item.id}`,   onMouseDown: () => removeMainQueue(index) });
```

No new business logic — these three calls are the exact existing `tui-shell.ts`
functions (`removeMainQueue`/`editMainQueue`/`forceMainQueue`, unchanged).

### 1.4 Keyboard path — flagged for maintainer UX sign-off

**Decision (resolves PRD FR-8), lower confidence than 1.2/1.3 — this is a new
interaction shape, not reused code, and is the one part of this TRD most worth a
maintainer's explicit review before implementation starts.**

Today exactly one of {composer, block-nav mode, choice-dock} owns the keyboard at a
time (`overlayActive()` arbitration, `shell-chrome.ts:502-509`; `onKeypress`
wrapper, `tui-shell.ts:928`). Recommend adding a fourth mode, **queue-nav**, on the
same arbitration axis:

- Entry: a dedicated key (proposed: `Ctrl+Q`, unused elsewhere in this file per a
  grep of existing `ctrl &&` key handlers — implementer should re-verify no
  collision at build time) while `mainQueue.length > 0`.
- While active: `↑`/`↓` move a `selectedQueueIndex` between items (mirrors
  `composer-choice.ts`'s `selected` + `paintOptions()` re-highlight pattern,
  `composer-choice.ts:170-191`); `←`/`→` move between the three actions for the
  selected item; `Enter` triggers the highlighted action; `Esc` exits queue-nav
  without acting, same as `composer-choice.ts`'s `finish(request.cancelId)` pattern
  on escape.
- `overlayActive()` must treat queue-nav as active while it holds the keyboard, the
  same way `dock.visible === true` already does, so the `/`-menu router stays inert
  during it.

This mode is additive: it does not replace mouse interaction (1.3), and does not
replace the `/queue <action> [N]` text command (PRD FR-9, unchanged — `tui-shell.ts`
already parses it via `parseQueueCommand` and calls the same three functions).

### 1.5 `paintMainQueue()` rewrite

`paintMainQueue()` stops calling `appendUserEcho(..., transcript, ...)` and instead
clears/repaints `queueDock`'s children from `mainQueue` on every mutation (same
"remove stale blocks, rebuild all" strategy it already uses at
`tui-shell.ts:2416-2424`, just targeting `queueDock` instead of `transcript`).
`queueDock.visible` follows `mainQueue.length > 0`, mirroring how `dock.visible`
already gates the existing choice dock — when the queue empties, `queueDock` is
hidden and takes no layout space (PRD FR-7), consistent with `main`'s flex-column
sizing (`flexShrink: 0` boxes still collapse to zero when `visible: false`, same as
`dock` does today when no choice is showing).

### 1.6 Region click-to-focus + launch autofocus (FR-11..FR-15)

**Region containers already exist as distinct `Box` instances** —
`shell-chrome.ts` builds exactly the containers PRD FR-11/FR-13 need:
`sidebar` (`shell-chrome.ts:360-371`), and `scroll`/transcript (`shell-chrome.ts:465-474`,
inside `main`). `queueDock` (§1.2, new) is the third. Each of these three already
supports the same `onMouseDown` prop `composer-choice.ts` uses for its rows
(§1.3/§2) — `BoxRenderable`'s mouse handling is per-instance, not something that has
to be built. This TRD's job is wiring existing containers to existing focus calls,
not inventing new plumbing:

```ts
// shell-chrome.ts, alongside each container's construction
sidebar.onMouseDown = () => { /* focus sidebar's own focus target, TBD by whatever
                                  the sidebar's most-recently-focusable element is —
                                  today the sidebar has no focusable child of its
                                  own (it is display-only: model/context/worker
                                  panels + toast), so FR-11 in practice moves
                                  OpenTUI's render focus to `sidebar` itself as a
                                  container so scroll/selection work there, with no
                                  further behavior change implied. */ };
scroll.onMouseDown = () => { chrome.input.focus(); };       // FR-13: transcript click -> composer
queueDock.onMouseDown = () => { enterQueueNavMode(); };     // FR-12: see below re: bubbling
```

**Ordering matters for FR-12's "click a button fires the action, not just focus"
requirement.** `queueDock`'s own `onMouseDown` (focus the dock) and each
Force/Edit/Delete button's `onMouseDown` (§1.3, fires the action) are on different
nested `BoxRenderable`s (button is a child of the item row, which is a child of
`queueDock`). The implementer must confirm OpenTUI's mouse-event dispatch fires the
most specific (deepest) handler rather than bubbling to every ancestor's handler
too — if it bubbles by default, `queueDock`'s handler must be written to no-op when
`event.target` is a button (or the buttons' handlers must call something like
`event.stopPropagation()` if OpenTUI's `onMouseDown` signature exposes that). This
is a real implementation risk flagged here rather than assumed away: verify
OpenTUI's actual dispatch behavior (check `@opentui/core`'s source/types for
`onMouseDown`'s signature and any propagation control) before writing the click
handlers, don't guess.

**FR-15 (don't steal focus from an active overlay)** is already solvable with the
existing arbitration primitive: `overlayActive()` (`shell-chrome.ts:502-509`, already
checked in §1.4) returns true while `dock.visible === true` or any registered
overlay source is active. Each new region handler should early-return when
`overlayActive()` is true, deferring entirely to whatever surface already owns the
keyboard — no new arbitration mechanism needed, just a guard clause reusing the
existing check.

**FR-14 (launch autofocus)**: a single `chrome.input.focus()` call placed
immediately after `chrome` is constructed (`tui-shell.ts:1536`,
`const chrome = await createShellChrome(...)`) and before the shell's main
input/render loop begins accepting keystrokes. This TRD confirmed (via a full scan
of `tui-shell.ts`'s 14 existing `input.focus()` call sites) that none of them fire
at startup — every existing call is a post-action refocus (after closing a picker,
after a mode change, etc.) — so there is no existing autofocus behavior to
conflict with; this is a net-new single call, not a refactor of existing focus
logic.

## 2. Tech Stack

No new dependency. Everything below already exists in this TypeScript/Bun +
`@opentui/core` codebase:

| Concern | Component (existing, reused) |
|---|---|
| Layout container | `src/tui/shell-chrome.ts` (`main` flex-column, `ShellChrome` interface) |
| New persistent panel | `otui.BoxRenderable` — same constructor shape as `dock` (`shell-chrome.ts:480-493`) |
| Per-item text | `otui.TextRenderable` — same as `composer-choice.ts`'s row labels |
| Mouse click targets | `BoxRenderable`'s native `onMouseDown` prop (`composer-choice.ts:204-206`) — no new event plumbing |
| Keyboard subscription | `onKeypress(r, handler)` (`tui-shell.ts:928`, wraps `_internalKeyInput`) — reused, not reimplemented |
| Queue data/actions | `src/tui/main-queue.ts` (pure) + `tui-shell.ts`'s `removeMainQueue`/`editMainQueue`/`forceMainQueue` — reused verbatim |

## 3. Data Models

No new persisted or transmitted data shape. `QueuedMainQuestion` (`main-queue.ts:14-18`:
`{ id: string; question: string; displayQuestion: string }`) is reused as-is — this
TRD found no gap in it. The only new in-memory state is presentational:

```ts
// tui-shell.ts, alongside existing mainQueue state
let queueDockBlocks: Array<{ id: string; row: Box }> = []; // mirrors mainQueueBlocks today, retargeted
let selectedQueueIndex: number | undefined;                // queue-nav keyboard state (§1.4), undefined when queue-nav is inactive
```

`mainQueue: QueuedMainQuestion[]`, `mainQueueSeq`, `pendingQueueEdit`,
`priorityMainQuestion`, `mainTurnAbortController` (`tui-shell.ts:2385-2394`) are
unchanged.

## 4. API / Interaction Contracts

| Contract | Direction | Shape |
|---|---|---|
| Mouse: Force | user click → `tui-shell.ts` | `onMouseDown` on the item's Force box → `forceMainQueue(index)` (unchanged function) |
| Mouse: Edit | user click → `tui-shell.ts` | `onMouseDown` on the item's Edit box → `editMainQueue(index)` (unchanged function) |
| Mouse: Delete | user click → `tui-shell.ts` | `onMouseDown` on the item's Delete box → `removeMainQueue(index)` (unchanged function) |
| Keyboard: queue-nav | user keypress → `tui-shell.ts` | `onKeypress` handler; `↑/↓` moves `selectedQueueIndex`, `←/→` moves selected action, `Enter` calls the same three functions above, `Esc` exits queue-nav |
| Text command (unchanged) | user input → `tui-shell.ts` | `/queue remove\|edit\|force [N]` → `parseQueueCommand` (`main-queue.ts:34-54`) → same three functions |
| Repaint trigger | `mainQueue` mutation → `queueDock` | `paintMainQueue()` rebuilds `queueDock`'s children from `mainQueue`, sets `queueDock.visible = mainQueue.length > 0` |
| Region focus: sidebar | user click → `shell-chrome.ts` | `sidebar.onMouseDown` → focus routed to sidebar (§1.6); no-ops if `overlayActive()` |
| Region focus: transcript/empty | user click → `shell-chrome.ts` | `scroll.onMouseDown` → `chrome.input.focus()` (§1.6); no-ops if `overlayActive()` |
| Region focus: queue dock | user click → `shell-chrome.ts`/`tui-shell.ts` | `queueDock.onMouseDown` → enter queue-nav (§1.4/§1.6), UNLESS the click hit a Force/Edit/Delete button, which fires its own action instead (dispatch-order risk flagged in §1.6) |
| Launch autofocus | shell startup → `tui-shell.ts` | one `chrome.input.focus()` call right after `createShellChrome()` resolves (`tui-shell.ts:1536`), before the input loop starts accepting keys |

No process/network boundary is crossed anywhere in this feature — it is entirely
in-process TUI state and rendering.

## 5. Non-Functional Requirements

- **NFR-1 (data/behavior layer unchanged):** `main-queue.test.ts` must pass
  unmodified — this TRD's changes are confined to `shell-chrome.ts` (new Box +
  interface field) and `tui-shell.ts` (`paintMainQueue`'s render target + new
  queue-nav keyboard handling). No edit to `main-queue.ts`'s exported functions.
- **NFR-2 (no new dependency):** confirmed — `otui.BoxRenderable`/`TextRenderable`
  and the existing `onKeypress` wrapper are the only primitives used, all already
  imported in the touched files.
- **NFR-3 (mouse pattern consistency):** confirmed by construction — §1.3 uses the
  exact `onMouseDown`-per-`BoxRenderable` mechanism `composer-choice.ts` already
  uses, not a new one.
- **NFR-4 (readline shell untouched):** confirmed — all of §1's changes live in
  `src/tui/shell-chrome.ts` and `src/tui/tui-shell.ts`, which the readline shell
  (`src/commands/shell.ts`'s `createRichIo`, per `src/tui/tui-shell.ts`'s own header
  comment) does not import for its queue text-command path.

## 6. Integration Points

- **`src/tui/shell-chrome.ts`** — extended: new `queueDock` Box construction
  (mirrors existing `dock`) + `main.add(queueDock)` insertion + new `readonly
  queueDock: Box` on `ShellChrome`'s public interface (next to `dock`,
  `shell-chrome.ts:234-235`). `overlayActive()` (`shell-chrome.ts:502-509`)
  extended to also treat queue-nav mode as keyboard-owning, same pattern as
  `dock.visible === true` today. Additionally (§1.6): `onMouseDown` handlers added
  to `sidebar`, `scroll` (transcript), and `queueDock` for region click-to-focus;
  each guarded by the existing `overlayActive()` check (FR-15).
- **`src/tui/tui-shell.ts`** — `paintMainQueue()` retargeted from `transcript` to
  `chrome.queueDock`; new queue-nav `onKeypress` handler added alongside the
  existing choice-dock/block-nav handlers; `removeMainQueue`/`editMainQueue`/
  `forceMainQueue` unchanged, now also called from the new mouse/keyboard paths in
  addition to the existing `/queue` command path. One new line: `chrome.input.focus()`
  immediately after `createShellChrome()` resolves (`tui-shell.ts:1536`, §1.6, FR-14).
- **`src/tui/composer-choice.ts`** — read-only reference for the row-painting
  pattern; not modified. The existing choice-dock (`chrome.dock`) is unaffected —
  still ephemeral, still single-choice, still used by every current
  `showComposerChoice()` call site unchanged.
- **`src/tui/main-queue.ts`** — read-only reuse; this TRD found no gap requiring a
  change here (PRD Non-Goals confirmed: no signature changes needed).

## 7. Deployment Notes

- No environment variables, no config file, no migration — this is a pure UI/UX
  change to an already-shipped interactive feature (flow 167). No new CLI flag.
- No infra/rollout changes: ships as part of the normal `keryx` binary; takes effect
  immediately for any interactive OpenTUI session once merged.
- Verification is manual/interactive (same documented limitation as flow 167's own
  AC8: `launchTuiAgentShell` has no headless integration harness in this file) —
  the PRD's Gherkin scenarios (§10) are the manual test script: queue 2+ items,
  exercise Force/Edit/Delete by mouse, then by keyboard (queue-nav), confirm the
  transcript stays free of queue markers, confirm coexistence with an
  approval-gate prompt (trigger a `shell_exec` approval mid-turn while items are
  queued) per §1.2's stacking decision.
- The queue-nav keyboard entry key (proposed `Ctrl+Q`, §1.4) needs a real collision
  check against this file's other `ctrl &&` bindings at implementation time — this
  TRD proposes it but does not treat the exact key as final.
