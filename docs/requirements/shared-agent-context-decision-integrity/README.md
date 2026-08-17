# Shared Agent Context — Decision Deduplication and Lifecycle Cleanup (RP-13)
Version: 0.1.0

## Status

Future / planned requirements package. No behaviour in this package is a claim
about the current runtime.

## Purpose

Two related, verified gaps found while designing [Keryx Slate v2](../slate/README.md)
(SLATE-16..21 — automatic workspace resolve-or-create, autonomous `propose`
dispatch): (1) accepted SAC proposals never check for an existing accepted
decision that says the same thing, so two sessions that independently reach
the same conclusion produce two untethered wiki/memory entries with nothing
warning the reviewer; (2) nothing ties a workspace, an accepted decision, or
a memory entry back to the code component it describes, so a deleted
component leaves stale, undiscoverable SAC content behind. Both are made more
likely by Slate v2 lowering the friction to create workspaces and dispatch
proposals autonomously — this package does not depend on Slate v2 landing
first, but is more urgent because of it.

## Document index

| Document | Purpose |
|---|---|
| [README.md](README.md) | Package scope and navigation. |
| [prd.md](prd.md) | Product requirements and success criteria. |
| [specification.md](specification.md) | Planned data model, integration points, and permission model. |

## Scope

- A dedup/conflict hint, computed from the existing `src/memory/dedup.ts`
  (`findDuplicates`/`findConflicts`), surfaced to the human reviewer at
  `workspace review` time for both wiki-update and memory-entry proposals —
  today only reachable via the separate `keryx memory` CLI commands, never
  from the SAC accept path.
- An optional model-authored annotation (new/duplicate-of-X/conflicts-with-X/
  supersedes-X) shown alongside that hint, informational only — it never
  decides, accepts, or rejects anything itself.
- A report-only lifecycle flag, driven by the same graph module-list diff
  that already powers `wikiPruneOrphans` (`src/wiki/service.ts`), covering
  workspaces, memory entries, and `wiki/decisions/*` pages whose scope
  resolves only to a component no longer present in the graph.

## Non-goals

- **Automatic merging or superseding of decisions** ("version vs conflict"
  classification acting on its own, without a human seeing both texts) — an
  explicitly deferred future track (see prd.md's Recommendation and Risks);
  not built by this package. If ever built, it must satisfy the constraints
  already fixed for it: classification always routes through a human before
  taking effect, a wrong auto-version is as cheap to undo as today's manual
  `supersedeEntry(oldPath, newPath)`, and concurrent writers to the same
  decision-chain are serialized by a simple lock (second writer retries),
  not merged or silently dropped.
- **Auto-archiving a workspace, or auto-deleting a memory entry or wiki
  decision page.** The flag this package adds is report-only, the same
  conservative posture `wikiPruneOrphans` already uses for `wiki/components/*`
  (auto-delete only unmodified generated drafts; anything accepted or
  hand-edited is reported, never silently removed). Acting on the flag
  (`keryx workspace archive`, editing/removing a wiki page, superseding a
  memory entry) stays a human decision through the existing manual commands.
- **A new similarity/embedding service.** Both the dedup hint and the
  lifecycle flag reuse existing primitives (`src/memory/dedup.ts`'s
  title/summary scoring, the graph's own module-list diff) — no new model,
  index, or vector store.
- **Changing who may call `workspace review --decision accepted`.** Review
  stays exactly as gated as it is today (plus [SLATE-20](../slate/specification.md)'s
  confirm-token, a separate, already-scoped fix for the same self-accept
  gap) — this package adds visibility at review time, not a new actor or a
  new write path.

## Related modules

- [Keryx Slate](../slate/README.md) — the concurrent work that surfaced this
  gap; SLATE-16's autonomous workspace/propose flow is this package's main
  motivating pressure, not a dependency it needs to land first.
- [SAC Workspace Lifecycle Completion](../sac-workspace-lifecycle/README.md) —
  owns `keryx workspace archive` and WSL-2's "archived workspaces never
  disappear from pending-review discovery" invariant; this package's
  lifecycle flag must route through the same discovery path, not a second
  one that could bypass it.
- `src/memory/dedup.ts`, `src/memory/supersede.ts` — existing primitives this
  package wires into a new call site, not new logic.
- `src/wiki/service.ts` (`wikiPruneOrphans`), `src/commands/sync.ts` — the
  existing graph-diff signal and conservative apply/report pattern this
  package's lifecycle flag extends to workspaces/memory/wiki-decisions.
- `src/sac/wiki-owner-writer.ts`, `src/sac/proposal-lifecycle.ts` — the real
  accept-time write path the dedup hint attaches to.
