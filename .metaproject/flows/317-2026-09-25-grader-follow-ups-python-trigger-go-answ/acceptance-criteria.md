# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: `python-implementation`'s trigger accuracy is diagnosed with an offline
  trigger-only probe; if fixed, the fix is to SKILL.md frontmatter (never the
  eval prompt) and a full bundled-catalog trigger-only run shows no
  regression elsewhere.
- AC2: `buildEvalRunner` sends a uniform "answer in text; do not call tools"
  system note on every eval run; the report records a `runnerPromptVersion`
  the pack gate binds against; `no-sleep-sync`'s timeout/sleep handling is
  reviewed and fixed only if a genuine defect is found.
- AC3: `keryx skills eval --reverify <pack> [--sample N]` exists, re-judges a
  random sample of recorded trials live, reports disagreements, exits
  non-zero above a documented threshold, has unit tests against a stub judge,
  and is documented in the CLI reference's threat-model section.
- AC4: `PACK_MIN_TRIALS` is 10 with documented reasoning; a regression test
  proves an old 5-trial report still fails the gate after the bump.
- AC5: `no-disable-hooks-lint` (react) is checked against recorded outputs for
  a scenario/rubric defect; fixed only if one is found, otherwise left alone
  with the honest result recorded.
- AC6: the getter-accessor known-right variant is added to
  `nodejs-build-fix#no-ts-ignore-suppression`'s calibration if the schema
  supports multiple known-right answers, otherwise noted in the rubric.
- AC7: calibration is re-recorded for every touched scenario
  (`judge-check --samples 3 --record`) until anti-gaming is green; an honest
  gate run over all 18 skills at trials=10 is completed; `governance/eval.json`
  is rebuilt from raw outputs only; stack-pack stability and generated agent
  pairs are updated to match; W1/W2 docs, the CLI reference, the guide and
  this flow's own ACs reflect the new state.
- AC8: no SKILL.md or grader is edited solely to make a run pass; every
  rubric/calibration change is justified in journal.md with recorded evidence.
- AC9: PR merged into feat/agent-platform-expansion with review clean at the
  minor threshold (<=3 rounds) and CI green.
