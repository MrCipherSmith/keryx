# Managed work frontend

Project-scoped work UI alongside legacy Flows and machine-v2. The live adapter calls `/hub/work/v1/projects/{projectId}` through the shared authenticated client. Demo is explicitly selected and isolated; failed live reads never substitute fixture data.

## Boundaries

- `types.ts`, `domain-schema.json`, `command-schema.json`: local DTO/schema copies from the reviewed work-management package v0.1.1. Align with backend `src/hub/work/model.ts` and its HTTP contract before changing them. No runtime backend imports.
- `adapter.ts`, `validation.ts`: capability decoding, schema validation, complete bounded snapshot staging, exact command identity and receipt reconciliation.
- `operation.tsx`: per-principal/project/mode command recovery. Unknown outcomes retain the original operation and prohibit a new mutation; lookup errors never imply definite rejection.
- `model.ts`: exact-record selection and conservative acceptance eligibility. Contributor evidence is explicitly attributed; passing coverage is separate from human acceptance.
- `contribute.tsx`: requirements setup, context declaration, manual/agent attempt metadata, Git/document/report results, contributor evidence and sealed submission.
- `flow-review.tsx`: server acceptance preview and distinct human Flow decision.
- `view.tsx`, `work.css`: focused project workspace, competing attempts, context and immutable decision history in both themes and locales.

## Verification

2026-11-01: real local backend fixture18791 through Vite8775. Flow→Intent→frozen composition→explicit human requirements approval→manual Attempt→exact Git result→contributor Evidence→Submission→human selection→Intent acceptance→server Flow manifest→Flow acceptance passed through browser forms. This used synthetic local records and dummy credentials, with no external Git action.

Desktop1280 and375px × RU/EN × light/dark were checked. Document scroll width equals viewport in all8 combinations. Flow deep link survives reload. Screenshots and integration handoff are under `output/design/hub-work-management-*` in the worktree.

Tests cover capability absence, explicit demo, agent authority, immutable exact subject coverage, cross-project/mixed-cursor snapshots, header/body operation identity, version guards and unknown-outcome recovery without repeating a mutation.

## Second increment

Human criterion waivers are explicit overlays with individual reasons and immutable Evidence. Requirement proposals retain stable criterion IDs; authorized whole-set amendment manifests expose full semantic replacements, can be approved or withdrawn, and never carry previous acceptance forward. Pending amendments block affected work. Complete Flow/Intent requirement review panels expose all material fields before human approval.

Work events poll using independent opaque cursors with bounded backoff and canonical invalidation. Overview attention is project-authorized, bounded to8 projects per page, with separate cursors and exact project/Flow/Intent/Attempt deep links. Unknown operation identity survives navigation; a prepared decision cannot cross Flow routes.

Git observation refresh/history separates object availability, PR head drift, CI provenance and immutable reviewed subjects; pending observation operations reconcile without repeating provider mutation. Legacy conversion is human-only, capability-gated and requires the exact durable source preview plus an explicit new deliverable. Exact archived document content never falls back to latest.

## Current limits

Native managed Attempt selection in the existing v2 composer is a separate integration increment. Controller/ad-hoc consent/lease behavior remains unchanged; no machine binding is fabricated by this UI. Git observer configuration remains administrator-owned; the UI only reads and refreshes permitted metadata. A result form accepts one immutable artifact; the domain supports multi-artifact subjects. No deployment has been performed.
