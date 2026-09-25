# Implementation Plan

Status: active

## Approach

Seven independent-ish fixes, each landed as its own commit (task boundary),
each backed by evidence before any grader/rubric text is touched. No SKILL.md
or grader is edited to force a pass. Order: cheap/independent fixes first
(T1-T2 frontmatter+runner), then the sampler CLI (T3, needs unit tests with a
stub judge), then PACK_MIN_TRIALS bump (T4), then the two diagnostic-only
items (T5 react, T6 calibration), then the honest re-run + eval.json rebuild +
docs/CLI-reference/agent-pair regeneration (T7).

## Steps

1. **T1 Python trigger.** Diagnose `python-implementation` trigger-positive-6
   (6/7) with an offline trigger-only probe (`scoreTriggerScenarios` /
   `keryx skills eval ... --scope bundled`, no runner/judge). If the
   description/triggers under-describe the skill, fix SKILL.md frontmatter
   (never the eval prompt). Prove no regression across the whole bundled
   catalog's trigger accuracy (full trigger-only run, before/after).
2. **T2 Go answer-in-text.** Add a runner-level system note in
   `buildEvalRunner` ("answer in text; do not call tools") appended after
   `skill.body`, applied uniformly, stamped on the report as
   `runnerPromptVersion` and bound by the pack gate
   (`checkSkillReportForPackGate`) the same way `judgePromptVersion` already
   is. Re-check `no-sleep-sync`'s timeout-vs-sleep handling; fix only if
   defective (own finding, not assumed).
3. **T3 Live re-judge sampler.** `bun ./src/cli.ts skills eval --reverify <pack>
   [--sample N]`: re-judges a random sample of a pack's recorded
   `trialRecords` live against the allowlisted judge, reports disagreements,
   exits non-zero above a documented threshold. Unit tests with a stub judge
   (deterministic, offline). Document in the threat-model section of the CLI
   reference.
4. **T4 Promotion trials.** `PACK_MIN_TRIALS` 5 -> 10, with the reasoning
   documented (several scenarios sit exactly at 0.8 with 5 trials — a floor
   observation, not noise). Old 5-trial reports must still fail the gate
   after the bump (regression test).
5. **T5 React.** Check whether `no-disable-hooks-lint` (3/5) is a scenario or
   rubric defect using the round-1 recorded outputs, same method as journal
   T13's diagnosis of the other 3 pack failures. Fix only if defective; if the
   scenario is fine, leave it and record that as the honest result.
6. **T6 Calibration.** Add the getter-based known-right variant the round-2
   reviewer found (R2-1, `nodejs-build-fix#no-ts-ignore-suppression`) if the
   calibration schema allows more than one known-right; otherwise note it in
   the rubric text instead of forcing the schema.
7. **T7 Re-record and re-run.** Re-record calibration (`judge-check --samples 3
   --record`) for every scenario touched by T1/T2/T5/T6, until anti-gaming is
   fully green. Then run an honest gate over all 18 skills at trials=10.
   Rebuild `governance/eval.json` from raw outputs only (no hand edits).
   Apply pack stability; regenerate or delete agent pairs
   (`agents generate --stack <id>`). Update W1/W2 docs, CLI reference, guide,
   ACs to match.

## Design contract (binding for every step)

- Never edit a SKILL.md or a grader to make a run pass.
- A rubric/calibration/prompt fix is allowed only when the SCENARIO is
  defective (impossible ask, or grades wording not behaviour) — justify with
  recorded evidence in journal.md, same standard flow 316 applied.
- Gate stays DeepSeek deepseek:deepseek-chat, strictness high, scope bundled,
  floor 0.8.
- Model "sonnet" for every worker/reviewer (opus rate-limited until
  2026-09-29); adversarial reviewer explicitly told to be thorough.
- Merge threshold minor, <=3 review/fix attempts; 0 blocker/0 major -> merge
  per owner standing rule, remaining minors recorded as deferred
  ("decided-by: MrCipherSmith (owner, in chat), standing rule").

## Risks

- T3's sampler needs a stub judge seam that mirrors `SkillsGovernanceDeps` —
  reuse rather than invent a second injection point.
- T4's trials=10 bump makes the honest re-run in T7 the long pole (18 skills x
  10 trials, live DeepSeek calls) — budget time/spend accordingly.
- T1/T5/T6 must each end in either "fixed, evidence X" or "left alone,
  evidence Y" — no silent skip.
