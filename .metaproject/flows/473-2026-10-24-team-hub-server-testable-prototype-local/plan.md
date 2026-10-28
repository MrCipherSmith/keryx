# Execution plan

Authorization: autonomous prototype implementation, documentation and subagents, user message 2026-10-25. Routine implementation choices resolved here; no repeated permission gates. Optional execution metrics stay disabled per existing user preference. Base main; implementation branch codex/team-hub-prototype; verified handoff selected by requested testable deliverable, no unsolicited PR/merge/deployment.

1. T1: specification, source-backed context, exact API/contracts and RED acceptance tests.
2. T2/T5/T6: isolated file ownership — server/domain; Web; connector/Git delivery. Parent owns CLI Flow changes and all commits. Workers do not commit.
3. T3: make meaningful state/authorization/version/recovery tests pass.
4. T7: packaging, Linux/Docker runbook, smoke script and release archive.
5. T8: actual live browser two-role journey and two-checkout/restart/Git integration checks.
6. T9: code-verifier quality gate.
7. T4: independent review and bounded root-cause fix rounds, final handoff/report. No feature growth after first green unless a requirement remains unmet.

Full state × event matrix and ACs are in docs/requirements/team-hub-prototype/specification.md. Loading/navigation ignores stale responses; network errors preserve data/drafts and remain visible; version conflicts do not become optimistic success; mutations retry the same idempotency key; role guard is server-side.

No atomicity claim spanning SQLite, Git filesystem, remote push and browser. Receipts and explicit error/reconcile states are required. Local dirty/staged/diverged cases may refuse auto-apply rather than risk data loss. External publication tests use temporary bare remotes only.

Verification: bun:test with real temp SQLite/files/Git, full project typecheck/build, scoped lint plus baseline separation, browser automation, actual direct Hub startup and restart. Docker CLI exists but daemon was unavailable at planning; attempt container validation if available, otherwise explicitly report its limit. Source/direct bundle remain a testable deployment path.
