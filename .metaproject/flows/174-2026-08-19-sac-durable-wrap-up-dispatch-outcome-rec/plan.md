# Implementation Plan

Status: formalized (flow-orchestrator, 2026-08-19)

## Approach

No brainstorm/alternatives needed — the TRD already resolved the single
viable shape (docs/requirements/keryx-sac-wrapup-dispatch-outcome/trd.md
§1.2-§1.6) with no blocking gap found: one new best-effort artifact write
inside `runWrapUp`, one new read in `classifySession`, one new optional
field on `CatchUpUnknownItem`, one render branch in `describeReviewItem`.
Single implementer task for the full change (small, cohesive, three files),
one code-verifier + review-orchestrator pass, matching the exact pipeline
already used for flows 172/171/170/169 this session.

## Steps

1. **T1 (implement)** — per TRD §1.3: add `writeWrapUpOutcomeArtifact` to
   `src/sac/machine-wrap-up.ts`, call it from both of `runWrapUp`'s "real
   work happened" return paths (unbound-candidate branch and the
   `Promise.all(proposeOneGroup)` branch), no artifact for the
   `nonEmptyKinds.length === 0` no-op early return.
   Per TRD §1.4: add `readNewestWrapUpOutcome(dir)` to `src/sac/catch-up.ts`
   (same lenient-undefined-on-failure posture as `safeReadSlate`), insert
   the new check into `classifySession` after the unbound-candidate check,
   before the `isSlateEngaged` fallback.
   Per TRD §1.5: add the optional `wrapUpOutcome` field to
   `CatchUpUnknownItem`.
   Per TRD §1.6: branch `describeReviewItem`'s `"unknown"` case in
   `src/tui/review-inspector.ts` on the new field; add a small
   `describeGroupOutcome` helper. No change to `formatReviewListLines`.
   Write/extend tests in the three matching test files (TRD §7):
   `machine-wrap-up.test.ts`, `catch-up.test.ts`, `review-inspector.test.ts`.
2. **T2 (verify)** — `code-verifier`: typecheck + full `bun test` suite.
   Manual/smoke note: this feature is best verified by its own new unit
   tests (TRD §7 covers the exact assertions) plus existing suite passing
   unmodified elsewhere — no interactive TUI smoke pass is required beyond
   what the render-branch unit tests already assert, since this is a data/
   detail-text change, not an interaction-model change (unlike flow 172's
   busy-branch commands).
3. **T3 (review)** — `review-orchestrator` on the diff (small, 3 source
   files + 3 test files, SAC/TUI domain).
4. Fix any findings via a dedicated follow-up task, re-verify, before PR.
5. PR → review-orchestrator against the PR/branch → merge into `main` only
   once clean → `keryx flow implemented --pr` → confirm AC evidence →
   `keryx flow complete`. Per the operator's standing instruction for this
   session: PR, then review orchestrator, only merge once it returns clean.

## Risks

- Low risk: additive-only (one optional field, one new artifact type, one
  new best-effort write wrapped in its own try/catch per TRD §1.3's NFR-1
  requirement) — no existing behavior changes for any session that doesn't
  hit the new failure-outcome path.
- Main risk is `readNewestWrapUpOutcome`'s exact scan logic drifting from
  `readNewestUnboundCandidate`'s established pattern (TRD explicitly says
  to mirror it) — implementer must read that existing function first, not
  invent a new scan approach.
- Ordering risk: the new `wrapUpOutcome` check MUST be inserted after the
  existing `terminal-state.json`/unbound-candidate checks, never before —
  getting this backwards would let a stale failure record override a
  session that has since resolved normally (TRD §6 already confirms the
  correct order requires no new reconciliation logic, only correct
  placement).
