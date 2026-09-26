# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: `src/gdskills/bundled/skills/orchestration/flow-orchestrator/SKILL.md` and `src/gdskills/bundled/skills/orchestration/job-orchestrator/SKILL.md` each contain a line naming `review.jev.edit_guard` and `keryx review jev-edit-guard` before their task-implementer dispatch instructions.
- AC2: `src/gdskills/bundled/skills/orchestration/flow-orchestrator/SKILL.md` (PR review/fix loop) and `src/gdskills/bundled/skills/orchestration/job-orchestrator/SKILL.md` (Error Table) each contain a line naming `review.jev.ci_triage` and `keryx review ci-triage` with the flaky/real-regression/infra classification.
- AC3: `src/gdskills/bundled/skills/orchestration/task-implementer/SKILL.md` contains a Rules-of-Engagement item referencing `Rule check flagged:` tool results.
- AC4: `src/gdskills/bundled/skills/orchestration/code-verifier/SKILL.md` contains a Phase 2 step naming `review.jev.ci_triage` before filing a red GitHub CI check as a finding.
- AC5: every file touched under `src/gdskills/bundled/skills/orchestration/**` has a byte-identical mirror at the corresponding `.metaproject/skills/gdskills/orchestration/**` path (`diff -q` empty).
- AC6: `bun test src/gdskills/` passes (line ceilings, catalog/evals, round-bound, build-parity, install), and no ceiling in `src/gdskills/skill-length-ceilings.ts` was raised above its value on `main`.
- AC7: `bun run lint` and `bun run typecheck` both pass with no errors.
- AC8: `docs/docs/guides/jev-in-the-delivery-loop.md` exists, is linked from `docs/docs/index.md`, states the measured numbers from the brief without naming the source project, and `README.md` links to it; `CHANGELOG.md` has an additive `## [Unreleased]` entry for this work.
- AC9: a PR from `feat/jev-delivery-loop` into `main` is open, its GitHub CI checks are green (a known-flaky job may be rerun at most once), and flow 345 is recorded against that PR and closed (`keryx flow implemented 345 --pr <url>`) without merging.
