# Candidate implementation status
Version: 0.2.0

Status: verified candidate on feat-hub-work-management, base main0.4.1. UI lane feat-hub-workspace-design. No production release or product acceptance is claimed here.

The owner explicitly requested autonomous backend/UI implementation after reviewing the documentation. Local Task Manager Flow480 records implementation tasks; it is separate from remote Hub product Flows and their protected human transitions.

## Working candidate

- Closed immutable Flow/Intent revisions, ContextSnapshots, ResultSubjects, Evidence, submissions and Decisions; mutable aggregate versions with CAS and scoped idempotency.
- Human requirement approval, selection, Intent/Flow acceptance and criterion waiver overlays; changed work uses successor Attempts and whole-set requirement amendments.
- Same-database additive SQLite records/events/receipts/outbox/archive, durable replay, scoped event/snapshot cursors, bounded bodies and current authentication before replay.
- Default-disabled managed work configuration, existing session/SSO authorization, scoped/read-only contributor credentials, known credential material rejection before persistence.
- Native v2 original-admission sidecar reservations, exact run association and honest unverified runtime context.
- Explicit idle legacy preview/conversion with old-path write guards. First committed managed write raises the existing minimum writer marker to3; original0.4.x binaries reject startup. This marker does not change the frozen machine wire protocol. Before activation the marker stays2. Backups preserve both legacy and managed tables.
- Read-only configured Git repository/commit/PR/CI observations, append-only history, exact policy/SHA checks and explicit refresh. No webhook/background observer scheduler or automatic work acceptance.
- Shared keryx hub work CLI and contributor/read MCP tools, excluding protected human transitions.
- Bounded tab-scoped original-request recovery, explicit receipt/original retry, identity isolation and logout cleanup; unresolved retries retain uncertainty even on a later authority refusal. No automatic human decisions or general offline queue.
- Integrated React managed-work UI alongside existing machines/session cockpit. Core manual/Git-only lifecycle has passed a real local browser trial; advanced UI and native message association have also been integrated and independently reviewed.

## Verification boundaries

Individual test counts are snapshots during parallel edits, not a final aggregate certificate. The final quality report must cover exact integrated source, untracked files, generated web assets, backend and UI tests, packaging and independent review. Earlier documentation-only verification is not implementation proof. Tests use isolated temporary databases, local synthetic principals and a fake Git provider; no production credentials or live GitHub readiness are asserted.

Initial independent review reproduced lifecycle/admission gaps despite green earlier tests. They were corrected RED→GREEN and re-reviewed; the final reviewed backend/UI source has no unresolved blocker/major findings. This is code review approval, not owner product acceptance. Product acceptance remains the owner's explicit action.

## Test operator entry point

The coordinator's local synthetic trial is started with bun --no-env-file scripts/smoke/team-hub-work.ts --fresh 18792. It binds loopback only and creates disposable data, a project and clearly synthetic credentials. It is a development fixture, not a production deployment script. Production uses the existing Hub configuration/Cloudflare session path plus explicitly enabled work configuration and repository registry; setup/rollback instructions are supplied in docs/handoffs/hub-work-management-runbook.md and the candidate result handoff.
