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

## Criteria

- AC1: `keryx review mutate` creates its scratch copy under the repository (`.metaproject/data/review/mutate-scratch/`), removes it on exit, and still accepts `--scratch tmp` for the old location; a test asserts the scratch path is inside the repo root. [verify: exec `bun test src/review/mutate.test.ts`]
- AC2: When the mutate baseline exits non-zero or times out, the command fails with exit code ≠ 0 AND prints the baseline command, its cwd and the last lines of its stdout/stderr; the same tail is written to the mutation evidence file. A test with a deliberately failing baseline asserts the printed tail. [verify: exec `bun test src/review/mutate.test.ts`] · sensitive: failure-scenario
- AC3: `keryx review retry-plan --package <dir> --next-wave` reads the package's raw results and does not hand out a slice whose result for that reviewer already exists and parses as DONE or DONE_WITH_CONCERNS; it reports how many late results it collected. A test plants a finished result file and asserts the slice is absent from the next wave, and that a malformed file does not count as covered. [verify: exec `bun test src/review/retry-plan.test.ts src/commands/review-slice.test.ts`] · sensitive: failure-scenario
- AC4: `keryx review verdict <id|path>` prints an interim verdict (finding counts by severity, verified vs unverified, open blockers) and writes `verdict-interim.md` in the package, without requiring ledger, mutation or `complete`; on a package with no findings it says so instead of failing. [verify: exec `bun test src/review/verdict.test.ts`]
- AC5: `keryx review required --depth auto` returns the light set (logic, testing and the stack's conventions reviewer) for a diff of ≤5 files and ≤300 changed lines with no path-gate hit and no `--all`/gating, returns the current full set otherwise, and prints the reason; `--depth full` always returns the full set. Tests cover the boundary (5/6 files, 300/301 lines) and a path-gate hit on a small diff. [verify: exec `bun test src/review/coverage.test.ts`]
- AC6: On a light round, `review complete` does not refuse for pending mutants and records "Not run: mutation (light round)"; on a full attended round the existing mutation refusal is unchanged. [verify: exec `bun test src/review/coverage.test.ts src/review/coverage-complete.test.ts`] · sensitive: revert
- AC7: Before dispatch, keryx prints an estimate for a sliced package: roles × slices = assignments, number of waves at the current wave budget, and an expected duration range. [verify: exec `bun test src/review/estimate.test.ts`]
- AC8: `review dispatch-check` fails with `REVIEWER_INPUT_PATH_MISSING`, naming the field, when `skill_path`, `context_doc` or another file path in the payload does not exist, and passes when they exist. [verify: exec `bun test src/review/dispatch-check.test.ts`] · sensitive: failure-scenario
- AC9: `review required` accepts `--package <dir>` (scope, blast-radius, pr-context read from the package); `review <cmd> --help` prints only that subcommand's help for start, ingest, required, mutate, blast-radius, complete and status, each listing every flag its parser accepts; `review start` bounds the graph refresh with `--graph-timeout` (default 90 s) and on timeout prints `layers: deferred` and continues. [verify: exec `bun test src/commands/review-help.test.ts src/commands/review-layers.test.ts`]
- AC10: The review-orchestrator skill (bundled and installed copies identical) says: interim verdict to the operator right after reviewers + verifier; verifier starts on the first blocker/major; recovery = collect → validate → ingest → dispatch missing only; change the task after a second timeout of the same reviewer; show the estimate and PR state before dispatch; light round outside the risk class; the shell-host contradiction (SKILL.md:88-94) is gone; SKILL.md stays within the existing 1615-line ceiling. [verify: invariant `bun test src/gdskills/`]
- AC11: The repository stays green: typecheck, lint and the core test suite pass on the PR head. [verify: invariant `bun run typecheck && bun run lint && bun run test:core`]
- AC12: A patch release of `@mrciphersmith/keryx` containing this flow is published to npm and its version is recorded in journal.md. [verify: exec `npm view @mrciphersmith/keryx version`]
- AC13: Owner's live check in vantage-frontend on the released version: at least one small low-risk PR and one large PR reviewed; the small one gives its verdict in ≤25 min; every round delivers an interim verdict before mutation/ledger/complete and reaches `complete` (or states exactly what is not run); no finished wave is re-dispatched; `review mutate` either passes its baseline or prints why. Results recorded in journal.md. [verify: judged]
