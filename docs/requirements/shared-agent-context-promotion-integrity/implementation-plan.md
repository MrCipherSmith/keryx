# Shared Agent Context — Promotion Integrity Implementation Plan
Version: 0.1.0

## Status

**Future / planned implementation plan.** No phase below asserts that code, migrations, or owner adapters currently exist.

## Delivery sequence

### Phase 1 — Freeze contracts and fixtures

- Define closed proposal kind/target enums, typed target intents, preview bundle, durable intent, target receipt, and link-back receipt schemas.
- Add valid and invalid fixtures for every matrix pair, catch-all Skill fallback, mutable-sidecar attempt, reviewer spoofing/self-review, cross-workspace proposal, and idempotency binding collision.
- Set compatibility rules so unknown future kinds/targets fail closed until a new explicit owner row is approved.

**Exit:** schema and semantic validators reject every invalid fixture before an owner adapter is called.

### Phase 2 — Owner adapter preview boundary

- Implement one owner adapter interface that owns target resolution, canonical rendering, complete render-input digesting, live strict security evaluation, atomic target/receipt commit, and receipt lookup.
- Deliver adapters incrementally for the matrix owners; do not activate a kind whose explicit owner adapter is absent.
- Remove or prohibit mutable proposal sidecars from the promotion input surface.

**Exit:** an unchanged preview rerenders byte-identically; any declared input mutation invalidates approval.

### Phase 3 — Authority and review boundary

- Make all adapters obtain reviewer/proposer identity from trusted `ActorContext` only.
- Enforce canonical-subject independence and delegated-principal separation.
- Add a review queue state that requires an explicit independent decision and has no auto-accept code path.

**Exit:** spoof, self-review, alias, stale-role, and missing-authority tests fail closed in each adapter.

### Phase 4 — Durable promotion and recovery

- Persist the immutable pending intent before owner invocation.
- Derive complete binding-scoped idempotency keys and implement owner lookup by intent/scope/binding digest.
- Treat process correlation as diagnostic attempt metadata; implement recovery after restart with new correlations.
- Implement owner atomic write/receipt transaction or owner journal with equivalent deterministic lookup.

**Exit:** recovery fault matrix passes with at-most-once target mutation for every supported owner.

### Phase 5 — Workspace link-back and discoverability

- Implement SAC-owned, typed workspace link-back receipts after owner receipt validation.
- Require both receipts before appending `accepted`; add pending-link-back observability and recovery.
- Verify workspace overview can discover an accepted target via the link-back without copying target content.

**Exit:** successful acceptance is atomic from the reader's perspective after recovery and target receipt/link-back bindings verify.

### Phase 6 — Rollout safeguards

- Keep the new path opt-in per supported owner until validation gates are met.
- Run synthetic crash, adversarial containment, and cross-adapter parity tests before expanding the matrix.
- Publish operator guidance for `recovery-required` without granting automatic override; an override must be a new authorised terminal decision with audit linkage.

**Exit:** project owners explicitly approve each enabled kind/target row based on validation evidence.

## Dependencies and constraints

- Trusted identity and live strict security-policy integration are prerequisites, not optional enhancements.
- Each target owner needs a guarded write and durable receipt API; a generic filesystem bridge is not an acceptable substitute.
- Flow remains the sole owner of work state. SAC link-back must not mutate Flow except through the Flow owner when a valid `follow-up` target is accepted.
- Existing SAC read behavior and source-owner contracts must remain unchanged until an approved owner adapter is enabled.

## Deferred decisions

- Which trusted principal types qualify as independent reviewers in initial deployment.
- The initial set of owner adapters and whether a dedicated risk-register owner supersedes the Wiki risk target.
- Receipt retention duration and encryption requirements for preview bytes, distinct from mandatory digest retention.
