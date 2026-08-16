# Tasks

Task definitions live here; task **statuses** live in flow.json and are managed
only via `keryx flow task done <id> <taskId>`.

| ID | Kind | Title |
|----|------|-------|
| T1 | context | Confirm current touch points in slate.ts target dir, proposal-lifecycle.ts, fwk-service.ts against live `main`-derived code |
| T2 | implement | Implement `src/session/slate.ts` skeleton, SLATE-12 evidence scan, SLATE-14 comment fix, SLATE-3 fwk-service try/catch |
| T3 | test | Add/adjust tests: slate.ts lock-RMW race + archive-on-close; proposal-lifecycle security.gate real-scan (clean + secret/PII cases); fwk-service flow-read failure → unbound |
| T4 | review | code-verifier + review-orchestrator; remediate findings |
| T5 | implement | Fix finding 1+4: scanEvidenceSecurityGate fail-open on platform-unavailable read; replace detectSecrets/detectPii with guardOutput() |
| T6 | implement | Fix finding 3: close TOCTOU window between security gate scan and writeFileAtomic in proposal-lifecycle create() |
| T7 | implement | Fix finding 2: narrow fwk-service.ts local flow-read catch so access_denied propagates as full denial, not partial unbound disclosure |
| T8 | implement | Add regression tests for all 4 findings and verify typecheck/tests/health |
