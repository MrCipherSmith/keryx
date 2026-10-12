# Acceptance Criteria - Deferred Majors of PR 940 and PR 975

Status: DRAFT. Not frozen. Awaiting the operator's review; no AC is final until the operator freezes the flow.

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.
- "Red before, green after" means the named test is added in the same change and fails on `origin/main` at `249bc59b`.

## Criteria

### Queue (F-001)

- AC1: A headless test queues `['/compact', 'question']` in the TUI shell while a turn is running; after the turn settles, `question` is dispatched as a turn without any further operator input - red before (the question stays in `mainQueue`), green after.
- AC2: `/model`, `/goal` and `/connect` queued before a question each drain the question the same way - one test per command, or one table-driven test over the four slash commands.
- AC3: The three drain sites in `src/tui/tui-shell.ts` (turn complete, settle with `busWakeController?.onSettle()`, `leaseHoldController.onRelease`) call one shared `drainNext` helper; a test per site asserts the site still drains one line that starts a turn and stops, and the `onSettle()` call still happens in the else branch.
- AC4: A queue of five slash lines that start no turn drains all five and ends with an empty queue; the drain is bounded by the queue length (a test with a line that re-enqueues itself terminates).

### Trust table: `bun test` (F-007)

- AC5: `isTrustRoutineCommand` returns false for `bun test --preload ./x.ts`, for `keryx ctx run -- bun test --preload ./x.ts`, and for `cd /tmp/other && bun test` - red before, green after.
- AC6: `isTrustRoutineCommand("bun test")` in the project root with an unchanged `bunfig.toml` stays true; the same command after the `bunfig.toml` hash changed, or when the file carries a `preload`, is false - tests for each branch (this AC follows Decision 1 of the PRD; it is rewritten before freeze if the operator picks "never routine").
- AC7: After untrusted content entered the turn, no `bun test` form is routine - a test over the argument-free and the argument forms.

### Path flags (F-008)

- AC8: `keryx review slice --out <path>` exits non-zero with a named reason, and writes nothing, when `<path>` resolves outside the project root and outside `.metaproject/`; a path under `.metaproject/reviews/` and the default `DEFAULT_SLICE_DIR` still work - tests for an outside path, an inside path, and a symlink inside the project that points outside.
- AC9: `keryx review retry-plan --state <file>` and `--manifest <file>`, and `keryx review dispatch-check --manifest <file>`, refuse an outside path the same way - one test per flag.
- AC10: `isTrustRoutineCommand` is false for each of the three commands when a path flag names a path outside the project root, and true when no path flag is present or the path is inside - table-driven test.

### Result parser (D-01, D-03, D-05, D-10)

- AC11: `parseReviewResult` on a truncated reply whose outer object does not close (a `slices[]` array with nested `{"status": ...}` entries) returns `undefined`, not a nested entry - red before, green after.
- AC12: `parseReviewResult` on a reply whose `slices` array has a trailing comma returns `undefined`, and so does a reply with a trailing comma before the closing brace.
- AC13: `parseReviewResult` on `{"status":"BLOCKED","reviewer":"r","findings":[]}` followed by a trailing `{"status":"DONE"}` returns the BLOCKED object or `undefined` (the two-status case is ambiguous), never the DONE object - the test pins the chosen outcome.
- AC14: `parseReviewResult` accepts only a top-level object with `reviewer` or a `findings` array; an object with only a string `status` is rejected. The fenced `REVIEW_RESULT` branch and its existing tests are unchanged and stay green.
- AC15: When a `REVIEW_RESULT` marker is present with a bare object after it, the object after the marker is the result even when an earlier or later object has a `status`.
- AC16: The parser run over every `raw/` reviewer file of every closed review round in the repository returns the same result as before the change, or a documented gap for a file that parsed by luck; the replay report is checked in with the change and lists no unexplained difference.

### Verify commands (D-02)

- AC17: `src/commands/review-slice.test.ts` exists and covers: a result read through the command, the `UnreadableInput` exit for an unreadable file, and `scopeFingerprint` changing when same-size content changes - each test is red against a build with the behaviour removed (checked by one mutation per behaviour, recorded in the PR).
- AC18: A repository test scans every `[verify: exec ...]` line of every flow `acceptance-criteria.md` under `.metaproject/flows/` and fails when a named `*.test.ts` file does not exist; the test is red on `origin/main` before AC17 lands (flow 427 AC2 and AC5) and green after.
- AC19: Flow 427 AC2 and AC5 are not edited by this flow; if the operator wants them re-pointed, that is a separate `keryx flow ac update` decision recorded in the PR.

### Process

- AC20: Every task closes with a review round in mode `all` whose package records no unaddressed major; the mutation pass for the changed functions (`parseReviewResult`, the drain helper, the path confinement, `isRoutineSegment`) is run, and its outcome table is attached to the round.
- AC21: The release note names the five defects by their original IDs (F-001, F-007, F-008, D-01, D-02) and the pull request that found each (940, 975).
