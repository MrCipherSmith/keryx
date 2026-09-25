# Review round 2 — PR #698 (structured)

Source: review-r2.md

```keryx:findings
[
  {"id":"R2-1","reviewer":"review-orchestrator","severity":"info","problem":"A live attack (TS getter accessor for `total`) passed the judge 3/3; on inspection it appears to be a legitimate third fix the calibration set didn't anticipate, not a leniency bug.","impact":"None demonstrated — the rubric's own text allows this shape. Left as a follow-up to broaden calibration coverage, not a defect.","suggested_fix":"Optionally add a third known_right-equivalent naming the getter-accessor form so future prompt/rubric edits are tested against it too.","evidence":"scratchpad/f316/review2/results.json, 'NEW: plausible-wrong-ts', 3/3 pass with judge reasons citing the concrete added declaration.","confidence":"medium","file":"src/gdskills/bundled/stacks/ts-js-node/skills/nodejs-build-fix/evals.json","line":43},
  {"id":"R2-2","reviewer":"review-orchestrator","severity":"minor","problem":"recordedJudge (offline AG replay) does not reject a JudgeRecordingSample carrying both `error` and `verdict:\"pass\"`, unlike regradeRecordedReport (R1-8) and judge-check's own mismatch check.","impact":"A hand-edited judge-recordings/*.json file could replay a manufactured error+pass sample as a clean AG pass offline. Already covered by the disclosed 'recordings are hand-writable/self-declared' threat model (cli-reference.md:2464), so no new provenance claim is broken, but it is an inconsistency between three enforcement points that should agree.","suggested_fix":"Add the same guard used in regradeRecordedReport to recordedJudge (or a validateJudgeRecordingFile applied before use): reject sample.error !== undefined && sample.verdict === \"pass\".","evidence":"scratchpad/f316/review2/ag2.ts output: 'error-sample known-right: passed = true (EXPECT false/fail)'.","confidence":"high","file":"src/gdskills/governance/judge-recordings.ts","line":204}
]
```
