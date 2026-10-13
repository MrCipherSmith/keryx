# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- Every criterion ends with [verify: exec `<command>`],
  [verify: invariant `<command>`], [verify: judged] or
  [verify: none — <reason>].
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

A criterion that says "red before, green after" names a test added in the same change that fails on `origin/main` at `249bc59b`. Verify kind is `judged` for every criterion on purpose: the tests the criteria name do not exist yet, and an `exec` line naming a missing test file is the defect AC18 closes.

## Criteria

### Queue (F-001)

- AC1: A headless test queues `['/compact', 'question']` in the TUI shell while a turn is running; after the turn settles, `question` is dispatched as a turn without any further operator input - red before (the question stays in `mainQueue`), green after. [verify: judged]
- AC2: `/model`, `/goal` and `/connect` queued before a question each drain the question the same way - one test per command, or one table-driven test over the four slash commands. [verify: judged]
- AC3: The three drain sites in `src/tui/tui-shell.ts` (turn complete, settle with `busWakeController?.onSettle()`, `leaseHoldController.onRelease`) call one shared `drainNext` helper; a test per site asserts the site still drains one line that starts a turn and stops, and the `onSettle()` call still happens in the else branch. [verify: judged]
- AC4: A queue of five slash lines that start no turn drains all five and ends with an empty queue; the drain is bounded by the queue length (a test with a line that re-enqueues itself terminates). [verify: judged]

### Trust table: `bun test` (F-007)

- AC5: `isTrustRoutineCommand` returns false for `bun test --preload ./x.ts`, for `keryx ctx run -- bun test --preload ./x.ts`, for `bun test ./some/file.test.ts` (positional path), for `bun test --coverage-dir /tmp/x` (output flag), and for `cd /tmp/other && bun test` - red before, green after. [verify: judged]
- AC6: `isTrustRoutineCommand("bun test")` in the project root with an unchanged `bunfig.toml` stays true, and so does `bun test` with only flags from this closed allow-list: `--bail`, `--only`, `--todo`, `--rerun-each N` and `--timeout N` (N is a plain non-negative integer); the same command after the `bunfig.toml` hash changed, or when the file carries a `preload`, is false, and so is any positional path, any other flag, and `--rerun-each` or `--timeout` with a non-integer value - tests for each branch (operator decision 1 of poll 137: "only without path and output flags"; allow-list fixed by poll 142, 2026-10-13). [verify: judged]
- AC7: After untrusted content entered the turn, no `bun test` form is routine - a test over the argument-free and the argument forms. [verify: judged]

### Path flags (F-008)

- AC8: `keryx review slice --out <path>` exits non-zero with a named reason, and writes nothing, when `<path>` resolves outside the project root and outside `.metaproject/`; a path under `.metaproject/reviews/` and the default `DEFAULT_SLICE_DIR` still work - tests for an outside path, an inside path, and a symlink inside the project that points outside. [verify: judged]
- AC9: `keryx review retry-plan --state <file>` and `--manifest <file>`, and `keryx review dispatch-check --manifest <file>`, refuse an outside path the same way - one test per flag. [verify: judged]
- AC10: `isTrustRoutineCommand` is false for each of the three commands when a path flag names a path outside the project root, and true when no path flag is present or the path is inside - table-driven test. [verify: judged]

### Result parser (D-01, D-03, D-05, D-10)

- AC11: `parseReviewResult` on a truncated reply whose outer object does not close (a `slices[]` array with nested `{"status": ...}` entries) returns `undefined`, not a nested entry - red before, green after. [verify: judged]
- AC12: `parseReviewResult` on a reply whose `slices` array has a trailing comma returns `undefined`, and so does a reply with a trailing comma before the closing brace. [verify: judged]
- AC13: `parseReviewResult` on `{"status":"BLOCKED","reviewer":"r","findings":[]}` followed by a trailing `{"status":"DONE"}`, with no `REVIEW_RESULT` marker, returns `undefined` (the two-status case is ambiguous and raises the existing "no parseable REVIEW_RESULT block" gap), never either object; the same two objects with a `REVIEW_RESULT` marker before one of them return the object after the marker (poll 142, 2026-10-13). [verify: judged]
- AC14: `parseReviewResult` accepts only a top-level object with `reviewer` or a `findings` array; an object with only a string `status` is rejected. The fenced `REVIEW_RESULT` branch and its existing tests are unchanged and stay green. [verify: judged]
- AC15: When a `REVIEW_RESULT` marker is present with a bare object after it, the object after the marker is the result even when an earlier or later object has a `status`. [verify: judged]
- AC16: The parser run over every `raw/` reviewer file of every closed review round in the repository returns the same result as before the change, or differs and is listed in a checked-in replay report; every listed difference (a file that parsed by luck and now gives a gap) is shown to the operator and decided file by file before the change merges, and the report has no undecided row (poll 142, 2026-10-13). The parser is not tuned to keep a lucky file parsing. [verify: judged]

### Verify commands (D-02)

- AC17: `src/commands/review-slice.test.ts` exists and covers: a result read through the command, the `UnreadableInput` exit for an unreadable file, and `scopeFingerprint` changing when same-size content changes - each test is red against a build with the behaviour removed (checked by one mutation per behaviour, recorded in the PR). [verify: judged]
- AC18: A repository test scans every `[verify: exec ...]` line of every flow `acceptance-criteria.md` under `.metaproject/flows/` and fails when a named `*.test.ts` file does not exist; the test is red on `origin/main` before AC17 lands (flow 427 AC2 and AC5) and green after. [verify: judged]
- AC19: Flow 427 AC2 and AC5 are not edited by this flow; if the operator wants them re-pointed, that is a separate `keryx flow ac update` decision recorded in the PR. [verify: judged]

### Process

- AC20: Every task closes with a review round in mode `all` whose package records no unaddressed major; the mutation pass for the changed functions (`parseReviewResult`, the drain helper, the path confinement, `isRoutineSegment`) is run, and its outcome table is attached to the round. [verify: judged]
- AC21: The release note names the five defects by their original IDs (F-001, F-007, F-008, D-01, D-02) and the pull request that found each (940, 975). [verify: judged]
