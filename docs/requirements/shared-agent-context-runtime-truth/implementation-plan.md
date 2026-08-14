# Shared Agent Context Runtime Truth — Implementation Plan
Version: 0.1.0

## Status

Future plan. No phase below is claimed as implemented.

## Phase 0 — Characterize current behavior

- Add output-level tests for candidate selection, 33/32 budgets, unpinned
  freshness, positional-ID retargeting, detail reads, and cost zeroes.
- Freeze normalized CLI/MCP/shell fixtures.
- Record the current deterministic fallback and rollback command.

**Exit:** every verified gap has a failing test or an explicit product decision.

## Phase 1 — Stable descriptors and freshness

- Introduce versioned stable ID derivation.
- Add owner/observed/current revision fields and `untracked`/`changed` states.
- Provide a bounded migration alias table for positional IDs.

**Exit:** ID and freshness property corpus passes; historical receipts remain
readable without retargeting.

## Phase 2 — Deterministic retrieval plan

- Extract independent baseline planning into Context Operations.
- Define mandatory-core and deterministic optional ordering.
- Persist metadata-only plan digests and public reason codes.

**Exit:** budget and baseline-independence tests pass.

## Phase 3 — Execute the plan

- Validate candidate closure against the independent baseline.
- Pass only chosen plan IDs to assembly.
- Materialize FWK from assembly-selected IDs only.
- Keep candidate off by default and shadow-only until later gates.

**Exit:** output-changing end-to-end tests and rollback tests pass.

## Phase 4 — Progressive detail and honest cost

- Compose owner-sanitized bounded detail ports.
- Add explicit metadata-only outcome.
- Replace fixed cost zeroes with measured-or-unknown contracts.

**Exit:** detail, redaction, cost, and hidden-disclosure corpus passes.

## Phase 5 — Adapter parity and diagnostics

- Route CLI, stdio MCP, and shell through one operation contract.
- Add explain/replay diagnostics with hidden-reference protection.
- Publish migration and rollback guidance.

**Exit:** all acceptance criteria and parity fixtures pass; documentation review
has no blockers.

## Dependencies

- Context Operations planning/trace ownership.
- Source-owned FWK projection contracts for trustworthy descriptors/detail.
- Live strict read/egress policy composition.
- Receipt operability for long-term retention and replay SLOs.

## Rollback

1. Disable candidate execution.
2. Select the previous pinned deterministic policy.
3. Preserve historical receipts and stable-ID migration metadata.
4. Do not widen authorization or copy source content during rollback.
