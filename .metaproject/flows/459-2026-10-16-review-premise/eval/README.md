# Flow 459 evaluation (AC7)

Live run, judge = `review-premise` on Opus, one fresh subagent per input set, prompt = SKILL.md path + repo path + findings path only.

| Set | Finding | Verdict | Pass |
|---|---|---|---|
| fixture (#7849 analogue) | F1 timeline pinned LTR (major) | challenged, 6 intent signals, 2 practice sources (Material, Apple HIG) | yes |
| fixture | C1 wheel seek ignores scrollLeft | upheld | yes |
| fixture | C2 resize listener not removed | upheld | yes |
| fixture | C3 icon-only button, no name | upheld | yes |
| #1005 @ f5d3385f | F-066 | upheld | yes |
| #1005 | F-067 | upheld | yes |
| #992 @ d9ccfb6c | F-007, F-008 | upheld | yes |
| #992 | F-009, F-011, F-012 | downgraded major -> minor | MISS |

Dispatches 1 per set (3 total). Subagent tokens: fixture 70,419 / #1005 74,684 / #992 80,772.
All three claims files parse and merge with `parsePremiseClaims` + `mergePremises` (`inputs/validate.ts`, outputs `validate-*.json`): 11 claims applied, 0 rejected.

## Reading

- The headline case works: F1 is held with cited intent and practice, and no real or truth finding is challenged or held (AC7 as worded is met).
- Strictly (a downgrade of a truth finding is a miss) three of the seven #992/#1005 truth findings were downgraded. All three are test-coverage-gap findings (surviving mutants, no runtime defect) that the judge re-graded minor using the canonical severity rubric. It never held them, so none would be blocked from a fix loop; they only drop out of the major count. Whether that is a defect is an owner call: the downgrade is rubric-consistent, but it is outside the premise-judge's brief (is it a defect at all).

Files: `judge-*.raw.md` (raw outputs), `premise-eval.json`, `validate-*.json`, `inputs/` (findings, validate.ts, fixture.bundle: `git clone` it to reproduce the repo).
Caveats: the truth findings carry no `title`; the #1005/#992 checkouts contain round-1 review packages (as any real repo would); fixture findings were authored by the evaluator.

## Rerun on #992 after the fix (commit f41a21612)

Fix: a `downgraded` claim needs a cited intent signal or practice source (`downgrade-without-evidence` otherwise); the skill forbids rubric re-grades and its worked example no longer teaches one. Same prompt shape, fresh Opus judge (86,933 subagent tokens), raw output `judge-pr992-rerun.raw.md`.

| Finding | Verdict | Reading |
|---|---|---|
| F-007, F-008, F-011 | upheld | pass (F-011 was a rubric downgrade before; fixed) |
| F-009 | downgraded major -> minor, 2 intent signals (commit d9ccfb6ce, `test-preload-hooks.ts:4`) + 2 practice sources (Bun preload hooks, xUnit fresh fixture) | stays at the fix-loop threshold (minor); the judge argues the reset is deliberate standard isolation and does not hide F-007 "by construction" |
| F-012 | challenged, held for the operator | the judge argues M10 is an equivalent mutant (every read checks the spelled key, which equals the exact hash for non-shell calls) and that the suggested test cannot kill it; the finding itself said "may be partly equivalent", confidence medium |

Net on 10 controls: 8 upheld, 1 downgraded with cited evidence (still minor, still fixed), 1 held as an operator question (not dismissed). Strict AC7 ("challenges none of the truth findings") is not met for F-012; whether this hold is a defect or the intended behaviour is the owner's judgement (AC7 is `judged`).
