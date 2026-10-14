# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- Every criterion ends with [verify: exec `<command>`],
  [verify: invariant `<command>`], [verify: judged] or
  [verify: none — <reason>].
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: `keryx review complete` on a PR-bound package compares the reviewed head with the PR head and state; when the PR is merged or the head moved, it refuses unless the report's first line names the reviewed SHA and says so. A package with no PR binding is unaffected. [verify: exec `bun test src/review/complete-head-gate.test.ts`]
- AC2: The report has a required evidence-level field: `static only` plus the list of what did not run, or the list of what ran. `complete` refuses a report without it, and a package ingested before this field existed completes with a warning, not a refusal. [verify: exec `bun test src/review/evidence-level.test.ts`]
- AC3: When an author rebuttal in a finding cites a rule or document, `review ingest` looks it up in the tree and, if it does not exist, adds a "citation not found" line to the finding; it never deletes the finding. [verify: exec `bun test src/review/rebuttal-citation.test.ts`]
- AC4: A finding can carry the disposition `narrowed` with a "what remains" text; the ledger treats it as closed only when that text is present, and the report keeps it with its evidence. [verify: exec `bun test src/review/ledger-narrowed.test.ts`]
- AC5: `review ingest` checks that a finding's quote is at its `path:line` at the reviewed SHA (not the working tree) and refuses a locator that does not resolve there; the report template links the blob at that SHA. [verify: exec `bun test src/review/ingest-locator-sha.test.ts`]
- AC6: The review-orchestrator skill gains at most four lines (one per AC1 to AC5 gate, pointing at the command) and stays under the skill-length ceiling. [verify: exec `bun test src/gdskills/skill-length.test.ts`]
- AC7: `bun run check` passes, the README review section and docs site describe the new gates, and the CHANGELOG `[Unreleased]` names them. [verify: exec `bun run check`]
