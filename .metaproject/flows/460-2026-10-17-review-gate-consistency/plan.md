# Implementation Plan

Status: formalized

## Approach

Fix each root cause at its source, and make the gates share computations instead of re-deriving them, so they cannot disagree again.

State × event matrix: not applicable — CLI/package records and the shell's nudge selection; no UI state beyond which package a nudge names (covered by AC3).

## Lanes (parallel worktrees, merged in order)

- **L1 gates (A, B)** — coverage.ts / readiness.ts / research.ts / ledger: package diff at the repo top level against `target.base` (fallback `resolveBase`), never the PR URL; readiness runs the same coverage gate complete runs; a confirmed `reviewer-override` decision counts without a dispatch field; git failure messages name cwd, base and head.
- **L2 nudge (C)** — completion-gate.ts / agent.ts / active-review.ts: prefer the active-review pointer and packages this session started (any project root seen in `review start`), skip open packages older than the session.
- **L3 child results and artifacts (D, E, F)** — spawn-subagent-tool.ts / ledger.ts / managed.ts: an empty child reply is an error outcome; a DONE without `slices` under a slice manifest is not scope-complete, and a reply that declares an unreadable mandatory input is incomplete; `notRun` mutation line only without a mutation record; coverage defaults from `research.dispatch.runs`.
- **L4 ingest, delta, spend (G, H)** — ingest keeps a finding whose quote cannot be placed (no anchor, flagged `quote_unlocated`, listed in scope.md and readiness) instead of refusing the round; end-to-end test that plan → ingest (with an unplaceable quote) → fix commit → plan yields a delta round with the fix roster; per-dispatch `usage` (tokens in/out, model) recorded from result envelopes (keryx shell spawn_subagent writes it; other hosts may pass it), summed in research.json and the report.
- **T-close (I)** — confirm ACs and close flows 458 and 459 through the flow CLI in this PR.
- Review: `keryx review plan` on the PR (dogfooding G), premise Wave D, fix rounds; release 0.3.122.

## Risks

- L1/L3/L4 touch managed.ts and ledger.ts: merge in order L1 → L3 → L4, resolve conflicts by function.
- G must not reintroduce guessed anchors: an unplaced quote stays unanchored and visible, never relocated by similarity.
