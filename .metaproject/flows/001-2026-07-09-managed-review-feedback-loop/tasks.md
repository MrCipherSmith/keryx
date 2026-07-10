# Tasks

Task definitions live here; task **statuses** live in flow.json and are managed
only via `keryx flow task done <id> <taskId>`.

| ID | Kind | Title |
|----|------|-------|
| T1 | context | Collect remaining context |
| T2 | implement | Implement per plan |
| T3 | test | Add/adjust tests and make them pass |
| T4 | review | Self-review and prepare draft PR |
| T5 | context | Confirm managed review CLI surface and runtime boundaries before code |
| T6 | implement | Implement managed review data contracts and schema validation |
| T7 | implement | Implement related flow matching by explicit flow id, PR URL, issue URL, and branch |
| T8 | implement | Implement managed review artifact package creation without direct flow.json mutation |
| T9 | implement | Implement attach-review mode under existing flow review artifacts |
| T10 | implement | Implement ingest mode for existing review reports and finding classification |
| T11 | implement | Implement standalone review-flow mode under .metaproject/reviews |
| T12 | implement | Preserve lightweight review mode as report-only behavior |
| T13 | test | Add runtime tests for flow matching, artifact creation, schema validation, and no flow.json writes |
| T14 | test | Run focused tests, full check, and code-verifier before implementation acceptance |
| T15 | review | Run review-orchestrator with managed review coverage and resolve findings |
| T16 | docs | Update docs and completion evidence for managed review feedback loop |

## Acceptance Trace

- T5 gates the CLI naming question before runtime edits.
- T6-T8 establish shared contracts and artifact safety.
- T9-T12 cover every required mode: attach-review, ingest, review-flow, and
  lightweight.
- T13 is mandatory before any implementation can be considered done; it must
  cover attach-review, review-flow, ingest, flow matching, artifact creation,
  schema validation, and no direct `flow.json` mutation.
- T14-T15 are post-implementation gates: tests + code-verifier, then managed
  review coverage.
