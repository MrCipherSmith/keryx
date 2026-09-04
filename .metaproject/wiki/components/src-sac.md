---
Title: "Module src/sac (Shared Agent Context)"
Version: 0.1.0
Type: component
Status: accepted
VerifiedAt: 7d38dba02fad6f8f81d8f244f76b08d0b2f59682
VerifiedScope: sha256:7356aea2961db809fd842dbb2fd12ac2c689f35d3fd88cf0aa3af5bdfdc79cdb
Summary: Shared Agent Context (SAC) — the reviewed collaboration layer of the wiki/graph/SAC stack. Owns the offline workspace registry, the Facts/Work/Know-how read view, and the immutable proposal → review → accept lifecycle that delegates knowledge writes to owning subsystems (wiki, memory, skill) only after a human reviewer gates them.
---

# Module src/sac (Shared Agent Context)

## Purpose

The `src/sac` module is the reviewed collaboration layer of the wiki/graph/SAC stack. It provides an offline workspace registry, a read view over Facts/Work/Know-how, and the immutable proposal → review → accept lifecycle. The module acts as a coordination hub: it stores **candidates** (proposals, wrap-up data, audit metadata) and **delegates** all knowledge writes to the owning subsystems (wiki, memory, skill) only after a proposal has been reviewed and accepted.

A core design invariant: **a proposal never becomes knowledge by itself.** The SAC module only persists the proposal and its audit trail; the actual knowledge write is performed by the owning subsystem through the guarded owner writer.

## Key Files

### Contracts and Validation

- **`index.ts`** — Defines the SAC contracts (TypeScript types/interfaces) and JSON-Schema validation for all SAC data structures. This is the single source of truth for the shape of proposals, review records, wrap-up data, and workspace metadata.

### Public Facade

- **`service.ts`** — The public facade of the module. Exposes the high-level operations (e.g., propose, review, resolve workspace) to other components without exposing internal implementation details.

### Workspace Ownership

- **`workspace-service.ts`** — The `WorkspaceService` is the owner of `workspace.json`. It manages the offline workspace registry, including its ACL, roles, and archive state. All reads/writes to `workspace.json` go through this service.

### FWK Read + Access-Receipt Ledger

- **`fwk-service.ts`** — Provides the FWK (Facts/Work/Know-how) **read** view. Also maintains an access-receipt ledger that records which FWK items were read by which proposal, producing audit metadata for the wrap-up flow.

### Proposal Lifecycle

- **`proposal-lifecycle.ts`** — Implements the `ProposalLifecycleService` with `propose` and `review` operations. Guards all writes: only the owner writer may land knowledge changes.

- **`guarded-owner-writer.ts`** — The single boundary into the wiki/memory/skill subsystems. All knowledge writes flow through this guarded writer, enforcing the invariant that a proposal cannot directly write knowledge.

- **`trusted-wrap-up.ts`** — The capability issuer for wrap-up operations. Only code paths that obtain a trusted wrap-up capability may produce session/flow wrap-up records.

### Wrap-Up Producers

- **`session-wrap-up.ts`** — The Session wrap-up producer. Implements `runWrapUp` for session-scoped wrap-up data.

- **`machine-wrap-up.ts`** — The Flow/Machine wrap-up producer. Implements `runWrapUp` for flow-scoped wrap-up data.

### Workspace Resolution

- **`workspace-resolve.ts`** — Implements `resolveOrCreateWorkspace`. Binds an existing workspace or creates a new one when a slate is opened.

### Owner Writers (Knowledge Delegation)

- **`wiki-owner-writer.ts`** — The owner writer for the wiki subsystem. Lands wiki decision content after review acceptance.

- **`memory-owner-writer.ts`** — The owner writer for the memory subsystem. Lands memory entries after review acceptance.

- **`skill-owner-writer.ts`** — The owner writer for the skill subsystem. Lands skill content after review acceptance.

### Review Integrity

- **`proposal-evidence.ts`** — Performs hash re-verification of proposal evidence during the review phase. Ensures the proposal body has not been tampered with between propose and review.

- **`review-confirm-token.ts`** — Issues and validates a single-use confirm token required for the accept step. This token binds the review decision to an interactive boundary, preventing automated or replay acceptance.

## Connections

### Workspace (`workspace.json`)

The `WorkspaceService` owns `workspace.json`, which contains the workspace's ACL (who may act), roles (what each actor may do), and archive state (which workspaces have been archived). `workspace-resolve.ts` reads this file to bind an existing workspace or writes a new one when a slate is opened without a workspace.

### Slate

`workspace-resolve.ts` is invoked when a slate is opened. If the slate has no associated workspace, the resolver creates a new offline workspace and registers it in `workspace.json`. Slate Seeds (initial data bound to the slate) are also folded into the wrap-up evidence produced by the wrap-up producers, so that every wrap-up record includes the seed data it was based on.

### Review / Knowledge Writes

The accept step in the review lifecycle requires two things:
1. An **interactive boundary** — the acceptance must be performed by a human through a UI/CLI interaction, not programmatically.
2. A **single-use confirm token** — issued by `review-confirm-token.ts` and consumed on acceptance, preventing replay.

Once accepted, the guarded owner writer delegates the write to the specific subsystem:
- A **wiki decision** is landed by `wiki-owner-writer.ts`.
- A **memory entry** is landed by `memory-owner-writer.ts`.
- A **skill** is landed by `skill-owner-writer.ts`.

## Design Invariants

1. **SAC stores candidates and audit metadata only.** The module never writes directly to wiki, memory, or skill content stores. Its persistence layer holds proposals, review records, wrap-up evidence, and access receipts.
2. **Knowledge writes are delegated to owning subsystems after review.** Only through `guarded-owner-writer.ts` do accepted proposals materialize as actual knowledge.
3. **A proposal never becomes knowledge by itself.** No code path in this module (outside the guarded owner writer) can mutate the wiki, memory, or skill stores.
4. **Review acceptance requires both an interactive boundary and a confirm token.** This dual gate ensures that no automated process can self-accept a proposal.

## Related Code

- `src/sac/` — the module's main implementation directory.
- `src/wiki/`, `src/memory/`, `src/skill/` — the owning subsystems that receive delegated writes.

## Related Wiki

- [Wiki Index](../index.md)

## Changelog

- 0.1.0 — Initial version.
