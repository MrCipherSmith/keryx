# Shared Agent Context — Decision Deduplication and Lifecycle Cleanup PRD
Version: 0.1.0

## Status

Future / planned. The current runtime has working dedup/conflict detection
and a working orphan-page pruner — neither is wired to the paths that need
them most.

## Problem

Two verified gaps, both in code that already half-solves them:

1. **Accepted SAC proposals bypass the existing dedup/conflict infrastructure
   entirely.** `src/memory/dedup.ts`'s `findDuplicates` (title similarity, or
   summary Jaccard + shared scope/tags) and `findConflicts` (same-scope
   `decision`/`constraint` overlap against an already-accepted entry) exist
   and work — but are called from exactly three places, all behind the
   standalone `keryx memory` CLI (`ingest.ts`, `check.ts`, `service.ts`).
   None are in `src/sac/*`. `src/sac/wiki-owner-writer.ts`'s
   `wikiPageRelativePath(proposalId)` writes `decisions/sac-${proposalId}.md`
   keyed purely by the proposal's own id, with no check against an existing
   similar page. Two sessions that independently reach the same conclusion —
   phrased differently — each get `workspace review --decision accepted`
   through cleanly, and both pages stay live and both come back from
   `wiki_ask`, with nothing telling the reviewer at accept time that this
   might be the second time.
2. **Nothing ties SAC content back to the code it describes once that code is
   gone.** `wikiPruneOrphans` (`src/wiki/service.ts`) already removes
   `wiki/components/*.md` pages for modules no longer in the graph — but only
   that one page category, conservatively (unmodified generated drafts only;
   accepted/hand-edited pages are reported, never deleted), via `keryx sync
   --apply`. Workspaces, memory entries, and `wiki/decisions/*` pages have no
   equivalent signal at all: `keryx workspace archive` is a manual command
   nothing ever calls automatically, so a workspace (and everything accepted
   into it) can outlive the component it was created for indefinitely, with
   no indication that it should be looked at.

Both gaps get more consequential, not less, as [Slate v2](../slate/prd.md)
ships: SLATE-16 makes workspace creation autonomous (the agent judges topic
match and creates on its own when it finds no match) and SLATE-18 makes
`propose` dispatch autonomous (no human command needed to trigger it). Lower
friction at the front of the pipeline, with the same disconnected dedup
infrastructure at the back, means more proposals landing faster with no
increase in the one thing (a reviewer's attention) that currently catches
duplication at all.

## Goal

Give the human reviewer visibility into likely duplicates/conflicts at the
moment they matter (accept time), and give an operator a way to discover SAC
content that has outlived the code it was about — using the detection and
graph-diff primitives that already exist, without building a new similarity
engine, without changing who is allowed to accept a proposal, and without
silently merging or deleting anything a human hasn't looked at.

## Users

- Reviewers running `workspace review`, who today have no signal that a
  proposal might duplicate or contradict something already accepted.
- Operators running `keryx sync`/`keryx workspace catch-up`, who today have
  no way to find SAC content (workspaces, memory entries, wiki decisions)
  whose underlying component no longer exists.
- Agents proposing content (parent-only, per Slate v2's existing
  `spawn_subagent` scope — unchanged here), who benefit from not having their
  proposal silently shadow one that already exists.

## Functional requirements

1. Before a wiki-update or memory-entry proposal reaches `workspace review`,
   compute `findDuplicates`/`findConflicts` (`src/memory/dedup.ts`) against
   the existing accepted entries the reviewer can see, and attach the hint
   (matched path, score, reason) to what the reviewer sees when deciding.
   This is additive to the review payload; it must never block, delay, or
   auto-resolve the review itself.
2. Optionally, alongside the same hint, a model-authored annotation
   (`new` / `duplicate-of-<ref>` / `conflicts-with-<ref>` / `supersedes-<ref>`)
   may be computed using the same tool-calling judgment pattern already
   approved for `ask_user`/`spawn_subagent`/SLATE-16's workspace resolution —
   no new embedding/similarity service. The annotation is informational only:
   it is shown to the reviewer, never consulted by any code path to accept,
   reject, or merge anything automatically.
3. Extend the graph module-list diff that already drives `wikiPruneOrphans`
   to a second, report-only consumer covering workspaces, memory entries, and
   `wiki/decisions/*` pages: when a component a piece of SAC content's scope
   resolves to is no longer present in the graph, flag it. The flag surfaces
   through `keryx workspace catch-up`/an equivalent discovery command; it
   never calls `keryx workspace archive`, deletes a memory entry, or removes
   a wiki page on its own.
4. The lifecycle flag's discovery path MUST route through the same mechanism
   [WSL-2](../sac-workspace-lifecycle/specification.md) already guarantees
   for pending proposals on archived workspaces (`listVisibleProposedProposals`-
   class discovery) — not a second, independent path that could surface
   different results or silently miss what WSL-2 already promises visible.
5. `supersedeEntry(oldPath, newPath)` (`src/memory/supersede.ts`) remains the
   only way a duplicate/conflict hint or annotation from (1)/(2) turns into an
   actual page-level resolution — a human (or an agent acting on an explicit
   human instruction) calls it; nothing in this package calls it on a hint's
   behalf.

## Non-functional requirements

- No new duplicate-detection algorithm, similarity model, or index — reuse
  `src/memory/dedup.ts`'s existing scoring and the graph's own module list.
- The dedup/conflict hint computation must be bounded (same cost class as
  `findDuplicates`'s existing linear scan) and must never fail the review
  flow if it errors — a failed hint computation degrades to "no hint shown,"
  never to a blocked or crashed review.
- The lifecycle flag is a pure read/report over existing data; it performs no
  writes to graph, wiki, memory, or SAC state.

## Success criteria

- A reviewer accepting a wiki-update or memory-entry proposal that
  duplicates/conflicts with an already-accepted entry sees a hint identifying
  it, every time `findDuplicates`/`findConflicts` would already have flagged
  it via the `keryx memory` CLI path today.
- `keryx workspace catch-up` (or equivalent) surfaces every workspace, memory
  entry, and wiki decision page whose scope resolves only to a component no
  longer in the graph, with zero silent auto-archival or auto-deletion.
- Every workspace with a pending proposal remains discoverable exactly as
  WSL-2 already guarantees, whether or not this package's lifecycle flag has
  also fired on it.
- Zero new similarity/embedding infrastructure introduced.

## Risks

- **False positives/negatives in the dedup hint.** `findDuplicates`/
  `findConflicts`'s scoring (title similarity, summary Jaccard, shared
  scope/tags) is a heuristic, not semantic understanding — a decision and its
  direct negation can score as similar as a genuine restatement, since both
  share vocabulary and scope. This package deliberately never acts on the
  score automatically (FR1/FR2) for exactly this reason; the risk is fully
  owned by the reviewer's judgment, not mitigated by better scoring.
- **A second lifecycle-flag path could bypass WSL-2's discovery guarantee if
  built independently.** Mitigated by FR4's explicit requirement to route
  through the same discovery mechanism, verified by test, not assumed.
- **Judge-annotation drift.** A model-authored `new`/`duplicate`/`conflicts`/
  `supersedes` annotation (FR2) can be systematically over- or under-eager
  over time with no obvious signal that it has drifted, since it is
  informational and nothing measures its accuracy against reviewer decisions.
  Out of scope for v1: no calibration/feedback loop is specified here: if
  built, it needs one before being trusted for anything beyond display.

## Recommendation

Ship FR1 (dedup/conflict hint at review time) and FR3/FR4 (report-only
lifecycle flag, scoped to workspaces + memory entries + wiki decision pages,
per an explicit decision to go wide rather than workspace-only from the
start) together — both are additive, reuse existing primitives, and carry no
write-path risk. Fold FR2 (judge annotation) into the same review-payload
enrichment as FR1 rather than building it as a separate service, since it
answers the same "is this new" question with the same informational-only
constraint.

**Explicitly deferred, not built now:** automatic decision versioning/
supersession triggered by the dedup hint crossing a threshold. If ever
pursued, it is bound by decisions already made during this package's design
(see README's Non-goals): classification always routes through a human
before taking effect (no auto-merge threshold, however high); an incorrect
auto-version must be as cheap to undo as today's manual `supersedeEntry`
call; concurrent proposals targeting the same decision-chain are serialized
by a simple lock, with the second writer retried rather than merged or
dropped silently.
