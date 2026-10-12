# Acceptance Criteria - Review-Depth Parity

Status: DRAFT. Not frozen. Awaiting the operator's review; no AC is final until the operator freezes the flow.

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.
- "To be measured in T1" means the value is produced by the baseline task T1 of the PRD and written into this file through `keryx flow ac update` before freeze; no number is invented in the draft.

## Criteria

### Baseline and selection

- AC1: Task T1 produces a checked-in baseline record for PR 7659 on the unchanged release (mode `all`): reviewers run, raw findings per reviewer, wall time, input tokens, cost, and the A-E classification of the 19 Claude items; every "to be measured in T1" value in this file is filled from it before freeze - checked by a test that fails while any `to be measured in T1` marker remains in a frozen file.
- AC2: For a pull-request review with no operator-named narrowing, `keryx review required` returns mode `all`; `--mode diff` is accepted only together with a recorded operator quote, and `keryx review dispatch` (and `dispatch-check`) exits non-zero with a named reason when the dispatched set is narrower than `required` and no quote is present - covered by unit tests for default mode, explicit `diff` with and without a quote, and a short dispatch.
- AC3: The orchestrator prompt and the autonomous profile both default a PR review to `all`; a test reads both and asserts the default and the "diff only on an operator quote" wording.
- AC4: On a fixture scope of one file `src/pipelines/index.ts`, `keryx review required --mode diff` and `--mode all` both select a project reviewer whose description paths are `src/pipelines/**` (pathsSource `description`); on a fixture scope of `src/core/x.ts` a project reviewer with `src/core/**` paths is selected; a project reviewer with a non-matching literal path is still excluded with reason `no-matching-paths` - regression tests, including the PR 7659 case.
- AC5: Every reviewer absent from a round's coverage has a reason that names whether an operator quote or a path rule excluded it; a test fails when a coverage row for an excluded role has an empty or generic reason.

### Mutation pass

- AC6: `keryx review mutate --cap <n>` exists; it runs in a copy of the worktree, restores the original in a `finally` block (a test injects a failure mid-run and asserts the original tree is byte-identical afterwards), refuses an anchor that does not match exactly once (the mutant is recorded `not-applicable`), and rejects a cap other than 6 or 12 unless a documented override is passed.
- AC7: `keryx review mutate` records a baseline run of the targeted tests before any mutant; a red baseline stops the pass with a named reason and writes no `killed`/`survived` row - covered by a test with a deliberately failing baseline.
- AC8: The pass writes an outcome table (mutant, file, line, `killed|survived|not-applicable`, killing test) under `research-evidence/` and references it from `research.json`; the table validates against a JSON Schema checked in with the contracts, and a replay on a fixture with a known surviving mutant reports it as `survived`.
- AC9: With a live operator and a testing reviewer that returned "mutation pending" with an executable script or runnable tests, `keryx review complete` refuses with the exact `keryx review mutate ...` command; `Not run: mutation pass` is accepted only with an operator quote or a recorded environment reason, and in an unattended run - tests for each of the four branches.
- AC10: In a closed package produced with a live operator and no quote, the count of `Not run` execution rows is 0 - checked by a sweep test over the packages written by the integration fixture, and measured on the PR 7659 replay (AC19).

### Severity and evidence

- AC11: A finding that cites a surviving mutant from the AC8 table can carry `major`; a finding with no execution evidence is capped at `minor` and carries `unproven` in `findings.json` and in `report.md` - schema test plus a fixture round with one finding of each kind.
- AC12: A separate `severity audit` pass raises a severity only on execution evidence (a surviving mutant) and never on reasoning alone; `review-verifier` still cannot raise a severity (its existing delete-only tests stay green and a new test asserts the audit is the only raising path).
- AC13: `keryx review complete` marks a required reviewer whose raw answer is empty without a statement of what was read as `shallow`, shows it in coverage, and fails the gate unless an operator quote accepts it; the minimum evidence size and slice-coverage thresholds are to be measured in T1 and are written into this criterion before freeze.

### Context and regression

- AC14: `keryx review context` (proposed name) builds a versioned pack with a content hash; the pull-request section carries the full text of every review comment and the PR body (a test with an 801-character comment asserts the whole text is present, or that a stated cap appears in the pack and in the report), the previous round's findings and decisions, the CI status with the failing job summary, and the pins the PR names.
- AC15: Each reviewer payload references the pack and carries only the slice for its role; the payload still validates against `reviewer-input.schema.json`, and a test asserts two reviewers with different roles do not receive byte-identical review context. The per-reviewer size ceiling is to be measured in T1.
- AC16: When `keryx review blast-radius` is computed for the round, `review-regression` is in `required` and its payload lists the dependents and their tests; when blast radius is not computed the coverage row says so with a reason - tests for both branches.

### Measurement

- AC17: A comparison fixture classifies the 19 Claude items of PR 7659 into classes A-E against a keryx result, and `keryx review compare` (proposed name; the command or an equivalent test script) prints the class counts - a test replays the fixture and asserts the counts of the baseline from AC1.
- AC18: After the changes, a replay of PR 7659 in mode `all` has 0 items in class A, and the mutation table shows a surviving mutant for the M1 item that yields a `major` - recorded in the replay report with its session id.
- AC19: The same replay finds at least 12 of the 19 Claude items (the target stated in the note; the operator may change the number before freeze, see PRD Decision 4) and reports raw findings per reviewer; the target of the order of 3-7 raw findings per reviewer is checked against the measured distribution and any reviewer outside it is listed with its raw answer size.
- AC20: The control run on PR 7840 produces no major finding that the baseline of that PR does not contain (no false major); the replay report states the comparison.
- AC21: The before/after report states wall time, input tokens and cost for the baseline and the replay with the figures from the cost record (`not recorded` where a stage did not run, never `0`); the ceiling the operator accepts (PRD Decision 2) is stated and the replay is within it or the report says by how much it is not.

### Surfaces (TUI and CLI)

- AC22: The `/review` inspector (`src/tui/review-inspector.ts`) shows for the current round: the required set versus the dispatched set with the exclusion reason per absent role, the mutation outcome table, severities marked `unproven`, and reviewers marked `shallow`; a snapshot test renders each state, including an empty round, with the footer keys documented.
- AC23: The `/reviews` list (`src/tui/reviews-inspector.ts`) shows per round a depth line: reviewers run of required, raw findings, `Not run` count, mutation killed/survived; a snapshot test covers a round with a survived mutant and a round with none.
- AC24: A sidebar line (next to the existing review state in the ops sidebar, `src/tui/ops-sidebar.ts`) shows the active round's depth state (reviewers, mutation, shallow count) and updates when `review complete` refuses; a test drives the sidebar source with a refusing round.
- AC25: The settings modal (`src/tui/settings-model.ts`) has an entry for the default review mode for pull requests with the value `all`, states that `diff` needs an operator quote, and persists the choice; a settings-state test covers read, change and default.
- AC26: `keryx help review` documents `review mutate`, `review context`, `review compare` and the changed `required`/`dispatch` rules, and every flag accepted by their argument parsers appears in the usage line - a test enumerates the parser's flags and asserts each is visible in the help text (the same check cycle 5 of the AC16 run asked for on `ingest`).

### Compatibility and closing

- AC27: Existing review packages in `.metaproject/flows/*/reviews/*` still load, validate and render in `/reviews` unchanged; no on-read rewrite and no `schemaVersion` bump - a sweep test over those packages.
- AC28: The documentation (README, docs site review page, the review-orchestrator SKILL.md) states the new default, the mutation command, the severity rule and the `unproven` label, and `keryx docs check` (or the repository's docs drift check) passes.
- AC29: CI is green on the pull request and `keryx health run` passes on the branch.
