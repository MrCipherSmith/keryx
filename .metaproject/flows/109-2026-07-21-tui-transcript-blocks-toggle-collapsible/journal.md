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

## T5 — headless TUI tests, readline parity, docs (attempt 3)

Ran in an isolated worktree (`.claude/worktrees/keryx-flow-109`), which is what
finally let this task finish: attempts 1 and 2 were killed by concurrent sessions
switching branches in the main checkout, and a worktree is out of reach of a
`git checkout` there.

Attempt 2's 450 lines of tests were still sitting uncommitted in the worktree.
They were kept, not rewritten — 14 of their 17 assertions were already correct.
Three failed, and both root causes turned out to be harness/upstream facts rather
than product bugs.

### The two harness facts

**A lone `Esc` is invisible to `flush()`.** OpenTUI's stdin parser holds a bare
`\x1b` in its pending buffer for `DEFAULT_TIMEOUT_MS` (20ms on the real clock,
`reconcileTimeoutState` in the vendored `chunk-*.js`) so it can tell a bare Esc
apart from the start of an escape *sequence*. `flush()` only awaits a render
frame, never wall time, so `pressEscape()` + `flush()` observed nothing at all
and both AC3 and AC4 failed at their Esc step. Probed directly: immediately after
`pressEscape()` the handler had seen `[]`; after a 200ms sleep it had seen
`{name:"escape"}`. Fixed with `pressEscapeAndSettle`, which waits the timeout out.
Real terminals pay the identical 20ms, so nothing about the product changed.

**AC11's 40x8 failure is an upstream ScrollBox clipping defect.** At exactly
`scrollTop === 2`, a bordered child inside a `ScrollBoxRenderable` paints its
bottom border one row past the viewport clip, over the composer's interior row —
`│─draft─prompt─────╯`, which is why the `includes("draft prompt")` assertion
failed while the composer was plainly still on screen. Narrowed with four probes:

- it reproduces from **pure OpenTUI primitives with zero flow-109 code**;
- it is a pure function of the offset — a sweep over 0/1/2/3 (via header-line
  count) bleeds at 2 and is clean at 0, 1 and 3, at four different terminal sizes;
- `overflow: "hidden"` on the scrollbox, its content, the child and the column
  parent all fail to suppress it;
- `markNeedsRerender` / `requestRender` / `needsUpdate` / extra flushes all fail
  to suppress it, and setting `scrollTop = 0` then back to `2` reproduces it
  exactly — so it is live overdraw, not a stale-paint artifact.

Keryx cannot fix this from the outside without dropping the frame border that
AC5/AC7 require. Rather than weaken AC11 into something vacuous, it was split:
the AC11 test now asserts the guarantee AC11 actually makes — that a 120-line
expanded block never pushes the chrome off-screen, checked structurally (footer
is the last row, the composer's rounded box occupies the three rows directly
above it, the draft survives in `textarea.plainText`) at four sizes — and the
defect is pinned by its own test that asserts `scrollTop === 2` bleeds and 0/1/3
do not. That test **fails when upstream fixes the bug**, at which point it and the
`scrollTop !== 2` carve-out in AC11 should both be deleted. Recorded in
specification §7.1.

### Readline parity (AC10)

`/expand` lived inside the non-exported `runAgentRepl` closure and had already
drifted from the TUI: a hand-rolled `<tool> output:` header and a flatly dimmed
body that rendered diffs in monochrome. Lifted the pure formatting into an
exported `expandedToolOutput(name, output, maxLines)` pointed at the same
`src/lib` helpers the TUI uses — `blockLabel` for the header, `renderDiff` for a
body that `looksLikeUnifiedDiff` recognizes. Eight tests, including the AC7
negative (a `- ` bullet list must not colorize as deletions) and a NO_COLOR case.
Cap, truncation notice, gutter and the "Nothing to expand" path are unchanged;
the header's line count is taken after trailing newlines are trimmed so it
matches what is actually shown.

### Docs (AC14)

- §3: the stale `tool →` bullet claiming inline expand "replac[es] the
  line-based `/expand`" now describes the delivered behavior — per-block
  collapse, the full key table (`Ctrl+O` / `↑↓` / `Enter`·`Space` / `y` / `Esc`),
  and the fact that `/expand` and `/copy` both survive in both shells.
- §7.1 (new): the three load-bearing headless-harness facts — the sequential
  `@opentui/core` + `/testing` import (a `Promise.all` trips the
  `core-slot.ts` → `Renderable` module cycle), the 20ms Esc timeout, and the
  ScrollBox border bleed.
- §9 Decisions (new): **D-2** records why `CodeRenderable`/`DiffRenderable`/
  `MarkdownRenderable` were rejected. Verified against the vendored package
  before writing it down rather than restating the dispatch: `new Worker(workerPath)`
  → `parser.worker.js`, whose grammar loader branches on
  `source.startsWith("http://")` and `await fetch(source)`es a URL, and exactly
  five grammars ship bundled (`javascript`, `markdown`, `markdown_inline`,
  `typescript`, `zig`). Revisit condition: offline grammar bundling with no URL
  path in the loader, plus a worker-free or headless-reachable highlighter.
  D-3 (mode over bare keys) and D-5 (sticky-scroll suspend) recorded alongside.

### Deliberately not done

- `review-orchestrator` (named in the T5 task body, not in any AC this worker
  owns) was not run — left to the orchestrator's completion gate under AC13.
- The wiki page refresh mentioned in the T5 task body was not done; AC14 scopes
  the docs requirement to the specification, which is updated.

**skill_drift:** none beyond the T5a entry above, whose recommendation (a) the
isolated worktree fully addresses and (b) this run followed — three commits, one
per deliverable.

### T5 verification — health gate is WARN, and it is pre-existing

`keryx health run` reports **gate WARN, project score 92**, on the single reason
`health regression 3 vs baseline`. The T5 dispatch recorded the baseline as
`pass`, so this was investigated rather than waved through.

It is not attributable to flow 109, let alone T5:

- The baseline being compared against is `.metaproject/health/baselines/scores.json`,
  `generatedAt` **2026-07-06**, committed in `fd43d35` (the repo's initial
  `keryx 0.1.0` commit) with project `health_score: 95`. It has never been
  re-recorded, so every flow since is measured against a two-week-old number.
- The WARN is long-standing: flow 001's verification report
  (`.metaproject/flows/001-2026-07-09-managed-review-feedback-loop/verification-report.md`)
  already records `gate: WARN`, `reason: existing health regression 5 vs
  baseline`. The current regression of **3 is smaller than the 5** recorded
  there — the trend since is an improvement, not a decline.
- There are **zero P0 and zero P1 findings**. All 108 findings are P2
  cyclomatic-complexity warnings.
- A changed-scope run (`keryx health run --changed --since b2c25e6`) attributes
  no new finding to T5. The only two findings touching flow-109 production files
  are pre-existing complexity warnings on `src/commands/shell.ts` and
  `src/tui/tui-shell.ts`, both of which exceeded the threshold before this flow.
- T5's entire production delta is one new ~20-line pure function
  (`expandedToolOutput`, cyclomatic ≈5, well under the threshold of 10) that
  *removed* inline branching from `runAgentRepl`. Everything else T5 touched is
  test files and markdown, which are not scored for complexity.

A direct A/B (running health against the base commit's file contents) was
attempted and blocked by the sandbox's command classifier, so this rests on the
changed-scope run and the historical record rather than a re-measured `pass`.
**Nothing in this flow was found to move the gate**, but the "baseline: pass"
premise in the dispatch could not be reproduced and looks stale. Refreshing
`.metaproject/health/baselines/scores.json` is a separate call for the
orchestrator, not something a task worker should do silently.
- 2026-07-21T18:10:23.997Z - task-added: T6: Fix review findings: CRLF fence regression, unbounded maxRetainedChars, AC1 wiring tautology
- 2026-07-21T18:10:52.291Z - task-done: T5: Headless TUI tests + readline parity + verify/review/docs
- 2026-07-21T18:26:03.480Z - task-done: T6: Fix review findings: CRLF fence regression, unbounded maxRetainedChars, AC1 wiring tautology

### Review pass (AC13) — findings and dispositions

A read-only `review-orchestrator` pass ran over `main...HEAD` in the worktree,
with the T4 caveat made explicit in the dispatch: the bulk of
`src/tui/transcript-blocks.ts` and the `tui-shell.ts` wiring was written by an
interrupted worker and only *verified* by the one that signed off, so it was
reviewed as unreviewed code. Every disposition below is recorded, none dropped.

| # | Sev | Finding | Disposition |
|---|---|---|---|
| F1 | HIGH | `FENCE_LINE` never matched a CRLF line (`\r` is a JS line terminator, so `.`/`$` skip it). `segmentMarkdown("a\r\n```ts\r\nx\r\n```\r\nb")` returned one text segment — raw fences as prose, no language tag, no diff colors. A **regression** against the `/^\s*```/` it replaced; hit any Windows/CRLF payload. | **Fixed** (`d523e8e`): regex tolerates `\r`, plus `stripTrailingCr`/`splitLines` applied through `segmentMarkdown`, `looksLikeUnifiedDiff`, `ui.ts` and the TUI chunkers. Covered by a CR/LF/tab acceptance table (10 cases) + CRLF cases in `ui.test.ts`. |
| F2 | MED | `enforceBounds` exempted the newest block, so `maxRetainedChars` was not a bound: a 5 MB payload against a 10-char cap was retained in full for the process lifetime. AC8's char-cap test only used 8-char payloads. | **Fixed** (`7ca9421`): clip-on-register — an oversized payload retains a prefix up to the cap and is marked `truncated`, so the user still sees its head. New `retainedChars()`; 4 tests incl. a 5,000-char payload against a 100-char cap. Plan **D-4 amended** to the new semantics. |
| F3 | MED | AC1's proof was a replica: the exported `createTuiAgentIo` still discarded full text, retention lived only in the untested closure, and the test drove a hand-written `mountBlockHarness.add` mirroring `addBlock`. A regression in the real wiring would have failed nothing. | **Fixed** (`7ca9421`): `attachBlockIo(io, addBlock)` exported + `createBlockMount`; a headless test drives `runAgentTurn` through the real IO and asserts `registry.bodyText(id)` equals the tool's full output. Replica retired. |
| F4 | MED | `createStreamSegmenter` — the whole streaming path and R1's mitigation — had zero direct tests; the plan's "assert with a token-count test" was never done. | **Fixed** (`7ca9421`): 9 tests — mid-marker chunk split, char-by-char parity with `segmentMarkdown`, frozen monotonicity asserted by **reference identity** per token, `reset()` incl. an unclosed fence, CRLF parity, and the trailing-partial divergence deliberately kept and pinned. |
| F5 | LOW | `bodyText(unknownId)` returned the eviction marker (indistinguishable from a real eviction), and `copy()` of an evicted block copied the marker while toasting a false `"Copied to clipboard"`. | **Fixed** (`7ca9421`): `UNKNOWN_BLOCK_TEXT` added, copy refuses and toasts truthfully. One pre-existing assertion changed — see below. |
| F6-F9 | LOW | Two `tui-shell.ts` comments claimed rendering via the native `MarkdownRenderable` (which D-2 rejects and the code never did); a `shell.ts` comment overstated readline/TUI header parity (readline passes the tool name as `kind`, the TUI passes `"output"`); spec §3 claimed `/copy` takes the newest *markdown-payload* block, but assistant markdown is never registered as a block; `/copy`'s `navMode()` branch was unreachable. | **All fixed** (`7ca9421`). |

**Assertion changed under review authority (the only one):**
`transcript-blocks.test.ts:220`, `bodyText of an unknown id is the evicted
marker` → `bodyText distinguishes an unknown id from an evicted block`
(`EVICTED_BLOCK_TEXT` → `UNKNOWN_BLOCK_TEXT`, plus new assertions that a genuine
eviction still returns `EVICTED_BLOCK_TEXT` and the two constants differ). The
old pin encoded the F5 defect; it was written before the behavior was understood
to be wrong. No other assertion was weakened or removed.

**Accepted as-is, with reasons:**
- **AC11's carve-out** — the reviewer independently re-derived that the pin is
  built from pure OpenTUI primitives with zero flow-109 code, sweeps offsets 0-3,
  and fails loudly when upstream fixes the bug. Honest and correctly scoped.
- **Health gate WARN** — the T5 investigation above stands: stale 2026-07-06
  baseline, zero P0/P1, regression of 3 vs. the 5 already recorded in flow 001,
  and a changed-scope run attributes nothing to this flow. Refreshing
  `.metaproject/health/baselines/scores.json` is a separate decision.

**Deferred, deliberately (open follow-up):**
- **Paint performance** — `render()` unconditionally rebuilds every expanded
  block body on every `↑`/`↓` (`paintAll` → up to 200 lines re-parsed per
  expanded block per keystroke), and `Enter` paints twice. Real, but a
  rework in the same pass as the correctness fixes would have muddied both.
  **Fixed after the flow closed** (`98c5023`, same PR): `showBody` repaints a
  body only when `collapsed` or the body text actually changed (same text → no
  work at all, changed text → a content swap on the mounted renderable, a new
  frame only on the collapsed → expanded edge) and body ids no longer churn;
  `moveFocus` repaints just the two blocks whose focus state changed; `Enter`
  no longer paints a second time. Pinned by two tests driving the real renderer
  with an instrumented core that counts renderable construction and diff
  colouring — both fail against the previous implementation.
- **`collapseToolOutput` does not normalize CRLF** — a CRLF tool result's
  one-line readline summary can carry a stray `\r`. Outside F1's fence scope,
  unpinned by any test; flagged rather than widening the diff.

**Verification after T6:** `bun test` (full) → **2012 pass / 11 skip / 0 fail**
across 231 files (+40 tests, same skips). `bun test src/tui src/lib
src/commands` → 382 pass / 3 skip / 0 fail. `bun run typecheck` → clean.
AC9 re-proven: `@opentui` under `src/lib/**` → 0 matches;
`CodeRenderable|DiffRenderable|MarkdownRenderable|TreeSitterClient` under
`src/**` → 4 matches, all comments; `package.json`/`bun.lock` diff empty.

### Skill learning (from the review)

Two reusable rules, both earned the hard way in this flow:
1. **A test that mirrors the wiring is not a test of the wiring.** T5 extracted
   `createBlockNavController` precisely so nav mode could be driven for real,
   then registered a hand-written `add()` duplicating the closure's `addBlock` —
   reintroducing the same tautology one layer up. When an AC says "prove X after
   render", the test must enter through the function the product enters through;
   if it cannot, that function is the next extraction, not a place for a replica.
2. **When replacing a permissive regex with a spec-correct one, enumerate what
   the old one accepted.** `/^\s*```/` → `/^[ \t]{0,3}(```|~~~)(.*)$/` fixed the
   indented-fence case the journal was tracking and silently lost `\r`, because
   `\s` includes `\r` while `[ \t]`, `.` and `$` do not. A CR/LF/tab table in the
   test file would have caught it on the first run.

### Orchestration lesson (three lost working trees)

This flow lost its working tree twice and had a task killed a third time, all
from the same cause: **flow-orchestrator hands an uncommitted working tree from
one worker to the next, in a repo where the user runs several agent sessions
against a single checkout.** Branch pinning at the hard gate does not survive a
concurrent `git checkout`. What worked, in order of effectiveness:
1. **Run long tasks in a dedicated git worktree.** A `git checkout` in the main
   tree cannot reach it. T5 attempt 3 and T6 both completed without incident.
2. **Commit at every task boundary**, not just at flow end.
3. **Re-assert `git branch --show-current` immediately before the first write**,
   not only at the gate — this caught attempt 2 before it committed onto a
   foreign branch.
4. A scratchpad `git diff` backup costs one command and saved attempt 2's work.

Also, twice in this flow a `keryx flow ...` / `git restore` was aimed at the
wrong tree because the shell cwd had moved into the worktree. Flow-state commands
must be run with an explicit, verified cwd.
- 2026-07-21T18:29:43.393Z - implemented: draft PR: https://github.com/MrCipherSmith/keryx/pull/185
- 2026-07-21T18:30:02.674Z - ac-confirmed: AC1: attachBlockIo (tui-shell.ts) makes the real IO wiring reachable; test 'AC1: the REAL io wiring retains a tool result full output' drives runAgentTurn through createTuiAgentIo + attachBlockIo and asserts registry.bodyText(id) equals the tool output. The mountBlockHarness replica was retired in 7ca9421.
- 2026-07-21T18:30:02.745Z - ac-confirmed: AC2: createBlockRegistry.toggle is per block: transcript-blocks.test.ts registers 3 blocks, toggles the middle one, asserts the others unchanged. Markers pinned by blockLabel tests in md-blocks.test.ts and asserted in a captured frame in tui-shell.test.ts.
- 2026-07-21T18:30:02.812Z - ac-confirmed: AC3: tui-shell.test.ts drive-through via real createTestRenderer + mockInput through the real onKeypress: Ctrl+O enters, arrows move, Enter expands (body visible, marker flips), Esc exits and the composer regains focus. Frame-level assertions, not state-only.
- 2026-07-21T18:30:02.876Z - ac-confirmed: AC4: tui-shell.test.ts asserts the frame is byte-identical while isBlocked() is true (menu/overlay), and that a turn completing mid-nav does not steal focus (focusOwner guard, focusComposer no-ops).
- 2026-07-21T18:30:02.946Z - ac-confirmed: AC5: Assistant markdown is segmented via segmentMarkdown; a fenced segment renders framed with a language tag and line count. Test asserts 'ts - 2 lines' in the captured frame and no backticks, driven through runAgentTurn.
- 2026-07-21T18:30:03.014Z - ac-confirmed: AC6: y copies the focused block bodyText via copyToClipboardOSC52 with the Copied to clipboard toast; copy refuses and toasts truthfully for evicted/unknown blocks (F5 fix). /expand and /copy registered in src/commands/agent-commands.ts.
- 2026-07-21T18:30:18.978Z - ac-confirmed: AC7: Diff line classes asserted on captureSpans() foreground RGBA toInts(), not substrings, for a diff fence; the '- ' bullet-list negative is proven both in md-blocks.test.ts (looksLikeUnifiedDiff false) and in the TUI and readline render tests.
- 2026-07-21T18:30:19.048Z - ac-confirmed: AC8: Retention bounded by maxBlocks and maxRetainedChars; the review found the newest-block exemption made the char cap escapable, fixed in 7ca9421 by clip-on-register (prefix retained, marked truncated). Four tests incl. a 5000-char payload against a 100-char cap asserting retainedChars() <= cap. Evicted blocks keep their summary and expand to EVICTED_BLOCK_TEXT. Plan D-4 amended to the delivered semantics.
- 2026-07-21T18:30:19.114Z - ac-confirmed: AC9: package.json and bun.lock diffs are empty. keryx ctx rg CodeRenderable|DiffRenderable|MarkdownRenderable|TreeSitterClient over src/** returns 4 matches, all comments. keryx ctx rg @opentui over src/lib/** returns 0. src/lib/md-blocks.ts has zero imports. No tree-sitter worker and no render-time grammar fetch introduced.
- 2026-07-21T18:30:19.185Z - ac-confirmed: AC10: Readline /expand keeps its behavior but is now built on the exported expandedToolOutput, which takes its header from blockLabel and routes a looksLikeUnifiedDiff body through renderDiff - the same src/lib helpers the TUI uses, so the two cannot drift. Eight tests in shell.test.ts incl. the shared-blockLabel case, the AC7 bullet negative and a NO_COLOR case.
- 2026-07-21T18:30:19.253Z - ac-confirmed: AC11: Every new transcript container uses flexShrink 0 with alignSelf flex-start and no unconstrained flexGrow. Tested structurally at four terminal sizes after expanding a 120-line block: footer is the last row, the composer box occupies the three rows above it, the draft survives. One carve-out at scrollTop === 2 for an upstream OpenTUI ScrollBox border-clipping defect, reproduced from pure OpenTUI primitives with zero keryx code and pinned by a test that fails when upstream fixes it. Recorded in specification 7.1.
- 2026-07-21T18:30:19.319Z - ac-confirmed: AC12: Expanding a non-newest block asserts scrollHeight grew, scrollTop is unchanged and stickyScroll is false, with a newest-block control case. Determinism via the injectable schedule introduced in b2c25e6.
- 2026-07-21T18:30:28.607Z - ac-confirmed: AC13: bun test full suite: 2012 pass / 11 skip / 0 fail across 231 files. bun run typecheck clean. review-orchestrator produced 1 HIGH, 3 MEDIUM, 5 LOW; all fixed in d523e8e and 7ca9421, with every disposition and two deliberate deferrals (paint performance, collapseToolOutput CRLF) recorded in journal.md. Code Health gate WARN at score 92 is pre-existing against a stale 2026-07-06 baseline: zero P0/P1, regression 3 vs the 5 already recorded in flow 001, and a changed-scope run attributes nothing to this branch.
- 2026-07-21T18:30:28.672Z - ac-confirmed: AC14: specification.md section 3 replaces the stale inline-expand bullet with the delivered behavior and the full key table; new section 7.1 records the harness facts (sequential @opentui import, the 20ms Esc timeout, the ScrollBox bleed); new section 9 records D-2 with claims verified against the vendored package (new Worker -> parser.worker.js, grammar loader fetches a URL, five bundled grammars) plus the revisit condition, alongside D-3 and D-5.
- 2026-07-21T18:30:28.738Z - completing
- 2026-07-21T18:30:31.024Z - done: all gates passed
