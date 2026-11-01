# Hub work management: shared context, execution history and acceptance
Version: 0.2.0

Status: implementation candidate in progress; final verification/review and owner product acceptance pending. Date: 2026-11-01. The owner requested this PRD/specification/plan and a parallel UI-agent brief. Owner subsequently authorized implementation; remote human-only acceptance remains separate.

## Purpose

Build the missing product-work layer over Keryx0.4.0 remote execution: Flow → Intent → Attempt → Evidence → Decision. Preserve shared project knowledge and exact historical context; keep source code, branches, PRs and merges in Git/GitHub. Do not build a second code-exchange system.

## Documents

- [Candidate implementation status](implementation-status.md)
- [Native execution binding](execution.md)
- [Git/CI observations](observer.md)
- [PRD](prd.md)
- [Normative implementation specification](specification.md)
- [HTTP, metadata and execution protocol](metadata-protocol.md)
- [Migration and compatibility](migration.md)
- [Implementation and verification plan](plan.md)
- [Baseline evidence and design decisions](decisions.md)
- [Parallel UI/designer assignment](ui-agent-prompt.md)
- [Documentation verification record](verification.md)
- [Independent documentation review](review.md)
- [Generated OpenAPI contract](openapi.json)
- [Domain JSON Schema](schemas/domain.schema.json)
- [Mutation JSON Schema](schemas/command.schema.json)
- [Event JSON Schema](schemas/event.schema.json)
- [Schema examples](schemas/examples.json)
- [Reproducible documentation/schema verifier](verify.cjs)

## Scope

Managed work metadata and optional code/document result references; Git-native and document-only work; immutable specification/context/result versions; explicit ownership, human review and change requests; execution associations over existing sessions/runs; incremental team history; compatible reads of existing records. First deployment remains single-process SQLite using existing Hub infrastructure; no mandatory PostgreSQL/S3/MinIO migration.

Non-goals: code synchronization, Git mirror expansion, conflict resolution engine, automatic PR creation/push/merge, remote credential setup, replacing agent lifecycle, a new CI runner, inventing historical Attempts, or silently changing frozen machine-v2 contracts. Optional bounded review attachments may reuse existing bundles; complete source snapshots are not required for new work acceptance.

## Implementation baseline

Baseline source: `origin/main` at `3dd6ac53f159c65a522f1db7e755268174bb1217`; published-version contract examined at tag `v0.4.0` (tag object `ae0d96b28af64599a27ca15b56895a07031c252a`, peeled commit `a8799ebe2`). Main is0.4.1; relevant Hub/session/machine directories had no diff against0.4.0 in the earlier check. Reverify before implementation. GitHub release-object API returned404 for v0.4.0 during evidence gathering; tag/changelog/source existence is confirmed, release asset publication was not independently established here.

Existing Hub has a simple `HubFlow`, CodeRevision-bound Evidence/acceptance and machine-v2 execution. New Intent/Attempt/ResultSubject/Decision records below are proposed, not claimed present. Worktree `codex/team-hub-prototype` is old and dirty; implementers must choose a current compatible checkout without destroying its changes.

Related: [remote sessions](../hub-remote-sessions/README.md), [session contract](../hub-remote-sessions/session-runtime.md), [prototype API](../team-hub-prototype/api.md), [context watch](../hub-context-watch/README.md), [MCP](../hub-mcp/README.md).

Owner discussion gates: Intent semantics (bounded deliverable within a Flow), lifecycle/authority matrix, Git-reference review policy, and historical migration must be reviewed before freeze. No owner response is fabricated by this draft.
