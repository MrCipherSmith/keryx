# Validation of the Keryx Full Project Review
Version: 1.0.0

Status: **validated with corrections**. This document records evidence from the
2026-08-24 review and the follow-up validation. It is an audit record, not an
implementation claim.

## Scope and baseline

- Review target: commit `1ece28b2818d6ce2d5bfa89e0bc8a8b57b96c797` (`main`).
- Baseline captured after dependency installation: health PASS, score 93/100;
  typecheck/build passed; full Bun suite 5325 passed, 49 failed, 18 skipped.
- The original review was read from the main worktree. Graph, wiki, and compact
  context routing were used for the follow-up.

## Confirmed findings

1. The harness has 17 imports crossing into commands, TUI, or SAC in 12 files.
   The count is factual; a universal prohibition on all 17 edges is not.
2. The background-job registry depends at runtime on shell execution helpers;
   the reverse edge is type-only. A neutral process seam is required.
3. The SAC machine/proposal/session lifecycle forms a runtime value-import SCC.
4. Positive `regression_score` means a declining scope; `trend === "regressed"`
   uses the existing +/-2 deadband. The project gate remains a separate metric.
5. Exactly fourteen production comment-only catch bodies require explicit
   disposition. They are recorded in the package catch-dispositions artifact.
6. Web-tainted output can reach durable session/SAC/wiki paths before the
   security decision. Several guarded writers ignore `guard.redacted`.

## Corrected or disproved claims

- The 65 catch count is textual: 63 clauses plus two comments. The validated
  production inventory contains 60 clauses, with 14 comment-only sites needing
  disposition; mechanical rewriting is not justified.
- The modal-host/shell-chrome relation is not a runtime cycle because one edge
  is a TypeScript type-only import.
- The 17 harness boundary edges are not all proven architecture violations;
  the required seams are SAC internals, the TUI bridge, and shared spawning.
- `src/lib` is not free of upward imports: validation found 32 such imports in
  12 files. That is separate architecture debt.
- The review's “15 regressions” is not a test-failure count. It is a count of
  scopes with positive decline score; the deadband determines trend labels.

## Deferred and not established

- Kernel/live OS-sandbox smoke cases A1–A7 were not rerun.
- Provider-auth remains a future/docs-only package; no OAuth implementation is
  claimed here.
- Wiki verification covered two accepted pages and nine factual assertions,
  not the whole wiki.
- Numeric coverage is unavailable; no coverage percentage is claimed.

## Required remediation scope

- Extract a neutral shell environment/sandbox spawn seam and use it from both
  synchronous and background execution.
- Break the SAC runtime SCC through a composition/shared layer while retaining
  provenance, expiry, conflict, and immutable-proposal behavior.
- Give harness workspace tools a narrow SAC facade and inject the TUI fleet
  event sink.
- Separate declining from regressed health terminology.
- Give all fourteen catches a testable fallback or a redaction-safe degraded
  outcome; do not rewrite catches mechanically.
- Guard every durable sink before writing and persist the redacted value when
  the guard supplies one. Preserve the human confirmation barrier.

## Routing audit

- `graph_used`: gdgraph scoped find/affected queries.
- `wiki_used`: wiki index plus accepted background-jobs, OS-sandbox,
  permission-modes, project-map, quality-map, testing-map, and SAC pages.
- `ctx_used`: `keryx ctx read`, `keryx ctx rg`, and `keryx ctx run`.
- `raw_rg_used`: no.
