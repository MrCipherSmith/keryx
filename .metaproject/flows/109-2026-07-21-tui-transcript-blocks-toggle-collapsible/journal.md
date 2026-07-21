# Flow Journal

- 2026-07-21T16:25:49.265Z - flow created
- 2026-07-21T16:36:20.839Z - task-added: T5: Headless TUI tests + readline parity + verify/review/docs
- 2026-07-21T16:36:20.925Z - frozen: 14 criteria; checksum recorded
- 2026-07-21T16:36:21.007Z - started
- 2026-07-21T16:36:25.880Z - task-done: T1: Collect remaining context
- 2026-07-21T16:43:18.612Z - task-done: T2: Implement per plan
- 2026-07-21T16:49:27.318Z - task-done: T3: Add/adjust tests and make them pass

## Notes

### Branch reset (before T3)
While T2 ran, PR #180 (`fix(agent): raise interactive tool budget`) was merged
into `main` (`65d6558`) by a concurrent session, which also carried away the
uncommitted `resolveAgentMaxToolCalls` changes seen at flow start. The stale
`feat/tui-transcript-blocks` (at `e99b7f4`) was deleted and re-cut from
`main@65d6558`. The untracked T2 test files carried over unchanged.

### T2 (tests-creator) — DONE_WITH_CONCERNS
RED tests written: `src/lib/md-blocks.test.ts` (36 cases),
`src/tui/transcript-blocks.test.ts` (19 cases). Concern raised: the stale-branch
premise above — resolved by the branch reset. API surface pinned by the tests is
binding on T3/T4; notably `EVICTED_BLOCK_TEXT = "(output no longer retained)"`,
`retained: boolean` + `fullText === undefined` as the eviction shape, `bodyText(id)`
as the accessor, first-registration-takes-focus, and clamping (non-wrapping)
`focusNext`/`focusPrev`. The registry has no `focus(id)` yet — T4 must add one
for "nav mode focuses the newest block".

### T3 (task-implementer) — DONE
Created `src/lib/md-blocks.ts` (pure, zero imports; AC9 proven by
`keryx ctx rg "@opentui" --glob "src/lib/**"` → 0 matches). Extended
`src/lib/ui.ts` with `renderDiff` (green `+` / red `-` / cyan `@@` / dim
`---`+`+++`, identity when color is disabled) and made `renderMarkdown`
fence-aware via `segmentMarkdown`. `collapseToolOutput` / `summarizeToolArgs`
untouched.

`src/lib/ui.test.ts` changes were **additive only** — no assertion was
invalidated. The T3 dispatch predicted that `ui.test.ts:90-96` pinned "language
discarded", but its fixture is an *unlabelled* fence, so the new tag path is not
entered and output is byte-identical. Six new tests were added instead
(language tag, `~~~` fence, diff fence colorization, AC7 bullet-list negative,
`renderDiff` NO_COLOR identity, `renderDiff` FORCE_COLOR classes).

Results: `bun test src/lib/md-blocks.test.ts src/lib/ui.test.ts` → 63 pass / 0
fail. Regression sweep `bun test src/lib src/capability src/commands` → 310 pass
/ 3 skip / 0 fail. `tsc --noEmit` → 5 errors, all in
`src/tui/transcript-blocks.test.ts` (expected RED, T4 scope).

**Concern carried to T4 (accepted, not dropped):** fence detection is now
anchored at column 0 (`startsWith("```"|"~~~")`), whereas the old inline loop
used `/^\s*```/`. An **indented** fence — e.g. a code block nested in a list
item — now renders as literal prose. Decision: T4 relaxes both `segmentMarkdown`
and the TUI segmenter to CommonMark's `^\s{0,3}` and adds a covering test. This
does not conflict with the T2 pin (its negative case is a *mid-line* backtick
run, not an indented fence).

**skill_drift (T3):** `.metaproject/rules/core/code-style-patterns.mdc` and
`error-handling.mdc` are imported React/MobX frontend rules with nothing
applicable to this Bun CLI repo. Flagged for the skill-learning loop in T5.

### T4 (task-implementer) — DONE_WITH_CONCERNS

The first T4 dispatch was interrupted mid-run but had already written a
substantially complete implementation to the working tree. The re-dispatched
worker **verified rather than rewrote** it against the RED tests, plan L3/L4,
decisions D-1..D-5 and risks R1..R6, then fixed a blocker and two inaccurate
comments. **Consequence: most of this code was not authored by the worker that
signed off on it — the T5 `review-orchestrator` pass carries more weight than
usual here. Recorded, not dropped.**

Delivered:
- `src/tui/transcript-blocks.ts` (new, ~653 L): `createBlockRegistry` (pure) +
  `focus(id)` as required + `createStreamSegmenter` + `markdownToChunks` /
  `payloadChunks` / `createSegmentView` / `createBlockView`. `otui` is a
  parameter everywhere; `@opentui/core` reached only via
  `type OpenTui = typeof import(...)`.
- `src/tui/tui-shell.ts`: segmented rendering, registry routing for reasoning /
  tool call / tool result, nav mode, scroll restore.
- `src/commands/agent-commands.ts` (+ test): `/expand` and `/copy` registered;
  test expectations extended additively.
- `src/lib/md-blocks.ts`: carried T3 concern resolved —
  `FENCE_LINE = /^[ \t]{0,3}(```|~~~)(.*)$/` exposed as a shared `fenceInfo()`.
  The T2 mid-line-backtick negative case still passes.

Mechanics:
- **R1 streaming:** `createStreamSegmenter` is line-oriented and incremental;
  a segment is pushed to `frozen[]` the moment its closing fence arrives and is
  never revisited. A token costs one trailing-segment repaint.
- **R3 focus:** a single `focusOwner: "composer" | "blocks"` guard; both
  turn-end refocus sites route through `focusComposer()`, which no-ops while
  nav mode owns focus.
- **AC12 scroll:** `setBlockCollapsed` snapshots `scroll.scrollTop` before
  toggling, disables `stickyScroll` for non-newest blocks, restores the offset
  and re-asserts it after layout.
- **AC4 conflicts:** one handler through the existing `onKeypress` wrapper (the
  private `_internalKeyInput` symbol is untouched by new code), with an early
  return on `(menu.visible && menuNav) || overlayDepth > 0 ||
  choiceDock.visible || pendingApproval !== undefined`.
- Keys: `Ctrl+O` enter · `↑`/`↓` move · `Enter`/`Space` toggle · `y` copy ·
  `Esc` exit. Outside nav mode only `Ctrl+O` is consumed.

**Blocker found and fixed (pre-existing, unrelated to this flow):**
`loadOpenTui()` in `src/tui/tui-shell.test.ts` loaded `@opentui/core` and
`@opentui/core/testing` via `Promise.all`, which trips a module-cycle race in
the dependency (`ReferenceError: Cannot access 'Renderable'/'TestWriteStream'
before initialization`). Reproduced with a zero-keryx-code probe. Fixed by
sequential `await import(...)`; 5 previously failing `src/tui` tests now pass.
This would have made T5 impossible. **T5 must not revert this.**

Judgement calls beyond the frozen pins (accepted):
- `enforceBounds` refuses to evict the *newest* retained block, so a single
  oversized payload is not dropped on arrival. Invisible to every pinned test.
- No scroll-into-view on `↑`/`↓` — `createBlockView` does not expose its box.
  Deferred and documented in the `moveNavFocus` doc comment.
- `/copy` is TUI-only; readline `/expand` still uses its own `lastToolOutput`
  path. Sharing the label helper remains AC10 / T5 work.

Results: `bun test src/tui/transcript-blocks.test.ts src/lib/md-blocks.test.ts
src/lib/ui.test.ts` → 84 pass / 0 fail. Sweep `bun test src/tui src/lib
src/commands` → 326 pass / 3 skip / 0 fail. `bun run typecheck` → clean.
AC9 proof: `CodeRenderable|DiffRenderable|MarkdownRenderable|TreeSitterClient`
→ 4 matches, all comments; `@opentui` under `src/lib/**` → 0 matches.

**skill_drift (T4):** confirms T3's finding on the imported frontend rules, and
adds: `tdd-workflow.mdc` assumes the implementer authors the failing test and
has no guidance for an implementer inheriting a *partially complete*
implementation against pre-written RED tests. The verify-don't-rewrite decision
was unguided.

### T5 attempt 1 — BLOCKED, working tree lost (second incident)

A concurrent session stashed the entire flow-109 working tree
(`stash@{0}: On feat/tui-transcript-blocks: wip-tui-transcript`) and checked out
`fix/shell-allow-pattern-multiline` mid-task. The flow package itself vanished
from disk, so `keryx flow` could not see flow 109. The worker correctly refused
to pop a stash onto a foreign branch carrying another session's in-flight edits,
reported the recovery sequence, and **declined to report verification numbers it
had not earned**. Good judgement — recorded as such.

Recovery by the orchestrator: `git checkout feat/tui-transcript-blocks` →
`git merge --ff-only main` (picking up PR #181, `44818a6`) → `git stash pop`.
Conflict-free; the stash touched no file PR #181 changed. Re-verified:
`bun test src/tui src/lib src/commands` → **327 pass / 3 skip / 0 fail**.

**Root cause of both incidents: T1-T4 output was passed between workers as an
uncommitted working tree in a repo with concurrent sessions.** Fixed by
committing immediately on restore — `83d0cdc feat(tui): per-block collapse,
framed markdown payloads, code/diff rendering` (T1-T4, rebased on
`main@44818a6`). Every subsequent task boundary must also commit.

**skill_drift (T5a), accepted:** the flow-orchestrator dispatch protocol pins a
branch and has the worker verify it once at the hard gate. That is insufficient
under concurrent sessions — this worker's branch check passed and the branch was
gone ~90 seconds later. Proposed rules: (a) workers re-assert
`git branch --show-current` immediately before their first *write*, not only at
the gate; (b) orchestrators commit at every task boundary rather than handing an
uncommitted tree to the next worker.

### Findings carried into T5 attempt 2

The blocked worker finished reading the implementation before it vanished:

1. **AC3 / AC4 / AC12 are not reachable from the headless harness as
   structured.** The whole nav mode — `enterNavMode`, `exitNavMode`,
   `moveNavFocus`, the `onKeypress` dispatch with the
   `(menu.visible && menuNav) || overlayActive()` guard, `setBlockCollapsed`'s
   sticky-scroll suspend/restore, and the `focusOwner` guard — lives inside the
   `launchTuiAgentShell` closure (`tui-shell.ts:2280-2364`, `:860-947`), which
   no test invokes. `onKeypress` (`:373`) is module-private. A headless test
   could only re-implement that wiring, i.e. be tautological.
   **Orchestrator decision: approve the enabling refactor** — extract the nav
   controller into `src/tui/transcript-blocks.ts` so a headless test can mount
   real block views and drive real keys. AC3 demands a genuine
   `createTestRenderer` + `mockInput.pressKeys` drive-through, so a pure
   key-mapping unit test alone does not discharge it.
2. **AC7 colors are assertable**: `createTestRenderer` also returns
   `captureSpans(): CapturedFrame` whose `CapturedSpan` carries `fg: RGBA`.
   Diff line classes can be proven by comparing span foreground colors rather
   than settling for a substring check.
3. The load-bearing `loadOpenTui()` sequential-import fix is now committed.
- 2026-07-21T17:10:50.638Z - task-done: T4: Self-review and prepare draft PR
