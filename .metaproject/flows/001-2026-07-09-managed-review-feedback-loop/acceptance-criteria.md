# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: Runtime supports `attach-review` for an explicit flow id and for a PR URL matched from existing flow metadata.
- AC2: Runtime supports standalone `review-flow` package creation under `.metaproject/reviews/<review-id>/`.
- AC3: Runtime supports `ingest` of an existing review report and writes classified findings and learning decisions.
- AC4: Every managed review package writes `manifest.json`, `scope.md`, `coverage.md`, `report.md`, `findings.json`, `learning.md`, and `decisions.md`.
- AC5: Managed review manifest validation uses the docpack schema and rejects missing required artifacts or invalid modes.
- AC6: Coverage records every selected, skipped, failed, or context-starved reviewer with a reason.
- AC7: `learning.md` is always present and contains either `Skill Learning` candidates or `none`.
- AC8: Lightweight review mode remains report-only and creates no flow or managed review artifacts.
- AC9: Runtime tests cover flow matching, artifact creation, schema validation, attach-review, review-flow, ingest, lightweight mode, and no direct `flow.json` mutation.
- AC10: Managed review implementation does not mutate `.metaproject/flows/*/flow.json` directly; Task Manager state changes remain owned by `keryx flow`.
- AC11: Post-implementation verification runs focused tests, full check, code-verifier, and review-orchestrator with managed review coverage before the flow can be marked implemented.
