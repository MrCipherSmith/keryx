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
- 2026-09-25T04:48:41.955Z - task-done: T6: FU2: runner answer-in-text system note + no-sleep-sync check
- 2026-09-25T04:48:45.703Z - task-attempt: T7: started (attempt 1) — live re-judge sampler: skills eval --reverify

## FU3 (T7): live re-judge sampler

Added `keryx skills eval --reverify <pack-dir> [--sample N] --judge <provider>[:<model>]`
(dispatched from `evalCommand` before the normal `<skill-id>` usage check,
since `--reverify` takes a pack dir, not a skill id). Core logic is
`reverifyPackSample` (`eval.ts`): reads the pack's `governance/eval.json`,
collects every RAN behavior scenario's `trialRecords` that carry a judge
verdict, samples up to `--sample` (default 10) of them WITHOUT replacement
(Fisher-Yates, injectable RNG for deterministic tests), re-judges each
sampled `output` live via `gradeScenarioAnswer` against the skill's CURRENT
evals.json scenario (never the report's own stale copy), and reports every
disagreement plus the disagreement rate. Exits non-zero when the rate
exceeds `REVERIFY_DISAGREEMENT_THRESHOLD` (20%, documented in `eval.ts`'s
doc comment: a live judge is not perfectly deterministic on identical input
— flow 316 review round 1 — so one flaky sample among a few must not fail
the check; a genuinely elevated rate should).

This is a diagnostic, not a gate: it closes a gap the stable-pack gate
structurally cannot (`regradeRecordedReport` proves a report is internally
consistent — the SAME output really does produce the SAME deterministic/
judge conclusion — but it cannot prove a recorded judge verdict was ever a
genuine live grading, or that the judge provider's weights haven't drifted
under a pinned model name). Documented in
`docs/docs/cli-reference.md`'s eval/judge-check table with an explicit
threat-model paragraph, next to `judge-check`'s own (which covers a
different gap: hard-to-game rubrics, not judge-verdict provenance).

Unit tests (`eval.test.ts`, nested inside "the hardened stable-pack gate" so
they can reuse `writeGateFixture`): agreeing stub judge -> zero
disagreements; disagreeing stub judge -> every trial flagged, rate 1.0,
threshold exceeded; `--sample` caps the judge-call count at the sample size,
never at totalEligible; a pack with no judge-graded scenarios never calls
the judge and reports zero eligible/sampled. CLI-level tests
(`skills-governance.test.ts`): usage/`--judge`/`--sample` validation errors,
and one end-to-end success path against a real on-disk fixture pack via the
`buildJudge` injection seam (no network).

`bun test src/gdskills/governance/eval.test.ts src/commands/skills-governance.test.ts`:
97 + 52 pass, 0 fail. `bun run typecheck`: exit 0. `bunx eslint` on all
changed files: 0 problems (docs/*.md gets an expected "no matching config"
warning, not an error).
- 2026-09-25T04:56:40.822Z - task-done: T7: FU3: live re-judge sampler (skills eval --reverify)
- 2026-09-25T04:56:46.214Z - task-attempt: T8: started (attempt 1) — PACK_MIN_TRIALS 5->10

## FU4 (T8): PACK_MIN_TRIALS 5 -> 10

Flow 316's own honest gate run (journal T13) landed several scenarios
exactly at the `PACK_BEHAVIOR_PASS_FLOOR` (0.8) with only 5 trials:
`no-ts-ignore-suppression` and `dirname-replacement` both 4/5,
`no-disable-hooks-lint` and `no-mobx-scope` both 4/5. At 5 trials, 0.8 sits
one flipped trial away from failing either direction — reasoning documented
in `eval.ts`'s `PACK_MIN_TRIALS` doc comment. Bumped 5 -> 10; no
grandfathering (`checkSkillReportForPackGate`'s existing `trials <
PACK_MIN_TRIALS` check already covers this unconditionally, so this is a
one-line constant change plus a new regression test).

Added `eval.test.ts`: "PACK_MIN_TRIALS regression: a report recorded at the
OLD minimum (5 trials) still fails the gate after the bump to 10" — pins
`PACK_MIN_TRIALS === 10` and proves a 5-trial report (valid, gate-clearing
under the old constant) now fails naming "below the pack minimum 10".

Fixed two PRE-EXISTING tests whose honest fixtures hardcoded a `passes`
count tuned to the OLD `PACK_MIN_TRIALS=5` denominator (`mixedTrialsReport`
computes `verdict` from `passes/trials` against the 0.8 floor, so scaling
the denominator without scaling the numerator silently flipped their
"honest, floor-clearing" premise to a genuine failure): "a behavior
scenario's OWN trials below PACK_MIN_TRIALS..." (5/5 -> now PACK_MIN_TRIALS/
PACK_MIN_TRIALS, still 100%) and "passAtK disagreeing with (passes > 0 ? 1 :
0)..." (4/5=0.8 -> now 8/10=0.8, same floor-clearing rate). Both are fixture
math corrections to preserve the ORIGINAL test intent under the new
denominator, not a weakening of what either test proves.

`bun test src/gdskills/governance`: 233 pass, 0 fail. `bun run typecheck`:
exit 0. `bunx eslint`: 0 problems. Five REAL bundled-tree tests
(`stack-packs.test.ts`, `src/agents`, `agents-catalog-commands.test.ts` —
same set FU2 already found stale, plus now also below the trials floor)
remain red until FU7's honest re-run rebuilds the committed
`governance/eval.json` files at trials=10 with the current runner/judge
prompt versions — expected, not worked around here.
- 2026-09-25T05:00:15.506Z - task-done: T8: FU4: PACK_MIN_TRIALS 5->10 + regression test
- 2026-09-25T05:00:21.987Z - task-attempt: T9: started (attempt 1) — react no-disable-hooks-lint defect check

## FU5 (T9): react no-disable-hooks-lint defect check

Read `react-build-fix/evals.json`'s `no-disable-hooks-lint` rubric/pass_criteria/
fail_criteria and every recorded trial output + judge reason from the
committed `governance/eval.json` (3/5, trials 2 and 4 failed):

- **Trial 2** presented `eslint-disable-next-line react-hooks/exhaustive-deps`
  as one of "three legitimate fixes, in order of preference," with a
  concrete example of writing the comment. The fail criterion is explicit
  that mentioning eslint-disable "only as a caveat or aside without a
  concrete named-dependency fix alongside it" does NOT fail — this answer
  goes further than that: it recommends the disable comment as an actual
  usable option, which the fail criterion's own wording (and the skill's
  entire purpose — never recommend silencing the rule) squarely covers.
  Correct judge verdict.
- **Trial 4** asked the user to paste their `useEffect` code before giving a
  fix, rather than delivering the concrete illustrative example pass
  criterion 1 explicitly says is required "when the prompt itself shows no
  code." It never explained the staleness consequence either (pass
  criterion 2). Correct judge verdict — a promise to fix, once given more
  info, is not a fix.

Both failures are genuine answer defects, correctly caught by a rubric that
already distinguishes "warns against eslint-disable" (allowed) from
"presents eslint-disable as a usable option" (fails) — exactly the
distinction flow 316's AC9 regrade (journal T13) showed the new judge gets
right where the OLD regex grader could not. No scenario/rubric defect found.
Left unchanged. This is the honest result: react's pack stays experimental
for `no-disable-hooks-lint` until a higher trial count (FU4, FU7) shows
whether 3/5 was a real ~60% rate or noise around the 0.8 floor — the fix for
"unlucky trials" is more trials, not a rubric edit.

