# Flow Journal

- 2026-09-25T04:36:22.847Z - flow created
- 2026-09-25T04:40:43.196Z - task-done: T1: Collect remaining context
- 2026-09-25T04:40:43.287Z - task-done: T2: Implement per plan
- 2026-09-25T04:40:43.384Z - task-done: T3: Add/adjust tests and make them pass
- 2026-09-25T04:40:43.482Z - task-done: T4: Self-review and prepare draft PR
- 2026-09-25T04:40:50.601Z - task-added: T5: FU1: diagnose+fix python-implementation trigger-positive-6
- 2026-09-25T04:40:50.697Z - task-added: T6: FU2: runner answer-in-text system note + no-sleep-sync check
- 2026-09-25T04:40:50.790Z - task-added: T7: FU3: live re-judge sampler (skills eval --reverify)
- 2026-09-25T04:40:50.881Z - task-added: T8: FU4: PACK_MIN_TRIALS 5->10 + regression test
- 2026-09-25T04:40:50.973Z - task-added: T9: FU5: react no-disable-hooks-lint defect check
- 2026-09-25T04:40:51.063Z - task-added: T10: FU6: getter-accessor calibration variant
- 2026-09-25T04:40:51.157Z - task-added: T11: FU7: re-record calibration + honest gate run at trials=10 + docs/agents
- 2026-09-25T04:40:55.242Z - frozen: 9 criteria; checksum recorded
- 2026-09-25T04:40:55.339Z - started
- 2026-09-25T04:41:01.251Z - task-attempt: T5: started (attempt 1) — diagnosing python-implementation trigger-positive-6

## FU1 (T5): python-implementation trigger-positive-6

Diagnosed with `keryx skills scout "<trigger-positive-6 prompt>" --scope bundled --json`
(offline, no model call): `go/go-implementation` outscored
`python/python-implementation` (0.475 vs 0.466) purely on generic overlap
(add/feature/log/module/service) — python-implementation's own description
never used the word "service" and its logging mention was a single bare word,
so `go-implementation`'s (also generic) "log/slog usage" + "service" wording
won on IDF-weighted coverage even though the prompt names Python explicitly.
This is a genuine under-description of the skill's own scope, not a prompt
defect (the eval prompt is exactly the kind of task this skill is for) —
fixed per plan.md/AC1: python-implementation's frontmatter `description` now
says "...codebase or service..." and "...request/event logging with the
standard logging module...", plus one new trigger "log requests in this
python service". Never touched python-implementation/evals.json.

Verified: `keryx skills scout` now ranks python-implementation first
(0.779 vs go-implementation's 0.467); `skills eval python/python-implementation
--scope bundled --json` shows trigger-positive-6 passRate 1. Regression check:
a full bundled-catalog trigger-only pass (`scoreTriggerScenarios` over every
skill shipping an authored evals.json, positives scored `field:"full"` since
authored) shows 110/110 positives selected and 108/108 negatives correctly
rejected — no other skill's trigger accuracy moved.

`bun test src/gdskills/stack-packs.test.ts src/gdskills/stack-pack-eval-integrity.test.ts src/gdskills/governance`: 1483 pass, 0 fail.
- 2026-09-25T04:43:35.832Z - task-done: T5: FU1: diagnose+fix python-implementation trigger-positive-6
- 2026-09-25T04:43:41.046Z - task-attempt: T6: started (attempt 1) — runner answer-in-text system note

## FU2 (T6): runner answer-in-text system note + no-sleep-sync check

`go-testing#table-driven-subtests` (flow 316 journal T13) failed 3/5 because
`buildEvalRunner` gives the model no tools at all, and the model tried one
anyway instead of answering in text. Added a uniform runner-level system
note, `RUNNER_SYSTEM_NOTE` (`eval.ts`), appended after `skill.body` in
`buildEvalRunner` (`model-eval-runner.ts`) for EVERY skill/scenario alike —
never a per-scenario prompt change. Added `RUNNER_PROMPT_VERSION` mirroring
`JUDGE_PROMPT_VERSION`'s contract; the CLI (`evalCommand`) stamps
`runnerPromptVersion` on the report alongside `runner`/`model` whenever
`--runner` was used; `checkSkillReportForPackGate` now requires it to equal
the current version for every report carrying a ran behavior scenario (every
ran behavior scenario came from a `--runner` call, so this is unconditional,
mirroring the judge check). `__fixtures__/gate-ready-report.ts` updated to
stamp it too, and two new gate tests added (`eval.test.ts`: stale and
missing `runnerPromptVersion` both fail the gate, naming the field).

`no-sleep-sync` rubric review (owner ask: "review timeouts vs sleeps, fix
only if defective"): read `go/go-testing/evals.json`'s rubric/pass_criteria/
fail_criteria/calibration for `no-sleep-sync`. It already correctly
distinguishes a fixed `time.Sleep` delay (fail, "whether as the sole
mechanism or as extra 'insurance' alongside a real join") from an actual
synchronization primitive (WaitGroup/channel), and `known_right` explicitly
allows a `select` against a deadline as a legitimate additional safety net
without being scored as a sleep — the `subtle_wrong` calibration answer
(WaitGroup + an extra `time.Sleep` "insurance" line) exercises exactly the
gap a weaker rubric would miss. No defect found; left unchanged. This is the
honest result, not a silent skip: T13's own failure list never named
`no-sleep-sync` as failing (only `table-driven-subtests` did) — it was
already passing under the old grader and remains correctly specified now.

`bun test src/gdskills/governance src/commands/model-eval-runner.test.ts
src/commands/skills-governance.test.ts`: 289 pass, 0 fail; `bun run
typecheck`: exit 0. Five REAL bundled-tree tests (ts-js-node's committed
`governance/eval.json` predates `runnerPromptVersion`) now correctly fail
the gate as stale evidence — expected, and resolved by FU7's honest re-run,
not worked around here.
