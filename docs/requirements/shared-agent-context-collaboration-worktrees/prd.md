# Shared Agent Context — Causal Collaboration and Worktree Overlays PRD
Version: 0.1.0

## Status

**Future / planned.** These requirements do not assert that current collaboration records are publicly writable or safely shareable across worktrees.

## Problem

Collaboration needs a durable, attributable handoff surface for parallel agents, but raw transcript sharing is unsafe and low-signal. A single activity ledger that mixes collaboration and proposal lifecycle shapes causes consumers to misparse another owner's record. Existing checkout containment also prevents intentional sibling-worktree sharing, while filesystem proximity is not a valid authorization rule.

## Goal

Create a future collaboration model that publishes small causal metadata events and reviewable artifact references; coordinates likely duplicate work with expiring hints; and shares an authorised base context across clones/checkouts while preserving private overlays and canonical Flow ownership.

## Users

- Agents and humans handing off a bounded result, evidence reference, or verification outcome.
- Parallel local agents that need visibility into intent without exclusive locking.
- Project owners managing portable context between clones and worktrees.
- Operators diagnosing causal history without accessing raw agent conversations.

## Requirements

1. Collaboration and proposal-lifecycle records shall use separate typed ledgers by default. A future unified ledger is valid only with an exhaustive tagged union and tolerant filtering so no consumer fails on another owner/event type.
2. A public `recordHandoff` owner surface shall validate an exhaustive nested event schema and be exposed consistently through planned CLI, MCP, and Harness adapters. It shall accept references and bounded metadata only.
3. The causal spine shall support `dispatch`, `reservation`, `result`, `handoff`, `verifier`, `receipt`, and `proposal` event types with immutable IDs, causal parent/root references, actor/execution provenance, workspace/project/checkout scope, timestamps, and typed artifact references.
4. Reservations shall be TTL hints about intended work scope. They shall never lock files, reserve a Flow task, grant write access, or prevent another authorised agent from proceeding.
5. The system shall distinguish `ProjectId`, `CloneId`, and `CheckoutId`; authorization shall rely on trusted identity plus explicit project/workspace membership, not a path relationship.
6. A portable bundle shall carry bounded references, revisions/digests, identity scope, and provenance but not local absolute paths, credentials, raw transcripts, or private overlay content unless explicitly reviewed for publication.
7. A project-scoped base workspace shall be read-only to checkouts. Each checkout shall have a private overlay for local facts/proposals/receipts/reservations. Publishing is an explicit reviewable delta from overlay to base, never an automatic merge.
8. Flow remains the sole owner of work status and acceptance criteria. Collaboration may reference a Flow snapshot or task identifier but shall not persist a parallel status, task list, or completion field.

## Success criteria

- A mixed sequence of handoff, proposal, review, receipt, and collaboration read succeeds without ledger-schema collision.
- Two agents see a reservation hint and can still independently proceed under their normal owner authority.
- Sibling worktrees see an authorised base but not another checkout's private overlay until a reviewed publish.
- A portable bundle can be imported into an authorised clone without treating its former path as authority.
- No collaboration payload can reconstruct a raw transcript or replace Flow state.

## Risks and recommendation

Event systems can become a second chat channel or an unreliable scheduler. Keep events sparse, typed, and artifact-reference-only; use reservations as UX hints rather than concurrency control. Implement the ledger and public writer before overlay sharing, then validate mixed lifecycle and multi-worktree corpus cases before any wider rollout.
