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
