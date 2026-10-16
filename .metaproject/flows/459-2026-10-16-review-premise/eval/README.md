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
