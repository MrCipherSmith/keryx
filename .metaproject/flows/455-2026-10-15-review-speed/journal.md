# Flow Journal

- 2026-10-15T11:21:50.411Z - flow created
- 2026-10-15T11:25:20.040Z - task-done: T1: Collect remaining context
- 2026-10-15T11:25:20.185Z - task-done: T2: Implement per plan
- 2026-10-15T11:25:20.340Z - task-done: T3: Add/adjust tests and make them pass
- 2026-10-15T11:25:20.485Z - task-done: T4: Self-review and prepare draft PR
- 2026-10-15T11:25:20.634Z - task-added: T5: A: mutate scratch under repo + baseline output on failure
- 2026-10-15T11:25:20.773Z - task-added: T6: B: retry-plan --package collects late results
- 2026-10-15T11:25:20.924Z - task-added: T7: C: review verdict interim command
- 2026-10-15T11:25:21.072Z - task-added: T8: D: required --depth, light-round mutation waiver, estimate
- 2026-10-15T11:25:21.213Z - task-added: T9: E: dispatch-check paths, required --package, help, start graph timeout
- 2026-10-15T11:25:21.363Z - task-added: T10: Skill review-orchestrator update (both copies)
- 2026-10-15T11:25:21.505Z - task-added: T11: Verify + review round + PR
- 2026-10-15T11:25:21.651Z - task-added: T12: Patch release after merge; record version
- 2026-10-15T11:25:21.790Z - task-added: T13: Owner live check in vantage-frontend
- 2026-10-15T11:25:27.433Z - frozen: 13 criteria; checksum recorded
- 2026-10-15T11:25:27.434Z - warning: no verification kind on AC2, AC3, AC6, AC8 — add [verify: …] or accept them unclassified
- 2026-10-15T11:25:27.577Z - started
- 2026-10-15T11:25:35.566Z - ac-updated: AC2: "When the mutate baseline exits non-zero or times out, the command fails with exit code ≠ 0 AND prints the baseline command, its cwd and the last lines of its stdout/stderr; the same tail is written to the mutation evidence file. A test with a deliberately failing baseline asserts the printed tail. [verify: exec `bun test src/review/mutate.test.ts`] · sensitive: failure-scenario" -> "When the mutate baseline exits non-zero or times out, the command fails with exit code ≠ 0 AND prints the baseline command, its cwd and the last lines of its stdout/stderr; the same tail is written to the mutation evidence file. A test with a deliberately failing baseline asserts the printed tail. · sensitive: failure-scenario [verify: exec `bun test src/review/mutate.test.ts`]" (move sensitive tag before the verify marker so the kind parses)
- 2026-10-15T11:25:35.706Z - ac-updated: AC3: "`keryx review retry-plan --package <dir> --next-wave` reads the package's raw results and does not hand out a slice whose result for that reviewer already exists and parses as DONE or DONE_WITH_CONCERNS; it reports how many late results it collected. A test plants a finished result file and asserts the slice is absent from the next wave, and that a malformed file does not count as covered. [verify: exec `bun test src/review/retry-plan.test.ts src/commands/review-slice.test.ts`] · sensitive: failure-scenario" -> "keryx review retry-plan --package <dir> --next-wave reads the package raw results and does not hand out a slice whose result for that reviewer already exists and parses as DONE or DONE_WITH_CONCERNS; it reports how many late results it collected. A test plants a finished result file and asserts the slice is absent from the next wave, and that a malformed file does not count as covered. · sensitive: failure-scenario [verify: exec `bun test src/review/retry-plan.test.ts src/commands/review-slice.test.ts`]" (move sensitive tag before the verify marker so the kind parses)
- 2026-10-15T11:25:35.849Z - ac-updated: AC6: "On a light round, `review complete` does not refuse for pending mutants and records "Not run: mutation (light round)"; on a full attended round the existing mutation refusal is unchanged. [verify: exec `bun test src/review/coverage.test.ts src/review/coverage-complete.test.ts`] · sensitive: revert" -> "On a light round, review complete does not refuse for pending mutants and records "Not run: mutation (light round)"; on a full attended round the existing mutation refusal is unchanged. · sensitive: revert [verify: exec `bun test src/review/coverage.test.ts src/review/coverage-complete.test.ts`]" (move sensitive tag before the verify marker so the kind parses)
- 2026-10-15T11:25:35.997Z - ac-updated: AC8: "`review dispatch-check` fails with `REVIEWER_INPUT_PATH_MISSING`, naming the field, when `skill_path`, `context_doc` or another file path in the payload does not exist, and passes when they exist. [verify: exec `bun test src/review/dispatch-check.test.ts`] · sensitive: failure-scenario" -> "review dispatch-check fails with REVIEWER_INPUT_PATH_MISSING, naming the field, when skill_path, context_doc or another file path in the payload does not exist, and passes when they exist. · sensitive: failure-scenario [verify: exec `bun test src/review/dispatch-check.test.ts`]" (move sensitive tag before the verify marker so the kind parses)
- 2026-10-15T11:26:09.956Z - task-attempt: T5: started (attempt 1) — 455-T5 sonnet worker
- 2026-10-15T11:26:10.104Z - task-attempt: T6: started (attempt 1) — 455-T6 sonnet worker
- 2026-10-15T11:28:44.249Z - task-done: T6: B: retry-plan --package collects late results
- 2026-10-15T11:29:08.010Z - task-done: T5: A: mutate scratch under repo + baseline output on failure
- 2026-10-15T11:32:48.042Z - task-done: T7: C: review verdict interim command

- 2026-10-15: src/lib/trust-routine-command.test.ts R3-01 fails on main too (git log --o* glob, env-dependent); not caused by flow 455.
- 2026-10-15T11:40:18.917Z - task-done: T8: D: required --depth, light-round mutation waiver, estimate
- 2026-10-15T11:50:49.943Z - task-done: T9: E: dispatch-check paths, required --package, help, start graph timeout
- 2026-10-15T11:52:14.093Z - task-done: T10: Skill review-orchestrator update (both copies)
- 2026-10-15: src/gdskills/install.test.ts "retired rule in a read-only rules/core" fails on origin/main too (env); not caused by flow 455.

## 2026-10-15 review round (T11)

Two opus reviewers on origin/main...HEAD.
- Code: B1 light depth forgeable (skips mutation gate); M1 late collection credits assigned not reported slices; M2 mutate scratch not git-ignored in user projects / no signal cleanup; M3 scratch copy finds the real .git; m1 baseline evidence counted as a mutation pass; m2 required --package unconfined; m3 graph-timeout overflow + failed-graph message; m4 acted-on findings counted open.
- Skill: depth auto needs file list + line count; preflight 4 placed before a package exists; verdict misses shell-host raw dir and verifier refutations; --depth light honoured with --all; early verifier contradicts wave order/9b/consolidated findings; shell-host rule wrong (children can read project files); checklist wording; attended-only tail wording; recovery order.
Fix lanes dispatched: lane 1 (depth gate, required, verdict, estimate, graph-timeout), lane 2 (late results, mutate, gitignore, evidence naming, dispatch-check help). Skill text after both.
- 2026-10-15T12:00:08.158Z - task-attempt: T11: started (attempt 1) — review round 1: 1 blocker, 3 major; fix lanes 1+2
- 2026-10-15T12:22:33.077Z - task-done: T11: Verify + review round + PR
- 2026-10-15: PR https://github.com/MrCipherSmith/keryx/pull/1029 opened (T11). Merge is the owner's; then T12 patch release.
- 2026-10-15T13:50:40.017Z - task-done: T12: Patch release after merge; record version
- 2026-10-15T13:50:43.116Z - implemented: draft PR: https://github.com/MrCipherSmith/keryx/pull/1029 (warning: PR is not a draft)
- 2026-10-15T13:50:43.283Z - ac-confirmed: AC12: npm latest = 0.3.118 (release run 38743164813, tag v0.3.118 on 1675e4336) (signed: 200531777+MrCipherSmith@users.noreply.github.com [derived])
- 2026-10-15: released @mrciphersmith/keryx 0.3.118 (PR #1030, tag v0.3.118, run 38743164813). T13 (owner live check, AC13) open: answer expected in 2-3 days.
