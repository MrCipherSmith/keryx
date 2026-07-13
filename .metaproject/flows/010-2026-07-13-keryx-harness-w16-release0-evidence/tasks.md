# Tasks — Flow 010 (W16 Release 0 evidence)

Task definitions live here; task **statuses** live in flow.json and are managed
only via `keryx flow task done <id> <taskId>`.

Scope: **only W16 at the Release 0 boundary** — docs + reviews. NO runtime code /
test changes. Worktree-guard in every worker.

| ID | Kind | Model | Title / definition |
|----|------|-------|--------------------|
| T1 | context | Haiku | W1–W7 inventory + evidence-matrix skeleton (context.md). |
| T2 | implement | — | Umbrella: docs/reviews per plan (closed when T5+T7 done). |
| T3 | test | — | Umbrella: no test changes; closed with T8 (suite stays 797/0). |
| T4 | review | — | Umbrella: self-review + completion prep (closed when T8 + completion done). |
| T5 | docs (E-01) | Sonnet | `docs/decisions/keryx-harness/E-01-release0-evidence-matrix.md` (capability → implemented/planned/deferred + source path + test file + commit) + update `research-ledger.md` (R0 findings/OPEN) + migration-notes + update `decision-registry.md` (package index). Mark the 2 deferred scenarios. Frozen requirements pkg untouched. |
| T6 | review (E-02) | Opus | `docs/decisions/keryx-harness/E-02-release0-review-package.md` — independent 7-lens review of the Release 0 slice (architecture/contract/logic/security/testing-replay/performance/Gherkin), normalized, severity-ranked (BLOCKER/P0/P1/P2/P3). Per-wave reviews untouched. Explicit verdict on BLOCKER/P0/P1. |
| T7 | docs (E-03) | Sonnet | promote roadmap/package + `docs/decisions/keryx-harness/flow-orchestrator-handoff.md` (DAG + frozen AC proposal + gates + constraints + out-of-scope + deferred) — created ONLY if E-02 has no BLOCKER/P0/P1 (else document why + what to fix). |
| T8 | review | Opus | verify: git shows NO `src/**`/test change (docs-only); `bun test` 797/0; `tsc` clean; deps `{}`; frozen requirements pkg + ADR-0001…0004 untouched; every matrix row resolves to a real file/test/commit; handoff complete + correctly gated. |
