# Shared Agent Context — Collaboration and Worktree Implementation Plan
Version: 0.1.0

## Status

**Future / planned implementation plan.** No phase claims that the proposed ledgers, handoff surface, or overlay sharing currently exists.

## Phase 1 — Contracts and ledger separation

- Define exhaustive schemas for collaboration events, nested handoff payloads, reservations, Project/Clone/Checkout identity, overlay delta, and portable bundle.
- Create separate collaboration and proposal ledgers with independently versioned readers/writers; document tagged-union migration rules only as a later compatibility path.
- Add collision, malformed record, direct-write, and raw-content rejection fixtures.

**Exit:** one consumer cannot crash on another lifecycle record and no untyped payload reaches durable storage.

## Phase 2 — Public causal collaboration writer

- Implement one server-owned handoff/causal-event writer with trusted identity, policy, containment, and audience checks.
- Normalize planned CLI/MCP/Harness adapters through it; remove direct ledger writing from clients.
- Preserve metadata-only events and artifact-reference resolution.

**Exit:** adapter parity fixtures pass and malformed/unauthorized handoffs append nothing.

## Phase 3 — Reservation hints

- Implement TTL reservation create/list/release through the public writer.
- Integrate optional duplicate-work warnings without filesystem locks, Flow writes, or access changes.
- Add crash/expiry/release idempotency tests.

**Exit:** reservation improves visibility but cannot block an authorized actor or become a task tracker.

## Phase 4 — Project base and private overlays

- Establish configured Project-scoped storage and explicit Clone/Checkout identity resolution with realpath containment.
- Implement read-only base, checkout-private overlays, reviewable delta publication, and receipt/provenance events.
- Enforce cross-checkout isolation independently of path proximity.

**Exit:** sibling worktrees share base only; private overlays remain inaccessible until reviewed publish.

## Phase 5 — Portable bundles and corpus gates

- Implement bundle export/import with identity, digest, expiry, reference containment, and unresolved/stale handling.
- Run mixed lifecycle and multi-worktree corpus under restart, malformed input, and authorization-change injection.
- Keep any shared raw text or automatic merge feature explicitly out of scope.

**Exit:** all RP-08 acceptance corpus cases pass before enabling a broader collaboration rollout.

## Dependencies and constraints

- RP-06 trusted identity/capability/transport policy is required for public writer authorization.
- Flow remains the single source of work state; this package only references Flow.
- Owner modules remain responsible for artifact authorization and writes.
- No phase authorizes remote transport, a shared transcript bus, or access based on filesystem layout.
