# Acceptance Criteria

Full normative text lives in `docs/requirements/shared-agent-context-decision-integrity/`
(prd.md's Success criteria, specification.md's "Integration and acceptance
criteria"). Each line below pins the flow-local ACn to that package's own
requirement — read the linked docs for the full text, do not restate it here.

- AC1: a wiki-update or memory-entry proposal that duplicates/conflicts with
  an already-accepted entry produces a `DedupHint` on the `workspace review`/
  `sac.review` result, every time `findDuplicates`/`findConflicts` would
  already have flagged it via the `keryx memory` CLI path today — computed
  from the SAME unmodified `src/memory/dedup.ts` functions, no new scoring.
- AC2: the hint/annotation is computed AFTER the accept/reject/dismiss
  decision, never gates it — a computation failure (timeout, read error)
  degrades to an empty/absent hint, never a blocked or crashed review.
- AC3: the optional `DecisionAnnotation` (judge verdict) is informational
  only — no code path reads `.verdict` to make an accept/reject/merge
  decision; this must be true even when the annotation is present.
- AC4: `keryx workspace catch-up --include-lifecycle-flags` (default shown)
  surfaces every workspace, memory entry, and wiki decision page whose scope
  resolves only to a component no longer in the graph — the SAME graph
  module-list diff that already drives `wikiPruneOrphans`, no new
  similarity/embedding infrastructure.
- AC5: the lifecycle flag never triggers a write (archive, memory edit, wiki
  page removal) on its own — pure read/report, verified by test.
- AC6: a workspace with a pending proposal remains visible in pending-review
  discovery exactly as WSL-2 already guarantees, whether or not it ALSO
  carries a lifecycle flag — tested with a workspace that has both.
- AC7: `sac.review` (MCP) and `keryx workspace review` (CLI) stay symmetric —
  both surfaces return the same `DedupHint`/`DecisionAnnotation` shape.
