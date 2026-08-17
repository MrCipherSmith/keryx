# Shared Agent Context — Decision Deduplication and Lifecycle Cleanup Specification (RP-13)
Version: 0.1.0

## Status

Future / planned specification. Names below describe intended contracts, not
currently available commands or agent tools.

## Identity and ownership

This package owns no new state and no new write authority. It is a read-side
enrichment (dedup/conflict hint + optional annotation) attached to the
existing `workspace review` payload, and a read-side report (lifecycle flag)
attached to existing discovery commands. `src/memory/dedup.ts` continues to
own duplicate/conflict scoring; `src/memory/supersede.ts` continues to own
the only real page-to-page resolution action; `src/wiki/service.ts`'s graph
module-list diff continues to own "is this component still in the graph."
Review/accept authority is unchanged from today (plus [SLATE-20](../slate/specification.md)'s
confirm-token, landing separately for the same self-accept gap this package
does not touch).

## Dedup/conflict hint at review time

Planned shape, attached to the existing proposal review payload (`src/sac/proposal-lifecycle.ts`
`ProposalLifecycleService.review()`'s input construction, not a new type):

```text
DedupHint {
  duplicates: DuplicateHint[]   // from findDuplicates — unchanged shape
  conflicts: ConflictHint[]     // from findConflicts — unchanged shape, decision/constraint only
}
```

Computed by calling `findDuplicates`/`findConflicts` (`src/memory/dedup.ts`,
unmodified) against the workspace's/actor's currently-visible accepted
entries, at the point the proposal is about to be reviewed — not at propose
time (the candidate set of "existing accepted entries" is only meaningful
relative to what a reviewer, not the proposer, is authorized to see). A
computation failure (timeout, read error) degrades to an empty `DedupHint`,
never to a review-blocking error.

## Optional judge annotation

```text
DecisionAnnotation {
  verdict: "new" | "duplicate-of" | "conflicts-with" | "supersedes"
  ref?: string   // the matched entry's path, when verdict !== "new"
  confidence?: "low" | "medium" | "high"
}
```

Produced, when enabled, by a bounded model call using the same tool-calling
judgment pattern already approved for `ask_user`/`spawn_subagent`/SLATE-16's
workspace resolution — reuses the model already in the loop, no new
embedding/similarity service, no new provider dependency. Attached to the
same review payload as `DedupHint`, purely informational: no code path reads
`DecisionAnnotation.verdict` to make an accept/reject/merge decision. Absent
or errored the same way `DedupHint` degrades — never blocks review.

## Report-only lifecycle flag

Extends the existing graph module-list diff (`src/wiki/service.ts`'s
`wikiPruneOrphans` input — the "valid modules" set derived from the current
graph) to a second consumer that never writes:

```text
LifecycleFlag {
  kind: "workspace" | "memory-entry" | "wiki-decision"
  ref: string             // workspace id, memory entry path, or wiki page path
  missingComponent: string  // the module/component no longer in the graph
  flaggedAt: string
}
```

Surfaced through the existing discovery surface (`keryx workspace catch-up`
or an equivalent read command) as an additional category, alongside
proposals/blocked/unbound-candidates — never triggers `keryx workspace
archive`, a memory-entry edit, or a wiki-page removal itself. Per the
explicit decision to go wide from the start (not workspace-only), all three
`kind`s are in scope for v1, not staged.

**WSL-2 routing requirement.** This flag's discovery MUST be layered on top
of the same `listVisibleProposedProposals`-class mechanism
[WSL-2](../sac-workspace-lifecycle/specification.md) already guarantees for
archived-workspace pending-proposal visibility — implemented as an additional
projection over that same discovery call, not a parallel query path. A test
must assert that a workspace with both a pending proposal AND a lifecycle
flag appears correctly in both categories, not just one.

## Future CLI and agent surface

No new mutating command. Planned additions are read-only:

```text
keryx workspace catch-up [--workspace <id>] [--include-lifecycle-flags]
```

(extends the existing catch-up surface; flag defaults to shown, not opt-in,
since the whole point is discoverability.)

The dedup hint and judge annotation are not separately callable — they are
computed as part of the existing `workspace review` read path and returned
inline with its result, both on the CLI (`keryx workspace review`) and MCP
(`sac.review`) surfaces, so both stay symmetric.

## Permission model and security invariants

No new `ActorContext`, no new role, no new write authority. The dedup hint
and judge annotation are visible only to whoever already has visibility into
the entries being compared (least-disclosure is inherited from the existing
review-payload construction, not re-implemented here). The lifecycle flag is
visible only through the same discovery path WSL-2 already gates by actor
role — this package adds a projection over that path, not a new
authorization surface.

The judge annotation (`DecisionAnnotation`) is explicitly never an input to
any authorization or acceptance decision — it is UI/output only, matching
the same trust framing already used for a Slate Seed's optional `kind` tag
(advisory, reclassifiable, never binding).

## Integration and acceptance criteria

Integrations are limited to `src/memory/dedup.ts` (read, unmodified),
`src/memory/supersede.ts` (unchanged — still the only real resolution path),
`src/wiki/service.ts`'s existing graph-diff signal (read, extended to a
second consumer), `src/sac/proposal-lifecycle.ts`'s review payload
construction (enriched, not restructured), and WSL-2's discovery mechanism
(projected over, not duplicated). The implementation is acceptable only when:
every dedup/conflict hint and judge annotation is informational and cannot be
shown to have altered an accept/reject/merge outcome by itself; the lifecycle
flag never triggers a write (archive, edit, delete) on its own; a workspace
with a pending proposal remains visible in pending-review discovery
regardless of whether it also carries a lifecycle flag; and no new
similarity/embedding/index infrastructure was introduced to compute any of
the above.
