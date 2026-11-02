# Implementation plan: understandable Hub acceptance
Version: 0.1.1

Status: planned. No runtime changes, deployment or acceptance are authorized by creating this package/Flow. Owner reviews and approves requirements before implementation.

## Delivery sequence

1. Pin the approved specification and criterion identities. Build disposable fixtures for canonical Intent/aggregate review, legacy pending/done/no-guide, conflicting/missing evidence and a returned/resubmitted result. Do not mutate the real completed hub-status Flow.
2. Implement/verify immutable review-guide validation using existing document/subject and legacy bundle artifacts. Add schema fixtures for limits, duplicates, bad refs and cross-project use. Preserve contributor provenance.
3. Add the legacy commented return and its receipt/audit/minimum-writer migration guards; prove rollback/retry/concurrent reviewer behavior before UI integration. Reuse canonical review decisions unchanged where possible.
4. Build shared presentation with domain-specific adapters: narrative, guide, criterion rows, decision area and collapsed technical details. Keep eligibility server-owned and draft state explicitly scoped.
5. Add RU/EN, responsive375px and keyboard/focus behavior. Wire Overview/Flow/Intent deep links and refresh/receipt convergence.
6. Run contract, integration, component and browser gates on the exact candidate. Independent review then owner acceptance; release/deployment are separate owner-authorized work.

## Verification matrix

| Scope | Required proof |
|---|---|
| AC1–AC5 | Real HTTP projections and UI tests, no-guide/unmapped legacy fixtures, contributor-vs-observed provenance, safe inert commands |
| AC6–AC9 | Direct API human/agent/machine/cross-project/refusal tests, blank return comments, immutable history, simultaneous accept/return, exact same-key replay, changed-payload conflict, lost-response receipts |
| AC10–AC12 | Offline/revocation/conflict recovery, scoped comment drafts, RU/EN component and real375px keyboard/browser checks |
| AC13 | Two full disposable live-data journeys, not just demo receipts |
| AC14 | Schema checks, migration rehearsal and old-writer refusal on copied fixtures, changed-scope lint/types, related regression tests and independent review |

Use project-local testing context and `keryx test related` to select actual test files. Existing baseline checks include `bun run check:hub-web`; new API/schema/legacy-return tests are created during implementation and are not claimed to exist now.

## Submission requirements

Provide immutable exact-candidate artifacts, the actual test commands/counts, explicit provenance and safe verification steps. Attach the guide before sealing the result. Missing/failed/unrun checks remain visible. Product acceptance, Git publication and tool approval stay separate.
