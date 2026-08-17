# RP-13: SAC decision dedup hint + lifecycle cleanup flag

Full normative text lives in `docs/requirements/shared-agent-context-decision-integrity/`
(README.md, prd.md, specification.md — already committed to main). This flow
implements that package's Recommendation: ship FR1 (dedup/conflict hint at
review time, with FR2's judge annotation folded into the same enrichment)
and FR3/FR4 (report-only lifecycle flag, workspaces + memory entries + wiki
decision pages) together.

## Problem (verified, not hypothetical)

1. `src/memory/dedup.ts`'s `findDuplicates`/`findConflicts` exist and work,
   but are called from exactly three places, all behind the standalone
   `keryx memory` CLI — never from `src/sac/*`. `workspace review --decision
   accepted` bypasses them entirely: two sessions that independently reach
   the same conclusion, phrased differently, both get accepted with no
   signal to the reviewer.
2. `wikiPruneOrphans` already removes orphaned `wiki/components/*.md` pages
   via the graph's own module-list diff, but nothing does the equivalent for
   workspaces, memory entries, or `wiki/decisions/*` — a deleted component
   leaves stale SAC content behind indefinitely with zero discoverability
   signal.

Both gaps are more consequential now that Slate v2 (flow 166) shipped:
SLATE-16 makes workspace creation autonomous and SLATE-18 makes `propose`
dispatch autonomous — lower friction at the front of the pipeline, same
disconnected dedup infrastructure at the back.

## Non-goals (frozen in the PRD, not re-litigated here)

- No automatic merging/superseding of decisions — hint/annotation are always
  informational, human decides via `supersedeEntry`.
- No auto-archiving a workspace, no auto-deleting a memory/wiki page — the
  lifecycle flag is report-only, same conservative posture as
  `wikiPruneOrphans`.
- No new similarity/embedding service — reuse `src/memory/dedup.ts`'s
  existing scoring and the graph's own module-list diff.
- No change to who may call `workspace review --decision accepted`.
