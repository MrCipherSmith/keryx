# Implementation Plan

Status: pending user confirmation before code

## Approach

Use a small runtime module for managed review packages, then expose it through a
minimal CLI surface and skill documentation. Keep Task Manager state ownership
unchanged: managed review may read flow metadata and write review artifacts, but
must not update `.metaproject/flows/*/flow.json` directly.

Proposed stable CLI surface:

- `keryx review attach --flow <id> --target <kind> --ref <ref>`
- `keryx review start --target <kind> --ref <ref>`
- `keryx review ingest --report <path> [--flow <id>]`
- `keryx review status <review-id-or-path>`
- `keryx review complete <review-id-or-path>`

The corresponding skill modes remain:
`lightweight | attach-review | review-flow | ingest`.

## Steps

1. Add managed review domain types and manifest validation based on
   `docs/requirements/managed-review-feedback-loop/schemas/managed-review-package.schema.json`.
2. Add related flow discovery that resolves explicit flow id, PR URL, issue URL,
   and branch metadata without mutating flow state.
3. Add package writer for required artifacts:
   `manifest.json`, `scope.md`, `coverage.md`, `report.md`, `findings.json`,
   `learning.md`, and `decisions.md`.
4. Add attach-review mode that writes under
   `.metaproject/flows/<flow-dir>/reviews/<review-id>/`.
5. Add review-flow mode that writes under `.metaproject/reviews/<review-id>/`.
6. Add ingest mode that turns an existing report into normalized findings,
   decisions, classifications, and learning handoff.
7. Preserve lightweight mode as report-only behavior with no review package
   creation.
8. Update review-orchestrator skill/bundled docs to describe managed mode,
   reviewer coverage, classification, and learning handoff.
9. Add runtime tests for flow matching, artifact creation, manifest schema
   validation, attach-review, review-flow, ingest, lightweight mode, and no
   direct `flow.json` mutation.
10. Run focused tests, full project check, code-verifier, and then
    review-orchestrator with managed review coverage.

## Risks

- CLI naming can sprawl. Mitigation: keep one `review` command with five
  subcommands and no hidden flow mutation.
- Review package logic can duplicate Task Manager ownership. Mitigation: read
  flow metadata and write review artifacts only; all flow status changes remain
  in `flow` CLI/service.
- Lightweight mode can regress if managed mode becomes default everywhere.
  Mitigation: explicit tests assert no artifacts are written in lightweight
  mode.
- Schema drift between docs and runtime can occur. Mitigation: runtime tests use
  the docpack schema as the validation source.
