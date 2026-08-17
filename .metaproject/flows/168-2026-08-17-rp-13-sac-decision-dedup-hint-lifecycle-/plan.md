# Plan

Two phases, each its own PR (mirrors flow 166's Slate v2 delivery style —
review + fix cycle, CI green, merge, then next phase). Isolated worktree,
never the main checkout another concurrent agent may be using.

## Phase 1 — FR1 + FR2: dedup/conflict hint at review time

- `DedupHint`/`DecisionAnnotation` computed inside `ProposalLifecycleService.review()`
  (`src/sac/proposal-lifecycle.ts`) for `wiki-update`/`memory-entry` kinds
  only, calling the EXISTING `findDuplicates`/`findConflicts`
  (`src/memory/dedup.ts`, unmodified) against the workspace's/actor's
  currently-visible accepted entries.
- Computed AFTER the accept/reject/dismiss decision is already made (this is
  visibility, never a gate) — attached to the returned event/result, both CLI
  (`keryx workspace review`) and MCP (`sac.review`) surfaces stay symmetric.
- A computation failure degrades to an empty hint, never blocks or fails the
  review.
- FR2 (judge annotation) folded into the same enrichment: an optional bounded
  model call (mirrors `resolveOrCreateWorkspace`'s shape from Slate v2 —
  `runModelTurn`, injectable `providerFactory`/`env`/`modelTurnTimeoutMs`),
  informational only, never consulted by any accept/reject/merge code path.

## Phase 2 — FR3 + FR4: report-only lifecycle flag

- Extend the graph module-list diff that already drives `wikiPruneOrphans`
  (`src/wiki/service.ts`) to a second, read-only consumer covering
  workspaces, memory entries, and `wiki/decisions/*` pages.
- Surface through `keryx workspace catch-up --include-lifecycle-flags`
  (default shown), layered on TOP of the existing
  `listVisibleProposedProposals`-class discovery mechanism WSL-2 already
  guarantees — never a second, parallel query path.
- Test: a workspace with BOTH a pending proposal AND a lifecycle flag must
  appear correctly in both categories.
- Zero writes performed by this phase — pure read/report.
