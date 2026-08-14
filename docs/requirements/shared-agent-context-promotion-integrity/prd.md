# Shared Agent Context — Promotion Semantics and Transaction Integrity PRD
Version: 0.1.0

## Status

**Future / planned.** The requirements below describe a proposed integrity boundary; they do not certify the current SAC proposal path.

## Problem

SAC proposals must be reviewable handoffs, not an indirect write channel. The analysed design leaves ambiguity at precisely the point where a proposal becomes owner knowledge: a mutable sidecar can change the rendered target after review; the same subject can review its own proposal; a retry key can collide across proposal revisions; a crash can lose the process correlation needed for recovery; owner write and receipt persistence can diverge; proposal kinds can silently fall through to Skills; and a newly accepted target is not reliably linked into the originating workspace.

## Goal

Provide a future, deterministic promotion contract in which an authorised independent reviewer approves one immutable, owner-rendered target preview, and acceptance becomes durable only after an owner receipt and a workspace link-back receipt are recorded.

## Users

- Agents that submit a bounded, evidence-backed promotion proposal.
- Human or service reviewers who decide whether a proposed artifact may be promoted.
- Wiki, Memory, Skills, Flow, requirements, and risk-register owners that perform their own guarded writes.
- Operators recovering an interrupted promotion without duplicate target mutation.

## Product requirements

1. The system shall accept only the finite proposal kinds and targets in the normative matrix in [specification.md](specification.md). An unsupported kind/target pair shall fail with `unsupported_proposal_target`; it shall not become a Skill proposal by fallback.
2. Before review, the selected owner shall render the target using a versioned renderer and create an immutable preview bundle. Its digest shall cover every render-affecting input, including canonical proposal content, target locator and base revision, template/renderer version, owner configuration, included evidence renderings, transformation/redaction policy, and locale/timezone if used.
3. The reviewer shall approve or reject that exact preview digest. A changed digest invalidates the decision and requires a new proposal revision and review.
4. SAC shall obtain proposer and reviewer authority only from trusted server-created `ActorContext` values. A request payload, prompt, environment variable, or stored display field shall never supply reviewer authority.
5. Acceptance shall require reviewer independence: the canonical reviewer subject must differ from the proposer; a delegated or service reviewer must be governed by a distinct, policy-approved principal and may not act as a disguised alias of the proposer.
6. No proposal shall be automatically accepted, including single-user, retry, timeout, or recovery paths. If an independent reviewer is unavailable, the proposal remains proposed or is explicitly rejected/dismissed.
7. The owner idempotency identity shall be bound to owner, workspace, proposal ID, proposal revision, and owner operation. Reusing a key with a different binding shall fail rather than return another proposal's receipt.
8. Recovery shall use a durable intent ID and immutable binding digest; it shall not depend on a process/request correlation ID surviving retries or restarts.
9. SAC shall never write an owner store directly. The selected owner alone validates its target, renders the preview, performs its guarded write, and returns a durable target receipt.
10. A proposal shall reach `accepted` only after both a successful owner target receipt and a successful SAC workspace link-back receipt exist. The owner shall not mutate a workspace; SAC shall not mutate the owner target.
11. All proposal, target, and workspace locations shall be validated as opaque identifiers and typed logical locators before use, then contained with realpath checks in the appropriate root. Cross-workspace and path-traversal attempts shall be denied before disclosure or mutation.

## Success criteria

- All valid kind/target pairs render to exactly one owner; all invalid pairs fail closed.
- A mutation of any preview input between review and write is detected and prevents acceptance.
- Same-subject review and client-supplied reviewer authority are rejected in every adapter.
- Fault injection at every listed crash point converges to one target mutation at most and one accepted/link-back outcome at most.
- Replaying a stable intent after a restart succeeds only for the original full binding; cross-proposal key reuse fails.
- An accepted target is discoverable from the originating workspace through a verified link-back receipt.

## Risks and decisions

Independent review can delay single-user workflows. That delay is intentional: RP-04 chooses integrity over an implicit self-approval exception. The project must later decide which trusted principal types and owner target APIs are initially available; this package does not invent a new generic owner or generic Skill route.

## Recommendation

Implement the explicit matrix and preview/digest contract first, then build the durable intent/receipt protocol behind owner adapters. Do not enable a convenience auto-accept mode as a substitute for reviewer availability.
