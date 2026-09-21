---
review_run_id: pr-591-2026-09-18T15-01-31Z
orchestrator: review-orchestrator
verdict: REQUEST_CHANGES
context_mode: light
model_strategy: adaptive
current_model: minimax/MiniMax-M3
model_assignment: per-reviewer classes (all 6 reviewers on minimax/MiniMax-M3)
agents:
  - review-logic
  - review-frontend
  - review-style
  - review-frontend-conventions
  - review-testing-practices
  - review-architecture
scope:
  pr: 591
  base: main
  head: feature/tui-ux-remediation
  files_changed: 26
  additions: 1872
  deletions: 57
  head_sha: 466183e4cc473341358a97f3c11069aaf72c2a27
generated_at: 2026-09-18T15:01:31Z
---

# AI Review Report — PR #591 `feat(tui): OpenTUI shell UX and layout remediation (Flow 269)`

## Executive Summary

The PR implements Flow 269 (10 acceptance criteria AC1–AC10) for the OpenTUI shell. Scope, intent, and overall architecture are correct: every AC has a corresponding code change and a named test, the optional-dependency rule for `@opentui/core` is preserved, the dependency direction (`tui-shell → modal-host`) holds, and the type extensions are additive (no breaks for existing callers).

**Merge blockers (2):**

1. **`pickModelInTui` / `pickSessionInTui` modal branches double-step on arrow keys.** The new onKey handlers in both pickers mutate `sel.selectedIndex` on `up`/`down`, but the focused `SelectRenderable` already moves the selection through its own focus-registered keypress handler (`handleKeyPress` → `moveUp/moveDown`) and does not call `preventDefault`. Result: each arrow press moves the selection by 2 rows away from boundaries, breaking `wrapSelection: true`. The existing `pickSearchProviderStep` does not register up/down — that pattern should be reused.
2. **AC1 sidebar bleed is not actually prevented.** `ensureHost` now mounts the backdrop to `chrome.main ?? r.root`. `ShellChrome.root` is a `rootRow` containing `main` and `sidebar` as siblings (`shell-chrome.ts:474-489`); mounting into `main` leaves the sidebar as an unmasked sibling. With `BACKDROP_ALPHA = 1.0` and `zIndex: 100`, only `main` is occluded. The header docstring still says *"opaque full-window backdrop"*, and Flow 269 `description.md` says underlying transcript text **and** sidebar borders must not bleed. To satisfy AC2's width-clamp goal, only the panel width needs to be clamped inside `chrome.main.width` — the backdrop can stay on `r.root`.

**Strong recommendations (4 majors):** weak AC5 scroll assertion (`>0` instead of `scrollHeight-1`); AC3 doesn't exercise arrow navigation; AC5 scroll-jump is over-applied to the menu picker (contradicts AC6); `BACKDROP_ALPHA` JSDoc still says *"stays visible"* while value is `1.0`. Plus ~13 minor style/convention/documentation drift items and a few info-level notes.

After fixing the two blockers and the four majors, the PR is ready to merge. The architecture and testing foundations are sound — no sweeping refactors needed.

## Review Context

- **PR**: [MrCipherSmith/keryx#591](https://github.com/MrCipherSmith/keryx/pull/591) — base `main`, head `feature/tui-ux-remediation`, HEAD `466183e4cc473341358a97f3c11069aaf72c2a27`.
- **Diff size**: +1872 / -57 lines across 26 files. 12 src/ files (6 source + 6 tests), 1 flow package, 1 docs/requirements package, graph artifacts.
- **Flow context**: Flow 269 (`.metaproject/flows/269-2026-09-18-opentui-shell-ux-and-layout-remediation-/`), 10 ACs (AC1–AC10), all `acConfirmed: true` in `flow.json`.
- **Context mode**: `light`. No `context-collector` invocation; bounded to the diff + local `CLAUDE.md`/`AGENTS.md` conventions + the AC document.
- **Routing audit**: `graph_used: no` (no graph queries needed for a contained diff review); `wiki_used: no` (no architecture decisions to verify against wiki); `ctx_used: no` (no long-running commands); `raw_rg_used: yes` (grep for callers of widened functions; checked `chat-shell.ts` and the two test files that use `pickModelInTui` / `pickSessionInTui` for backwards-compat; confirmed `modal-host.ts` does not import `tui-shell.ts`).
- **Out of scope**: src/tui/modal-host.test.ts full re-read of pre-existing tests; broader refactor of OpenModalInput duplication across 9 inspectors (pre-existing tech debt, not introduced here); renaming the existing `MODAL_PANEL_WIDTH` / `MODAL_PANEL_HEIGHT` deprecated exports.
- **Token policy**: each reviewer received a bounded scope: ~5–10K tokens per prompt including the diff hunks most relevant to its role.

## Findings

### F-001 [blocker] Picker up/down double-handling — SELECTION MOVES BY 2 ROWS

- **Severity**: blocker
- **Reviewer**: review-logic + review-frontend (independent confirmation)
- **File**: `src/tui/tui-shell.ts:2237-2252` and `src/tui/tui-shell.ts:2401-2416`
- **Confidence**: high
- **Status**: open
- **AC ref**: AC3, AC4

**Problem:**
The new modal-mounted branches of `pickModelInTui` (chrome branch starting at line 2183) and `pickSessionInTui` (chrome branch starting at line 2348) register a global `onKey` listener via `onKeypress(r, onKey)`. The handler mutates `sel.selectedIndex` on `key.name === "up"` / `"down"`:

```ts
if (key.name === "up") {
  if (sel !== undefined && sel.selectedIndex > 0) {
    sel.selectedIndex -= 1;
    key.preventDefault();
    key.stopPropagation();
  }
  return;
}
if (key.name === "down") {
  if (sel !== undefined && sel.options.length > 0 && sel.selectedIndex < sel.options.length - 1) {
    sel.selectedIndex += 1;
    key.preventDefault();
    key.stopPropagation();
  }
  return;
}
```

But the focused `SelectRenderable` already has its own keypress handler (`sel.focus()` registers `keypressHandler` on the renderable's internal key input). That handler calls `handleKeyPress` → `moveUp`/`moveDown` and does NOT call `preventDefault`. Both handlers therefore run on every arrow press.

**Why it matters:**
UX regression in both `/model` and `/sessions` pickers. Arrow keys skip a row; `wrapSelection: true` wrap-around breaks at the list boundaries (the picker returns early at `selectedIndex > 0` without preventing default, but the native handler still fires — net effect is a single move, not a double move, at boundaries). User-visible inconsistency.

**Evidence:**
- `src/tui/tui-shell.ts:2237-2252` (pickModel chrome branch up/down).
- `src/tui/tui-shell.ts:2401-2416` (pickSession chrome branch up/down).
- Existing pattern: `pickSearchProviderStep` (around `src/tui/tui-shell.ts:1295` and `:1331`) registers only an Esc handler, relying on `SelectRenderable.focus()`-bound arrow handling.
- AC3 test (`src/tui/model-session-picker-modal.test.ts:38-49`) only types filter chars + Enter; never presses arrow keys, so the bug is not caught.

**Suggested fix:**
Remove the `key.name === "up"` and `key.name === "down"` branches from both `onKey` handlers. Keep only:
- `return` / `enter` — set `chosen`, close, preventDefault, stopPropagation.
- `backspace` — pop last char from filter, call `apply()`, preventDefault, stopPropagation.
- printable char (length === 1, ch >= " ", no ctrl/meta) — append to filter, call `apply()`, preventDefault, stopPropagation.

The focused `SelectRenderable` will own arrow navigation correctly with `wrapSelection: true`.

**Patch guidance** (illustrative — applies to both pickers):
```diff
-            if (key.name === "up") {
-              if (sel !== undefined && sel.selectedIndex > 0) {
-                sel.selectedIndex -= 1;
-                key.preventDefault();
-                key.stopPropagation();
-              }
-              return;
-            }
-            if (key.name === "down") {
-              if (sel !== undefined && sel.options.length > 0 && sel.selectedIndex < sel.options.length - 1) {
-                sel.selectedIndex += 1;
-                key.preventDefault();
-                key.stopPropagation();
-              }
-              return;
-            }
```
(Leave the rest of the handler intact.)

**Regression coverage:**
```gherkin
Feature: picker arrow navigation in ModalHost

  Scenario: /model picker steps one row per arrow press
    Given the /model picker is open with >5 models
    And the second model is highlighted
    When the user presses Down
    Then the third model is highlighted
    And the user presses Up
    Then the second model is highlighted

  Scenario: /sessions picker wraps with wrapSelection
    Given the /sessions picker is open and the last session is highlighted
    When the user presses Down
    Then the first session is highlighted
```

---

### F-002 [blocker] Backdrop no longer covers sidebar — AC1 partial regression

- **Severity**: blocker
- **Reviewer**: review-architecture
- **File**: `src/tui/modal-host.ts:448`
- **Confidence**: high
- **Status**: open
- **AC ref**: AC1

**Problem:**
`ensureHost` previously did `r.root.add(backdrop)`. The PR changes this to:

```ts
const mountTarget = chrome.main ?? r.root;
mountTarget.add(backdrop);
```

In `ShellChrome`, `root` is a `rootRow` containing `main` and `sidebar` as sibling `Box` children (`src/tui/shell-chrome.ts:474-489`). Mounting the backdrop into `main` makes the sidebar an unmasked sibling. With `BACKDROP_ALPHA = 1.0`, the backdrop only occludes `main`; the sidebar stays visible at the same hierarchy level. The header docstring (`modal-host.ts:1-12`) still says *"opaque full-window backdrop"*.

**Why it matters:**
AC1's literal text is *"ModalHost renders an opaque backdrop filling its bounding box so columns 1–4 from underlying transcript text do not bleed through"* — that part is satisfied for `main`. But Flow 269's `description.md` (Problem §1, Expected Outcome §1) says explicitly: *"all underlying transcript text AND sidebar borders do not bleed"*. The new layering contradicts both the AC1's intent (sidebar borders are part of the bleed) and the header docstring.

**Evidence:**
- `src/tui/shell-chrome.ts:474-489` (rootRow composition).
- `src/tui/modal-host.ts:1-12` (header docstring still describes full-window behaviour).
- `src/tui/modal-host.ts:448` (new mount target).
- `.metaproject/flows/269-2026-09-18-opentui-shell-ux-and-layout-remediation-/description.md` (sidebar bleed is in the AC scope).

**Suggested fix:**
Two options — pick one explicitly:

**(a) Recommended:** Keep the backdrop on `r.root` (full coverage). Only clamp the **panel** width inside `chrome.main.width` via `state.panel.width = Math.max(MODAL_PANEL_MIN_WIDTH, Math.min(availWidth, size.width))` (already present). The backdrop returns to "full-window" coverage; the panel satisfies AC2; the sidebar is masked.

**(b)** If sidebar is intentionally exposed during modals (a design decision), then update the AC1 text, the `description.md`, and the `modal-host.ts` header docstring to reflect that.

Current state — main-mounted backdrop + old AC1 wording + old docstring — is internally inconsistent.

**Patch guidance (option a — illustrative):**
```diff
-  const mountTarget = chrome.main ?? r.root;
-  mountTarget.add(backdrop);
+  r.root.add(backdrop);
```
And keep the `state.panel.width = Math.max(MODAL_PANEL_MIN_WIDTH, Math.min(availWidth, size.width))` clamp from openModal.

**Regression coverage:**
```gherkin
Feature: modal backdrop covers sidebar and main

  Scenario: opening /model hides sidebar borders
    Given the shell is at 120x40 with a 30-col sidebar
    When the user opens the /model picker
    Then no sidebar border characters appear in the rendered frame
    And the backdrop spans the full terminal width
```

---

### F-003 [major] AC3 does not exercise arrow navigation

- **Severity**: major
- **Reviewer**: review-testing-practices
- **File**: `src/tui/model-session-picker-modal.test.ts:34-49`
- **Confidence**: high
- **Status**: open
- **AC ref**: AC3

**Problem:**
The AC3 test only filters (types `"deep"`) and presses Enter. It never calls `h.mockInput.pressKeys(["down"])` or similar. The AC3 spec mentions *"arrow navigation"*; F-001's bug therefore slips through.

**Suggested fix:**
After applying the filter, type at least one more printable character than the filter match length to keep the list multi-row, then press Down/Up and assert the highlight changes. Example:

```ts
await h.mockInput.pressKeys(["d", "e", "e", "p"]);
await h.flush();
const filteredFrame = h.captureCharFrame();
expect(filteredFrame).toContain("deepseek-chat");

// Ensure list is multi-row by adding a similar model before pressing edges.
await h.mockInput.pressKeys(["-", "c", "h", "a", "t"]);
await h.flush();
const multiFrame = h.captureCharFrame();
expect(multiFrame).toContain("deepseek-chat");

await h.mockInput.pressKeys(["down"]);
await h.flush();
expect(h.captureCharFrame()).toContain(/* selected highlight indicator */);
```

(OpenTUI's selection highlight is rendered as ANSI / styled fg; capture and assert on the indicator pattern.)

**Regression coverage:** see Gherkin at F-001.

---

### F-004 [major] AC5 scroll assertion is too weak

- **Severity**: major
- **Reviewer**: review-testing-practices
- **File**: `src/tui/shell-chrome.test.ts:1167` (test) and `src/tui/shell-chrome.ts:1049,1059` (production)
- **Confidence**: high
- **Status**: open
- **AC ref**: AC5

**Problem:**
The test asserts `expect(scroll.scrollTop).toBeGreaterThan(0)`. A buggy handler that sets `scrollTop = 1` instead of jumping to the bottom would still pass.

**Suggested fix:**
Replace with a strict equality against the bottom position. OpenTUI clamps `scrollTop` to `scrollHeight - height` internally:

```ts
expect(scroll.scrollTop).toBe(scroll.scrollHeight - 1);
```

Or, more defensively:

```ts
const expected = Math.max(0, scroll.scrollHeight - (scroll.height ?? 0));
expect(scroll.scrollTop).toBe(expected);
```

**Regression coverage:**
```gherkin
Feature: composer submit auto-scrolls to bottom

  Scenario: 40-line transcript, viewport 20 rows, scrollTop manually set to 0
    Given the transcript is 40 lines and viewport shows 20
    And the user manually scrolled to scrollTop=0
    When the user submits a non-empty composer message
    Then scrollTop equals scrollHeight - height
    And stickyScroll is true
```

---

### F-005 [major] AC5 scroll-jump also applied to menu selection — contradicts AC6

- **Severity**: major
- **Reviewer**: review-logic
- **File**: `src/tui/shell-chrome.ts:1046-1059`
- **Confidence**: high
- **Status**: open
- **AC ref**: AC5, AC6

**Problem:**
The PR adds an identical scroll-jump to both:
- `textarea.onSubmit` (around line 1059) — correct: AC5 explicitly scopes this to "Submitting text in the composer".
- `menu.on(ITEM_SELECTED)` (around line 1046) — incorrect: AC5 does not cover slash-menu picking. If the user has scrolled up to read past output and selects `/status` from the slash menu, the viewport is yanked to the bottom, contradicting the deliberate-scroll-preservation philosophy of AC6.

**Suggested fix:**
Restrict the scroll-jump to the `textarea.onSubmit` handler only. In the menu handler, either leave scroll alone or only set `stickyScroll = true` without forcing `scrollTop`.

**Patch guidance (illustrative):**
```diff
   const opt = menu.getSelectedOption();
   closeMenu();
   if (opt !== null) {
-    scroll.scrollTop = scroll.scrollHeight;
-    scroll.stickyScroll = true;
     emitSubmit(opt.name);
   }
```
And keep the existing block at the textarea.onSubmit site.

**Regression coverage:**
```gherkin
Feature: menu selection preserves deliberate scroll position

  Scenario: user scrolled up, picks /status from menu
    Given the transcript is 80 lines, viewport 20, scrollTop=5
    And stickyScroll is false
    When the user selects /status from the slash menu
    Then scrollTop remains at 5
    And stickyScroll remains false (or is set true only if at bottom)
```

---

### F-006 [major] Duplicated keypress handler bodies between the two pickers

- **Severity**: major
- **Reviewer**: review-style
- **File**: `src/tui/tui-shell.ts:2237-2270` and `src/tui/tui-shell.ts:2401-2432`
- **Confidence**: high
- **Status**: open
- **AC ref**: AC3, AC4 (cleanup)

**Problem:**
The chrome-branch keypress handlers in `pickModelInTui` and `pickSessionInTui` are structurally identical ~40-line clones. They differ only in the value-extraction step (`opt.name` for model, `opt.value` + lookup for session). After F-001 removes up/down, the duplication is still substantial.

**Suggested fix:**
Extract a small factory:

```ts
// In src/tui/tui-shell.ts (top of file) or new src/tui/picker-keypress.ts
function createPickerKeypressHandler<T>(opts: {
  renderer: Renderer;
  getSelect: () => SelectRenderable | undefined;
  getFilter: () => string;
  setFilter: (next: string) => void;
  apply: () => void;
  onSelect: () => void;
  close: () => void;
}): () => void {
  // returns the unsubscribe function
}
```

Reuse from both pickers; per-picker logic is the `onSelect` body (3 lines).

---

### F-007 [major] `BACKDROP_ALPHA` JSDoc contradicts new value

- **Severity**: major
- **Reviewer**: review-style
- **File**: `src/tui/modal-host.ts:75-79`
- **Confidence**: high
- **Status**: open
- **AC ref**: AC1

**Problem:**
Value changed from `0.85` to `1.0`. The new docstring's leading sentence still says *"How much of the transcript stays visible through the backdrop, 0-1"* — frames it as a tunable alpha slider. The follow-up sentence correctly says it's opaque. The two sentences contradict each other.

**Suggested fix:**
Replace the docstring with:

```ts
/**
 * Backdrop fill alpha (0-1). Set to 1.0 so nothing bleeds through
 * modal margins (flow 269 AC1).
 */
export const BACKDROP_ALPHA = 1.0;
```

Or, if the alpha tunability is no longer needed, drop the export and keep it as a module-private `const`.

---

### F-008 [major] `panel.width` clamp can drop below `MODAL_PANEL_MIN_WIDTH`

- **Severity**: major
- **Reviewer**: review-logic
- **File**: `src/tui/modal-host.ts:593` and `src/tui/modal-host.ts:303`
- **Confidence**: medium
- **Status**: open
- **AC ref**: AC2

**Problem:**
`resolveModalPanelSize` floors width at `MODAL_PANEL_MIN_WIDTH = 72`. In `openModal` and `mountTab`, an outer `Math.min(availWidth, size.width)` removes that floor when `availWidth < 72` (transitional layout state, narrow chrome variant, or pre-flush width). Result: panel can be narrower than the documented minimum.

**Suggested fix:**
Wrap with `Math.max`:

```ts
state.panel.width = Math.max(MODAL_PANEL_MIN_WIDTH, Math.min(availWidth, size.width));
```

And in `mountTab`:
```ts
const panelWidth = Math.max(MODAL_PANEL_MIN_WIDTH, Math.min(availWidth, size.width));
```

Also: AC2 test asserts `panel.width === 86`. Confirm that 86 is the panel width or the inner width — if it's the inner, add a comment.

---

### F-009 [major] `src/tui/model-session-picker-modal.test.ts` violates 1:1 test/source convention

- **Severity**: major
- **Reviewer**: review-frontend-conventions
- **File**: `src/tui/model-session-picker-modal.test.ts`
- **Confidence**: high
- **Status**: open
- **AC ref**: AC10

**Problem:**
The file tests `pickModelInTui` / `pickSessionInTui` from `tui-shell.ts`, but no source file `model-session-picker-modal.ts` exists. Repo convention is strict 1:1 pairing (`modal-host.test.ts` ↔ `modal-host.ts`, etc.). The 2984-line `src/tui/tui-shell.test.ts` is the canonical home.

**Suggested fix:**
Either:
- (a) Move these tests into `src/tui/tui-shell.test.ts` (preferred).
- (b) Rename to `src/tui/tui-shell.pickers.test.ts` so the module under test is unambiguous.

---

### F-010 [minor] `transcript-blocks.ts` exit() fallback contradicts comment

- **File**: `src/tui/transcript-blocks.ts:1358-1364`
- **Confidence**: medium
- **AC ref**: AC6

**Problem:**
When `scrollHeight` or `height` is undefined, fallback sets `stickyScroll = true`, contradicting the comment "preserve deliberate scroll position".

**Fix:** In the undefined branch, do NOT touch `stickyScroll`.

---

### F-011 [minor] `renderCommandHelp` mixes three concerns

- **File**: `src/commands/agent-commands.ts:429-475`
- **Confidence**: medium

**Problem:** Pad + word-wrap + continuation indent in one nested loop; `formatted.length === 0 ? … : …` repeated 3 times.

**Fix:** Split into `formatCommandLine(c, width, maxColumns)` + private `wrapToBudget(line, budget)`.

---

### F-012 [minor] Magic numbers in `renderCommandHelp`

- **File**: `src/commands/agent-commands.ts:429`
- **Confidence**: high

**Fix:** Name `CMD_NAME_INDENT = 2`, `CMD_NAME_GAP = 2`, `CMD_WRAP_MIN_DESCRIPTION = 10`.

---

### F-013 [minor] Magic numbers in `resolveModalAvailableWidth`

- **File**: `src/tui/modal-host.ts:142-160`
- **Confidence**: high

**Fix:** Name `DEFAULT_SIDEBAR_WIDTH = 30`, `MIN_MODAL_AVAILABLE_WIDTH = 20`. Reuse the latter from `resolveModalInnerWidth`.

---

### F-014 [minor] Magic `3` in AC6 bottom detection

- **File**: `src/tui/transcript-blocks.ts:1354`
- **Confidence**: high

**Fix:** `const STICKY_SCROLL_BOTTOM_TOLERANCE_ROWS = 3;` near top of file.

---

### F-015 [minor] `rOrChrome` union dispatch should be overloads

- **File**: `src/tui/tui-shell.ts:2027,2126,2276,2506,3963,4073,5381,5435`
- **Confidence**: high

**Problem:** Three top-level entry points take `Renderer | ModalChrome` and dispatch via `isModalChrome` + `as Renderer` casts. Reads like a union doing overload's work.

**Fix:** Two explicit entry points (`openModelPickerInModal`, `openModelPickerOnRenderer`) or TS overloads. Private `pickModelInTuiImpl` for shared logic.

---

### F-016 [minor] `helpText` reimplements width math

- **File**: `src/tui/tui-shell.ts:3965-3968`
- **Confidence**: high

**Problem:** Re-implements `resolveModalAvailableWidth` with hard-coded `-4` / `-34` / `40` constants.

**Fix:** Reuse the helper:
```ts
const avail = Math.max(40, resolveModalAvailableWidth(chrome) - MODAL_PANEL_CHROME_X);
return renderCommandHelp("agent", undefined, avail);
```

---

### F-017 [minor] `Box` type cast for `width` in `resolveModalAvailableWidth`

- **File**: `src/tui/modal-host.ts:140-152`
- **Confidence**: medium

**Fix:** Add a comment explaining that `Box = InstanceType<...>` doesn't formally expose `width`, and the cast is defensive because `modal-host.ts` is the optional-dep boundary.

---

### F-018 [minor] `isModalChrome` is structural `in`-check only

- **File**: `src/tui/tui-shell.ts:2029-2034`
- **Confidence**: medium

**Problem:** File-local; blast-radius bounded. Safe in practice because no `Renderer` carries `focusComposer`. Hardening:
```ts
function isModalChrome(target: unknown): target is ModalChrome {
  return (
    target !== null &&
    typeof target === "object" &&
    "renderer" in target &&
    "focusComposer" in target &&
    typeof (target as { focusComposer?: unknown }).focusComposer === "function"
  );
}
```

---

### F-019 [minor] `OpenModalInput` duplicated in `review-inspector.ts`

- **File**: `src/tui/review-inspector.ts:36-45`
- **Confidence**: high
- **Status**: pre-existing (also in 8 other inspectors). PR adds `contentRows?` in both. Not in scope for remediation.

---

### F-020 [minor] `modal-host.ts` header docstring drift

- **File**: `src/tui/modal-host.ts:1-12`
- **Confidence**: high

**Fix:** Update header after deciding F-002.

---

### F-021 [minor] `HostState.savedScrollTop` is dead state

- **File**: `src/tui/modal-host.ts:151,281,426,556`
- **Confidence**: high

**Fix:** Remove or document as placeholder for future scroll-on-modal-open behaviour.

---

### F-022 [minor] AC1 test name says "translucent"

- **File**: `src/tui/modal-host.test.ts:203`
- **Confidence**: high

**Fix:** Rename to *"…panel over an OPAQUE backdrop masking underlying transcript text"*.

---

### F-023 [minor] AC8 inspects input contract, not rendered frame

- **File**: `src/tui/review-inspector.test.ts:467-489`
- **Confidence**: high

**Fix:** Convert AC8 to `otuiTest` that calls `captureCharFrame()` and asserts panel.height + footer rendering.

---

### F-024 [info] `scroll.scrollTop = scroll.scrollHeight` relies on runtime clamp

- **File**: `src/tui/shell-chrome.ts:1055,1059`
- **Confidence**: low

**Suggestion:** Use `scroll.scrollTop = Math.max(0, scroll.scrollHeight - (scroll.height ?? 0))` for spec precision.

---

### F-025 [info] `BACKDROP_ALPHA` exported without deprecation annotation

- **File**: `src/tui/modal-host.ts:78`
- **Confidence**: medium

**Suggestion:** Either drop the export (value is now an implementation detail) or annotate the new binary nature in the JSDoc (covered by F-007).

---

### F-026 [info] AC6 tests use plain object, not real `ScrollBox`

- **File**: `src/tui/transcript-blocks.test.ts:439-491`
- **Confidence**: high

**Note:** Both branches of `atBottom` are covered; this is acceptable. Optional: add an integration `otuiTest` that wires a real `ScrollBox` and verifies scrollTop survives a navigate-then-scroll-then-exit round trip.

---

### F-027 [info] Optional-dependency rule preserved

- **File**: `src/tui/modal-host.ts:13-17`, `src/tui/tui-shell.ts:2096`
- **Confidence**: high

**Note:** Only `typeof import("@opentui/core")` structural references; all `otui.*` access through runtime `otui` parameter. No top-level import introduced.

---

### F-028 [info] Dependency direction preserved

- **File**: `src/tui/tui-shell.ts:106,2096`; `src/tui/modal-host.ts:13-15`
- **Confidence**: high

**Note:** `tui-shell → modal-host`. `modal-host` does not import `tui-shell`. No circular references.

---

### F-029 [info] `pickXInTui` widening is backwards-compatible

- **File**: `src/tui/tui-shell.ts:1995-2034`, call sites `src/tui/chat-shell.ts:623,642,649,653`; tests `provider-endpoint-retry.test.ts:145,194,239`, `model-picker-notice.test.ts:90,104,117,151`.
- **Confidence**: high

**Note:** All external callers pass `Renderer`, the first type of the union. No breaks. `chat-shell.ts` is a missed opportunity (chrome available) but not a regression.

---

### F-030 [info] Styling convention: `otui.dim` / `otui.red` / `otui.t`

- **File**: `src/tui/tui-shell.ts:2167,2186,2190,2336,2352`
- **Confidence**: high

**Note:** No chalk bypass. Theme-aware rendering preserved.

---

## Fix Order

Apply in this sequence — each step is a prerequisite for the next:

1. **F-002 (blocker)** — backdrop layering fix. Decide option (a) [keep backdrop on r.root, only clamp panel] or (b) [accept sidebar-visible, update AC + docstrings].
2. **F-001 (blocker)** — remove manual up/down branches in both pickers' onKey.
3. **F-008 (major)** — wrap `panel.width` clamp with `Math.max(MODAL_PANEL_MIN_WIDTH, …)`.
4. **F-007 (major)** — reword `BACKDROP_ALPHA` JSDoc; consider removing the export.
5. **F-003 (major)** — extend AC3 test to exercise arrow navigation.
6. **F-004 (major)** — strengthen AC5 scroll assertion to exact equality.
7. **F-005 (major)** — restrict scroll-jump to `textarea.onSubmit` only; remove from `menu.on(ITEM_SELECTED)`.
8. **F-006 (major)** — extract `createPickerKeypressHandler` and dedupe.
9. **F-009 (major)** — relocate AC3/AC4 tests into `tui-shell.test.ts` (or rename file).
10. **F-022–F-023 (minor)** — rename AC1 test, convert AC8 to `otuiTest`.
11. **F-010–F-018 (minor)** — magic numbers, organization, naming, structural hardening.
12. **F-019–F-021 (minor)** — dead code, docstring drift, type-extension duplication.
13. **F-024–F-030 (info)** — opportunistic cleanups.

## Validation Plan

After applying the blocker + major fixes, run:

1. **Unit tests**: `bun test src/tui` — should remain at 725/725 passing (per AC10 PR description).
2. **Targeted tests**:
   - `bun test src/tui/modal-host.test.ts` — covers AC1, AC2, AC7.
   - `bun test src/tui/model-session-picker-modal.test.ts` (or `tui-shell.test.ts` after relocation) — covers AC3, AC4.
   - `bun test src/tui/transcript-blocks.test.ts` — covers AC6.
   - `bun test src/tui/review-inspector.test.ts` — covers AC8.
   - `bun test src/commands/agent-commands.test.ts` — covers AC9.
   - `bun test src/tui/shell-chrome.test.ts` — covers AC5.
3. **Manual / PTY verification (per AC10)**: re-run the 120x40 headless tmux session and confirm:
   - `/model` arrow navigation steps one row per arrow press, wraps correctly.
   - `/sessions` same.
   - Modal opening: sidebar borders NOT visible through backdrop (option a) OR sidebar intentionally visible (option b).
   - Submitting composer scrolls to the bottom; selecting from menu does not jump.
4. **Type check**: `bun run --bun tsc --noEmit` (or repo's standard typecheck command).
5. **Lint**: `bun run lint` if present.

## Notes For Follow-Up Agents

- **Apply F-001 first within each picker**. Both `pickModelInTui` (chrome branch starts around line 2183 of diff) and `pickSessionInTui` (chrome branch starts around line 2348) have the same handler structure. After removing up/down, the `wrapSelection: true` test in AC3 should also be added.
- **The `chrome.main ?? r.root` mount** in `modal-host.ts:448` is the easiest fix-point: change to `r.root.add(backdrop);` and keep the `panel.width = Math.max(MODAL_PANEL_MIN_WIDTH, Math.min(availWidth, size.width))` clamp at `openModal`/`mountTab`. This restores AC1's full-coverage intent and AC2's width-clamp goal without losing either.
- **`renderCommandHelp`** is invoked from two sites in `tui-shell.ts` (`launchTuiAgentShell` around line 3963 and pre-existing calls). The new `maxColumns?` parameter is optional, so pre-existing callers stay valid.
- **Modal-host `ModalChrome` extension** (`main?: Box; sidebar?: Box`) is additive and stays compatible with existing callers that don't carry those fields.
- **`transcript-blocks.ts` `NavScroll.scrollHeight`** is optional; pre-existing implementations that don't carry it fall into the `stickyScroll = true` branch (which F-010 fixes).
- **`review-inspector.ts`'s local `OpenModalInput`** is a pre-existing duplication (also in `flow-inspector.ts`, `external-inspector.ts`, `workspace-inspector.ts`, `subagent-inspector.ts`, `background-job-inspector.ts`, `mcp-inspector.ts`, `session-info.ts`). Refactoring is out of scope for this PR; if you touch any of those files, keep the parallel `contentRows?` extension in sync.
- **Convention drift fix F-009** is also a chance to merge with `tui-shell.test.ts` — but that file is 2984 lines, so consider a focused PR just for the relocation to keep this remediation PR reviewable.
- **No secrets or PII** in the diff. No production code paths outside `src/tui/` and `src/commands/agent-commands.ts`. No new npm dependencies. Graph artifacts (`.provenance.json`, `module-map.json`, `summary.md`) are out-of-band but consistent with the existing graph state.
