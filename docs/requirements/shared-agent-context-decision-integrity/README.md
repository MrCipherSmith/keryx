# Shared Agent Context — Decision Deduplication and Lifecycle Cleanup (RP-13)
Version: 1.0.0

## Status

**Implemented (FR1–FR4), and wired into production paths.** This entry
previously read "Future / planned requirements package. No behaviour in this
package is a claim about the current runtime", which was stale rather than
cautious: the code had landed and the document was never updated with it.
Verified against `main` by reading the call sites, not by trusting a name:

- **FR1 + FR2 — dedup/conflict hint at review time.** `computeDedupHint`
  (`src/sac/decision-dedup.ts:164`) is called from
  `src/sac/proposal-lifecycle.ts:237`, the real review path, and calls
  `findDuplicates`/`findConflicts` (`src/memory/dedup.ts`) unmodified. FR2's
  model annotation is folded into the same payload rather than built as a
  separate service — exactly what this package's own PRD recommended
  (`prd.md:147-152`) — and is optional: `annotate: false` and an injected
  `providerFactory` are both covered in `decision-dedup.test.ts`.
- **FR3 + FR4 — report-only lifecycle flag.** `computeLifecycleFlags`
  (`src/sac/lifecycle-flag.ts:57`) is called from `src/sac/catch-up.ts:169`.
  It extends the same graph-diff signal that already drives
  `wikiPruneOrphans`, through the shared `validModuleNames`
  (`src/wiki/service.ts:358`) rather than a second derivation, and performs
  zero writes — pinned by `lifecycle-flag.test.ts`'s AC5.

Understating a shipped capability is the mirror image of overstating one, and
the same rule catches both: a status line must be checked against the code,
not inherited from the last revision.

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
