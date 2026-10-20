---
Title: "Module src/sac (Shared Agent Context)"
Version: 0.1.2
Type: component
Status: accepted
VerifiedAt: 7d38dba02fad6f8f81d8f244f76b08d0b2f59682
VerifiedScope: sha256:7356aea2961db809fd842dbb2fd12ac2c689f35d3fd88cf0aa3af5bdfdc79cdb
Summary: Shared Agent Context (SAC) — the reviewed collaboration layer of the wiki/graph/SAC stack. Owns the offline workspace registry, the Facts/Work/Know-how read view, and the immutable proposal → review → accept lifecycle that delegates knowledge writes to owning subsystems (wiki, memory, skill) only after a human reviewer gates them.
---
# Module src/sac (Shared Agent Context)

## Purpose

The `src/sac` module is the reviewed collaboration layer of the wiki/graph/SAC stack. It provides an offline workspace registry, a read view over Facts/Work/Know-how, and an immutable proposal → review → accept lifecycle. The module acts as a coordination hub: it stores **candidates** (proposals, wrap-up data, audit metadata) and **delegates** all knowledge writes to the owning subsystems (wiki, memory, skill) only after a proposal has been reviewed and accepted.

A core design invariant: **a proposal never becomes knowledge by itself.** The SAC module only persists the proposal and its audit trail; the actual knowledge write is performed by the owning subsystem through the guarded owner writer.

## Key Files

### Contracts and Validation

- **`index.ts`** — Defines the SAC contracts (TypeScript types/interfaces) and JSON-Schema validation for all SAC data structures. This is the single source of truth for the shape of proposals, review records, wrap-up data, and workspace metadata.

### Public Facade

- **`service.ts`** — The public facade of the module. Exposes high-level operations (propose, review, resolve workspace) to other components without exposing internal implementation details.

### Workspace Ownership

- **`workspace-service.ts`** — The `WorkspaceService` owns `workspace.json`. It manages the offline workspace registry, including its ACL, roles, and archive state. All reads and writes to `workspace.json` flow through this service.

### FWK Read View and Access-Receipt Ledger

- **`fwk-service.ts`** — Provides the FWK (Facts/Work/Know-how) read view. Also maintains an access-receipt ledger that records which FWK items were read by which proposal, producing audit metadata for the wrap-up flow.

### Proposal Lifecycle

- **`proposal-lifecycle.ts`** — Implements the `ProposalLifecycleService` with `propose` and `review` operations. Guards all writes: only the owner writer may land knowledge changes.

- **`guarded-owner-writer.ts`** — The single boundary into the wiki/memory/skill subsystems. All knowledge writes flow through this guarded writer, enforcing the invariant that a proposal cannot directly write knowledge.

- **`trusted-wrap-up.ts`** — The capability issuer for wrap-up operations. Only code paths that obtain a trusted wrap-up capability may produce session or flow wrap-up records.

### Wrap-Up Producers

- **`session-wrap-up.ts`** — The Session wrap-up producer. Implements `runWrapUp` for session-scoped wrap-up data.

- **`machine-wrap-up.ts`** — The Flow or Machine wrap-up producer. Implements `runWrapUp` for flow-scoped wrap-up data.

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

The `WorkspaceService` owns `workspace.json`, which contains:

- **ACL** — who may act within the workspace
- **Roles** — what each actor is permitted to do
- **Archive state** — which workspaces have been archived

`workspace-resolve.ts` reads this file to bind an existing workspace or writes a new one when a slate is opened without a workspace.

### Slate

`workspace-resolve.ts` is invoked when a slate is opened. If the slate has no associated workspace, the resolver creates a new offline workspace and registers it in `workspace.json`. Slate Seeds (initial data bound to the slate) are also folded into the wrap-up evidence produced by the wrap-up producers, ensuring every wrap-up record includes the seed data it was based on.

### Review and Knowledge Writes

The accept step in the review lifecycle requires two things:

1. An **interactive boundary** — acceptance must be performed by a human through a UI or CLI interaction, not programmatically.
2. A **single-use confirm token** — issued by `review-confirm-token.ts` and consumed on acceptance, preventing replay.

Once accepted, the guarded owner writer delegates the write to the appropriate subsystem:

- A **wiki decision** is landed by `wiki-owner-writer.ts`
- A **memory entry** is landed by `memory-owner-writer.ts`
- A **skill** is landed by `skill-owner-writer.ts`

## Design Invariants

1. **SAC stores candidates and audit metadata only.** The module never writes directly to wiki, memory, or skill content stores. Its persistence layer holds proposals, review records, wrap-up evidence, and access receipts.

2. **Knowledge writes are delegated to owning subsystems after review.** Only through `guarded-owner-writer.ts` do accepted proposals materialize as actual knowledge.

3. **A proposal never becomes knowledge by itself.** No code path in this module (outside the guarded owner writer) can mutate the wiki, memory, or skill stores.

4. **Review acceptance requires both an interactive boundary and a confirm token.** This dual gate ensures that no automated process can self-accept a proposal.

## Related Code

- `src/sac/` — the module's main implementation directory
- `src/wiki/`, `src/memory/`, `src/skill/` — the owning subsystems that receive delegated writes

## Related Wiki

Graph-derived - regenerated by `keryx wiki collect --force`. Only pages that
exist are linked, other modules are named as code paths; when enriching, add
new links only to pages you have verified.

- [Wiki Index](../index.md)
- [Module src/session](src-session.md)
- [Module src/lib](src-lib.md)
- [Module src/memory](src-memory.md)
- [Module src/security](src-security.md)
- [Module src/wiki](src-wiki.md)
- [Module src/ctx](src-ctx.md)
- [Module src/commands](src-commands.md)
- [Module src/tui](src-tui.md)

<!-- keryx:reference:begin v=1 hash=5c40c146205b41c705da60dfbf7bf1c15b98d2858e8a8f34ef7353375161e970 -->
## Reference (from code graph)

Extracted deterministically by `keryx wiki collect`; regenerated by
`--force`. The prose sections above are the agent/human-owned part.

### Public API

- `SacSchema`
- `SacValidationError`
- `SacValidationResult`
- `resolveSacNormativeSchemaPath`

### Key files

- `src/sac/workspace-service.ts` - imported by 37, imports 3
- `src/sac/proposal-lifecycle.ts` - imported by 10, imports 14
- `src/sac/catch-up.ts` - imported by 7, imports 14
- `src/sac/service.ts` - imported by 6, imports 15
- `src/sac/fwk-service.ts` - imported by 9, imports 9
- `src/sac/machine-wrap-up.ts` - imported by 7, imports 8

### Depends on

- `src/session` - 17 import(s)
- `src/lib` - 13 import(s)
- `src/memory` - 7 import(s)
- `src/security` - 5 import(s)
- `src/wiki` - 3 import(s)
- `src/ctx` - 2 import(s)

### Depended on by

- `src/commands` - 17 import(s)
- `src/tui` - 5 import(s)
- `src/harness/tool/builtin` - 3 import(s)
- `scripts` - 2 import(s)
- `src` - 2 import(s)
- `src/mcp` - 1 import(s)

### Dependency basis

- Production imports only: 38 import(s) from test file(s) (e.g. `src/commands/goal-command.test.ts`) excluded from the two sections above in both directions.

### Entry points

- `src/sac/index.ts`

### Graph signals

- Files: 65
- Cross-module imports: 52
<!-- keryx:reference:end -->

## Changelog

- 0.1.2 - Reference and Related Wiki added from the code graph (the page predated them).
- 0.1.1 - Unwrapped from the markdown code fence an earlier enrich left around the page; no content changed.
- **0.1.0** — Initial version
