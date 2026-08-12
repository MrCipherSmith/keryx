# Keryx Shared Agent Context — Implementation Plan
Version: 1.7.0

## Delivery status

As of 2026-08-13, Phases 0–5 and Phase 6a are implemented and merged into
`main`, released in `v0.2.32`. Phase 6 is split into **6a** — the runtime
enforcement guard (`resolvePolicySelection`), implemented and verified
(AC1–AC6, full SAC suite 88/88 green) — and **6b** — the real operator-data
readiness process, still planned. All acceptance and review work for phases
0–5 and 6a is complete; the temporary per-phase merge branches have been
deleted now that everything is on `main`.

| Phase | Status | Evidence |
| --- | --- | --- |
| 0 — Contract alignment | Implemented | Merged via PR #265; Flow completion commit `9b22203a` |
| 1 — Offline workspace registry | Implemented | Flow review commit `75e68cd6`; on `main` |
| 2 — FWK read path | Implemented | Merged via PR #269; on `main` |
| 3 — Proposal and review lifecycle | Implemented | Merged via PR #271; Flow completion commit `17cca58f` |
| 4 — Collaboration ergonomics | Implemented | Merged via PR #272; Flow completion commit `09769ef` |
| 5 — Opt-in policy experiment | Implemented | Merged via PR #273; Flow completion commit `883581a`; [phase-5 policy experiment report](phase-5-policy-experiment-report.md) |
| 6 — Opt-in readiness (6a runtime guard / 6b real-data readiness) | 6a Implemented · 6b Planned | 6a: runtime guard `resolvePolicySelection` in `src/sac/fwk-service.ts`; AC1–AC6 met; full SAC suite 88/88 green; merged via PR #277, released in `v0.2.32`. 6b: real operator-data readiness process still planned |

## Delivery rules

Every phase is a separate future Flow with frozen acceptance criteria, schema
fixtures, security review and health verification. No phase may claim runtime
delivery before its tests and target-module owners accept the contracts. UI,
remote sync and learned policy cannot bypass earlier exit gates.

## Phase 0 — Contract alignment — Implemented

- Confirm ownership boundaries with Context Operations, Flow, Harness, Wiki,
  Memory, MCP and Security maintainers.
- Adopt normative schemas, positive/negative fixtures, compatibility policy and
  typed-reference resolver contract.
- Define the server-created `ActorContext`, trusted local identity/role source,
  role-revision lookup and v1 MCP local-stdio trust boundary. Client-supplied
  actor IDs must be rejected as authorization inputs.
- Define the strict production egress/write guard used by SAC. Existing
  advisory/disabled behavior is not an eligible production guard.

**Exit:** all schemas validate; ownership matrix is accepted; no planned API
creates a parallel Flow or bypasses guarded writes; actor spoofing,
cross-workspace, revoked-role and TOCTOU test scenarios are approved.

## Phase 1 — Offline workspace registry — Implemented

- Implement future `WorkspaceService`: manifest CRUD, atomic persistence,
  activity events, typed resources and role checks.
- Add future CLI create/list/show/add-resource with no MCP mutations.
- Add fixture-based validation and disabled-floor regression tests.

**Exit:** AC-1, AC-7 (mutation portion) and AC-10 pass offline.

## Phase 2 — FWK read path — Implemented

- Implement Facts resolver, Flow-derived Work projection and accepted
  Know-how resolver through existing source facades.
- Implement overview limits, freshness/invalidation and AccessReceipt.
- Reuse the canonical Context Operations assembly/trace and correlation ID;
  record assembly/config revision, policy/config revision and selected/omitted
  item IDs rather than a second retrieval trace.
- Expose future read-only CLI/MCP adapters with normalized parity tests.

**Exit:** AC-2 through AC-6, AC-10 and AC-11 pass; no raw content appears in
receipts or derived context storage; missing mandatory context yields typed
`context_overflow` with no successful manifest, while partial results name only
omitted optional items.

## Phase 3 — Proposal and review lifecycle — Implemented

- Implement proposal construction from explicit session/Flow wrap-up output.
- Persist immutable `proposed` records and append-only transition events with
  idempotency, causal ordering and correlation IDs.
- Validate current reviewer authority, evidence/ACL freshness, exact security
  policy/version and target ownership before every transition; accept only after
  the owning guarded writer returns its target-write receipt.
- Test rejection, dismissal, stale, target-write failure, replay, actor
  spoofing, cross-workspace access, revoked role and TOCTOU paths.

**Exit:** AC-8 and AC-9 pass end-to-end with secret/PII/redaction fixtures.

## Phase 4 — Collaboration ergonomics

- Add worktree/session references, local activity feed and owner operations.
- Add optional TUI/IDE clients only as clients of stable CLI/MCP contracts.
- Conduct user evaluation on unfamiliar-component onboarding and handoff tasks.

**Exit:** usability report and no contract divergence between clients.

## Phase 5 — Policy experiment (optional)

- Build anonymised/minimised offline corpus from AccessReceipts and independent
  task verification outcomes. Each included receipt must be immutable or
  integrity-linked, point to an independent verifier/outcome reference and name
  its policy/config revision.
- Publish a corpus manifest with provenance, selection/redaction rules,
  quarantine criteria, holdout split and adversarial cases. Self-reported
  receipt outcome alone is not training or evaluation evidence.
- Compare candidate policy against deterministic baseline in a sandbox.
- Ship only opt-in experiment with version pin, kill switch and rollback test.

**Exit:** AC-12 plus published evaluation report. Without this exit, learned
policy remains absent from runtime.

Implementation evidence is published in the
[Phase 5 policy experiment report](phase-5-policy-experiment-report.md). The
committed corpus is synthetic mechanism evidence only; default configuration
keeps the learned candidate disabled and the kill switch active.

## Phase 6 — Opt-in readiness (6a runtime guard / 6b real-data readiness)

Full detail: [phase-6-real-opt-in-readiness.md](phase-6-real-opt-in-readiness.md).

### 6a — Runtime enforcement guard — Implemented

- Runtime binding `resolvePolicySelection` in `src/sac/fwk-service.ts` switches
  from deterministic baseline to candidate policy only when explicit config pins
  and the full fixed-order integrity chain (baseline → candidate → corpus →
  evaluation report → deterministic activation) succeed.
- Fail-closed to baseline on any error/mismatch; candidate off-by-default;
  kill-switch and `rollbackPolicyExperiment` enforced; no public CLI/MCP schema
  change.
- **Exit (met):** AC1–AC6; evidence `src/sac/fwk-service.test.ts`; full SAC
  suite 88/88 green.

### 6b — Real operator-data readiness — Planned

- Add explicit operator readiness process for non-synthetic real artifacts:
  candidate artifact, baseline artifact, policy corpus, manifest, sandbox
  control artifacts, independent outcome artifacts and rollup report.
- Define exact verification order and acceptance prerequisites before any candidate
  policy can be considered for non-default rollout.
- Keep all default behavior unchanged until the readiness gate is explicitly passed.
- Add reviewable rollout/rollback criteria and a documented owner-run playbook.

## Rollback order

1. Disable SAC adapter/capability; preserve existing module behavior.
2. In production, a strict enforced guard denies uncertain or failed tool
   output, MCP resource reads, remote egress and guarded writes. It covers both
   tools and resources; redacting tool output alone is insufficient.
3. In disabled or advisory mode SAC is a non-production/readiness path: no
   proposals, remote egress or production context disclosure may be enabled.
   If the strict guard is unavailable, malformed or errors, refuse the SAC
   operation rather than falling back to the current advisory/fail-open seam.
4. Stop new proposals and reads if a security or data-integrity incident occurs.
5. Revoke affected workspace role/reference, mark derived receipts stale and
   retain only permitted audit metadata.
6. Roll back policy version; never roll back or mutate accepted target knowledge
   outside its owning module's audited correction path.

## Security delivery modes

- **Disabled:** SAC capability is off; no SAC side effect, MCP resource exposure
  or egress is permitted.
- **Advisory:** findings may be evaluated for development diagnostics only; the
  mode is explicitly non-authorizing and cannot satisfy a production gate.
- **Strict enforced:** required before production exposure; the same gate covers
  CLI, Harness, MCP tools, MCP resources and egress, records policy/config
  revision, and fails closed on unavailable or indeterminate checks.
- **Rollback:** remove the SAC capability first, preserve owner-module data,
  then revoke roles/references and retain only allowed diagnostic metadata.

## Explicit deferrals

- Transcript upload/ingestion, automatic summarisation into accepted knowledge.
- Cloud sync, global identity, multi-tenant storage and external catalog.
- SAC-authored task states or autonomous Flow completion.
- Online self-modification, weight updates and policy-controlled security gates.
