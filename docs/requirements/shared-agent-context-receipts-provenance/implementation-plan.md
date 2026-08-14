# Shared Agent Context — Receipt and Provenance Implementation Plan
Version: 0.1.0

## Status

**Future / planned implementation plan.** No phase asserts that current SAC receipts already implement capsules, measured cost, durability classes, or lifecycle operations.

## Phase 1 — Contract freeze and fixture corpus

- Define capsule, receipt-class, segment/checkpoint, tombstone, verification, repair, quota, and optional protected-anchor schemas.
- Add forbidden-content, replay/drift, mixed durability, corruption, prune, and quota fixtures.
- Freeze the operational-metadata versus security-evidence terminology in all interfaces.

**Exit:** validators reject raw-content fields and unknown major versions before persistence.

## Phase 2 — Capsule and replay implementation

- Produce metadata-only capsules from canonical Context Operations trace/revision references.
- Implement safe replay/drift classification under current authorization with no disclosure expansion.
- Expose inspection/replay reports as owner-controlled planned interfaces.

**Exit:** corpus cases CP-01 through CP-06 pass with no source-content persistence.

## Phase 3 — Classed durability and measurement

- Implement policy-selected D1/D2/D3 behaviors, durable queue sequencing, D3 synchronous commits, and explicit no-receipt D0 behavior.
- Replace fabricated cost fields with measured-or-unknown observations and receipt-class provenance.
- Add failure handling so queue/quota uncertainty cannot downgrade D3.

**Exit:** restart/fault corpus proves D3 at-most-once durable outcome and D2 queue reconciliation.

## Phase 4 — Lifecycle operations and quotas

- Implement segment rotation, retention classes, prune tombstones, verify reports, quarantine/repair journals, and scope quotas.
- Add backpressure/rollback controls that preserve mandatory receipt behavior.
- Publish operator guidance for gap, corrupt, and quota-hard-stop states.

**Exit:** lifecycle corpus DL-04 through DL-06 passes without rewriting historical records.

## Phase 5 — Baselines and optional trust-boundary anchors

- Measure declared read/SLO fields on a fixed corpus and set configured targets only from baseline evidence.
- Implement protected anchors/signatures only when a separately approved cross-principal/export policy names the full protection and verification lifecycle.
- Keep one-owner local deployments anchor-free by default.

**Exit:** no performance/security claim is made without measurement; optional anchor tests pass only when their policy applies.

## Dependencies and constraints

- Context Operations remains the canonical retrieval-trace owner.
- Security/owner modules retain their own authoritative evidence and write receipts.
- RP-06 provides policy/identity metadata where receipt selection needs it.
- No phase requires cloud audit, signatures, or a claim that local hash chains are tamper-evident.
