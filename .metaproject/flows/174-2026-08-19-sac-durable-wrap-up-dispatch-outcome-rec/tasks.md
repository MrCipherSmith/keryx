# Tasks

Task definitions live here; task **statuses** live in flow.json and are managed
only via `keryx flow task done <id> <taskId>`.

| ID | Kind | Title |
|----|------|-------|
| T1 | context | Collect remaining context — already satisfied by the prd-creator/trd-creator investigation in `docs/requirements/keryx-sac-wrapup-dispatch-outcome/`; mark done immediately with a journal note. |
| T2 | implement | Implement per TRD §1.3-§1.6: `writeWrapUpOutcomeArtifact` in `machine-wrap-up.ts`, `readNewestWrapUpOutcome` + `classifySession` insertion in `catch-up.ts`, `wrapUpOutcome` field on `CatchUpUnknownItem`, render branch in `review-inspector.ts` — plus unit tests in all three matching test files (tests are part of this task, not a separate addendum, per TRD §7). |
| T3 | test | Confirm the full suite (typecheck + `bun test`) passes including the new tests added in T2 — a distinct verification pass, not new test authorship. |
| T4 | review | Run `code-verifier` then `review-orchestrator` on the diff, fix any findings, prepare the PR. |
