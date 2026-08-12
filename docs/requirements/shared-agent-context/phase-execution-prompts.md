# Shared Agent Context — Phase Execution Prompts

This file preserves the approved prompts for executing the Shared Agent Context
implementation roadmap. Each phase is a separate managed Flow. Phases 1–5 run
in a worktree created from `feat/shared-agent-context`; Phase 5 is optional and
may start only after Phases 1–4 are complete.

## 1. Foundation

Run `flow-orchestrator` for Shared Agent Context — Phase 0: Contract alignment.

### Scope

- Implement Draft 2020-12 schema validation plus application-level semantic validation.
- Add typed workspace-relative reference resolver with realpath/root containment.
- Introduce trusted server-created ActorContext; client-supplied identity/roles must never authorize.
- Define and implement the strict enforced guard prerequisite for SAC production read/egress/write paths.

### Acceptance criteria

- All SAC schemas and fixtures validate with positive/negative expectations.
- Semantic checks reject duplicate/conflicting SubjectId roles, unsafe references, bad time ordering and replay/idempotency violations.
- Tests cover actor spoofing, cross-workspace denial, revoked role and TOCTOU.
- Disabled/advisory modes cannot enable SAC production disclosure, egress or writes.
- No Flow state mutation and no new knowledge store.

### Required reading

Implement against:

`docs/requirements/shared-agent-context/{specification.md,agent-protocol.md,schemas/README.md,implementation-plan.md}`

## 2. Offline registry

Create a worktree from `feat/shared-agent-context`. Run `flow-orchestrator` for
Shared Agent Context — Phase 1: Offline workspace registry.

### Scope

- Implement WorkspaceService with schema-validated workspace manifest CRUD.
- Persist only the primary workspace manifest plus permitted lifecycle metadata.
- Use atomic writes and existing locking discipline.
- Implement local CLI: create, list, show and add-resource.
- Enforce ActorContext role checks and typed-reference containment.

### Acceptance criteria

- Workspace creation and resource management work offline.
- Viewer cannot mutate; owner/editor authorization is verified at point of use.
- Invalid fixtures are rejected before persistence.
- SAC disabled mode leaves existing Flow, Harness, MCP and Context Operations behavior unchanged.
- No MCP mutations, UI, remote transport, copied knowledge or parallel Flow tracker.

### Delivery protocol

Create a draft PR, perform full review and remediate findings until reviewers
return without problems. Merge into the feature branch, close the Flow, then
delete the worktree.

## 3. FWK read path

Create a worktree from `feat/shared-agent-context`. Run `flow-orchestrator` for
Shared Agent Context — Phase 2: FWK read path.

### Scope

- Implement Facts resolver with evidence revisions, visibility, freshness and expiry.
- Implement Work only as a read-only projection of one Flow snapshot.
- Implement Know-how resolver over accepted Wiki, Memory and Skills references.
- Build bounded overview and progressive read through canonical Context Operations assembly/trace.
- Emit AccessReceipt metadata only; never store raw prompts, transcripts, hidden reasoning or secrets.
- Add read-only CLI and MCP adapters with normalized output.

### Acceptance criteria

- Required item budget failure returns typed `context_overflow` without a successful manifest.
- Optional omissions return `partial=true` and `omittedOptional` IDs.
- Every read/deny receipt links to the canonical assembly/trace, policy/config revision and selected/omitted IDs.
- CLI and MCP contract fixtures have parity.
- No SAC API mutates Flow or source knowledge.

### Delivery protocol

Create a draft PR, perform full review and remediate findings until reviewers
return without problems. Merge into the feature branch, close the Flow, then
delete the worktree.

## 4. Proposal and review lifecycle

Create a worktree from `feat/shared-agent-context`. Run `flow-orchestrator` for
Shared Agent Context — Phase 3: Proposal and review lifecycle.

### Scope

- Create immutable proposed records from explicit session/Flow wrap-up output.
- Add append-only, causally ordered transition ledger with proposal revision, correlation ID and idempotency key.
- Integrate review with the owning guarded writer of Wiki, Memory or Skills.
- Require trusted reviewer authority, fresh evidence/ACL, passing security policy revision and target-write receipt before accepted.

### Acceptance criteria

- Accepted proposal is impossible without every required gate and successful target write.
- Retry with the same idempotency key returns the original terminal result.
- Failed writes, stale evidence, denied authority and replay attempts leave no accidental target mutation.
- Tests cover rejection, dismissal, stale proposal, spoofing, cross-workspace access, revoked role and TOCTOU.
- SAC still does not write Flow state directly.

### Delivery protocol

Create a draft PR, perform full review and remediate findings until reviewers
return without problems. Merge into the feature branch, close the Flow, then
delete the worktree.

## 5. Collaboration ergonomics

Create a worktree from `feat/shared-agent-context`. Run `flow-orchestrator` for
Shared Agent Context — Phase 4: Collaboration ergonomics.

### Scope

- Add worktree/session references, local activity feed and owner operations.
- Optionally add TUI/IDE integration only as clients of stable SAC CLI/MCP contracts.
- Run usability evaluation for unfamiliar-component onboarding and handoff.

### Acceptance criteria

- UI/IDE does not introduce a second contract or bypass authorization/security gates.
- Client output remains contract-compatible with CLI/MCP fixtures.
- Activity metadata contains no raw transcripts, prompts, secrets or hidden reasoning.
- Usability report records onboarding/handoff results and actionable gaps.

### Delivery protocol

Create a draft PR, perform full review and remediate findings until reviewers
return without problems. Merge into the feature branch, close the Flow, then
delete the worktree.

## 6. Policy experiment — optional, only after 1–5

Create a worktree from `feat/shared-agent-context`. Run `flow-orchestrator` for
Shared Agent Context — Phase 5: Opt-in policy experiment.

### Scope

- Build a minimized, anonymized offline corpus from integrity-linked AccessReceipts and independently verified task outcomes.
- Publish corpus manifest: provenance, selection, redaction, quarantine, holdout and adversarial cases.
- Compare candidate policy with deterministic baseline in a sandbox.
- Add explicit version pin, kill switch and rollback.

### Acceptance criteria

- No self-reported receipt outcome is treated as sufficient training/evaluation evidence.
- Every corpus row links to immutable/hash-linked receipt, policy/config revision and independent verifier outcome.
- Holdout and adversarial evaluations pass before any opt-in exposure.
- Learned policy cannot modify roles, security gates, acceptance criteria or itself.
- No learned policy is enabled by default.

### Delivery protocol

Create a draft PR, perform full review and remediate findings until reviewers
return without problems. Merge into the feature branch, close the Flow, then
delete the worktree.

## 7. Runtime opt-in readiness

Create a worktree from `feat/shared-agent-context`. Run `flow-orchestrator` for
Shared Agent Context — Phase 6: Runtime opt-in readiness.

### Scope

- Add explicit runtime config with artifact pins for candidate, baseline, corpus
  and evaluation report.
- Add strict runtime integrity-chain validation: config -> baseline -> candidate
  -> corpus -> evaluation report; no parallel checks.
- Integrate resolved policy decision into the FWK selector with fail-closed
  fallback to deterministic baseline.
- Enforce `enabled` + `killSwitch` as a hard pair. Rollback is baseline +
  kill-switch activation by default.

### Acceptance criteria

- Candidate policy can never become active by default.
- Any missing pin, malformed config, digest mismatch, parse failure or chain
  mismatch disables candidate and keeps deterministic baseline.
- Kill switch and rollback are mandatory operational controls.
- CLI/MCP parity and acceptance-level tests from phase 5 remain green.

### Delivery protocol

Create a draft PR, perform full review and remediate findings until reviewers
return without problems. Merge into the feature branch, close the Flow, then
delete the worktree.
