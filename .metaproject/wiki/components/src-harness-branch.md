---
Title: Module src/harness/branch
Version: 1.0.0
Type: component
Status: accepted
Summary: "`src/harness/branch` implements append-only session branching (`forkBranch`, with `mergeBranches` as a v1 rejection) and typed, non-authoritative context compaction (`compact`, `assertEvidencePreserved`, `rebuildBoundedContext`). Both are pure with respect to their input snapshot and depend on the resume and session modules."
---

# Module src/harness/branch

## Overview

`src/harness/branch` owns the append-only branching and context-compaction records for a harness session tree. `branch.ts` forks a new branch at an immutable entry, and `compaction.ts` records a compacted range as a derived summary that never replaces the source entries. Both modules are pure: they return typed records plus a marker `SessionEntry` for the caller to persist, and they write nothing themselves.

## How it works

The two modules share one pattern. Each function takes an injected `deps` object (`clock`, `idSeq`) so that output is deterministic given the same clock and id source, and each returns a deep-frozen record together with a marker entry. Ids and hashes are content addresses computed with `node:crypto` over a key-sorted `canonicalStringify`.

On the branch side, `forkBranch` calls `collectAncestorIds`, which walks `causal.parentEventId` back to the root. The walk is inclusive of the fork entry and guarded by a `seen` set against cycles. The function then appends a `branch_metadata` marker whose `entryId` becomes the branch's `leafEntryId`, and `currentLeaf` reads that leaf back.

On the compaction side, `compact` hashes the summary text, derives a `compactionId`, and creates a `compaction` marker parented on the last source entry. The returned `CompactionEntry.derivedEntryId` points at that marker. The evidence guarantee is enforced by the caller through `assertEvidencePreserved`, which throws `EvidenceDeletionError` if any pre-compaction entry id is missing from the post-compaction list. `rebuildBoundedContext` then produces the deduplicated reference list and carries `summaryHash` through unchanged.

Merge is deliberately not implemented. `mergeBranches` always returns `{ kind: "rejected", reason }` and mutates neither branch.

## Key concepts

- **BranchMetadata**: the immutable branch record (`branchId`, `sessionId`, `forkEntryId`, `leafEntryId`, `immutableAncestorIds`, `createdAt`). `immutableAncestorIds` always includes `forkEntryId`, so it is never empty.
- **Fork entry and leaf entry**: the fork entry is the immutable parent the branch grows from. The leaf is the newly appended `branch_metadata` marker that becomes the tip.
- **CompactionEntry**: the provenance record for one compaction (`compactionId`, `sourceEntryIds`, `derivedEntryId`, `summaryHash`, `evidenceLedgerCursor`, `createdAt`).
- **Derived, non-authoritative summary**: the summary is stored only as a sha256 hash and is never trusted. No source entry is rewritten or deleted.
- **SessionSnapshot and SessionEntry**: the shared inputs, typed in `resume/store` and `session/types`. `ArtifactRef.kind` distinguishes `branch_metadata` from `compaction`.
- **Deps seam** (`BranchDeps`, `CompactionDeps`): the only place where time and ids enter, which keeps the functions testable.

## Main flows

1. **Forking a branch.** The caller passes `snapshot`, `sessionId` and `forkEntryId` to `forkBranch`. The function collects ancestors, hashes the stable fork identity into an artifact ref, and content-addresses the marker `entryId` over its payload and parent. It returns a frozen `branch` and `entry`, and the caller persists `entry`. Later, `currentLeaf(branch)` gives the tip to continue from.
2. **Compacting a range, then checking it.** `compact` receives `sourceEntryIds`, `summary` and `evidenceLedgerCursor`, and returns a `compaction` record and its marker `entry`. The caller persists the entry and then runs `assertEvidencePreserved(before, afterEntries)`, which must not throw. `rebuildBoundedContext` then yields `references`, built from the source range plus the `artifactId` of every `evidence_link` entry, together with `summaryHash`.
3. **Requesting a merge.** A call to `mergeBranches` returns a typed rejection with a human-readable reason. The reason directs the caller to re-fork from a shared immutable ancestor instead.

## Consumer

No production code imports this module yet. Its only importer outside the directory is `src/harness/performance.slo.test.ts`, which uses `compact` and `rebuildBoundedContext` from `compaction.ts`.

## Design notes

- **Narrow scope**: The module is intentionally focused on branch-related concerns, with compaction separated as its own distinct responsibility.
- **Testable units**: Branch and compaction behaviors are independently tested.
- **Layered integration**: The module is not a standalone entry point; it is a supporting component with no production consumer so far.

---

<!-- keryx:reference:begin v=1 hash=1c2f34a256eb528abc88b0426642987a4990c3567602ab0fd7e53e9e606e2eea -->
## Reference (from code graph)

Extracted deterministically by `keryx wiki collect`; regenerated by
`--force`. The prose sections above are the agent/human-owned part.

### Key files

- `src/harness/branch/branch.test.ts` - imported by 0, imports 5
- `src/harness/branch/compaction.test.ts` - imported by 0, imports 5
- `src/harness/branch/compaction.ts` - imported by 2, imports 2
- `src/harness/branch/branch.ts` - imported by 1, imports 2

### Depends on

- `src/harness/resume` - 2 import(s)
- `src/harness/session` - 2 import(s)

### Dependency basis

- Production imports only: 9 import(s) from test file(s) (e.g. `src/harness/branch/branch.test.ts`) excluded from the two sections above in both directions.

### Graph signals

- Files: 4
- Cross-module imports: 4
<!-- keryx:reference:end -->

## Related Wiki

Graph-derived - regenerated by `keryx wiki collect --force`. Only pages that
exist are linked, other modules are named as code paths; when enriching, add
new links only to pages you have verified.

- [Wiki Index](../index.md)
- [Module src/harness/resume](src-harness-resume.md)
- [Module src/harness/session](src-harness-session.md)

## Changelog

- 1.0.0 — Prose enriched from Key files by the gdwiki skill. Hand-written data sections reconciled with the Reference block.
- 0.1.1 - Generated sections regenerated by `keryx wiki collect --force`; prose untouched.
- 0.1.0 — Generated by `keryx wiki collect` at 2026-09-16T16:24:12.891Z.
