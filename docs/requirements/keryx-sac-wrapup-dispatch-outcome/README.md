# Wrap-Up Dispatch Outcome Notes

Status: **PRD + TRD drafted (2026-08-19), pre-implementation.** See
[prd.md](prd.md) for the formal requirements and [trd.md](trd.md) for the
grounded technical design. This README is the discovery log behind them.

## Origin

Voice request (RU) 2026-08-19: the operator opens the TUI's "Review" sidebar
section (shipped in 0.2.44), sees several items, but opening a detail shows
no proposal, no stale/dependent info, and nothing about what was dispatched.
Asked for a code-level investigation of the workspace review lifecycle and
the dispatch mechanism.

An Explore-agent investigation (same date) found the root cause; the
operator confirmed ("Да") they want a PRD for the proposed fix.

## Current-state findings (code read, 2026-08-19)

- **Data flow (already correct, not the bug)**:
  `src/tui/inspector-sources.ts:257` `loadInspectorCatchUp(cwd)` →
  `src/sac/catch-up.ts:89` `buildCatchUp({cwd})` →
  `inspector-sources.ts:272` `catchUpItems(report)` →
  `src/tui/review-inspector.ts:80-114` `describeReviewItem()`.
  `CatchUpItem` (`catch-up.ts:57-61`) is a discriminated union — `proposal`,
  `blocked`, `unbound-candidate`, `unknown` — each variant's detail renders
  only the fields that variant actually has. The `unknown` variant has no
  proposal/stale/dispatch field to render; its detail text is the hardcoded
  string "No proposal, terminal state, or unbound-candidate artifact
  recorded." (`review-inspector.ts:106-113`). This is deliberate, by-design
  behavior, not a rendering bug — `classifySession` (`catch-up.ts:151-186`)
  assigns `unknown` whenever a session shows some Slate engagement but none
  of the other three durable signals exist on disk.
- **The actual gap — the wrap-up dispatch mechanism**: "dispatch" in this
  codebase's vocabulary is the machine wrap-up composer —
  `dispatchWrapUpBestEffort` (`src/commands/agent.ts:1013-1027`) calls
  `runWrapUp` (`src/sac/machine-wrap-up.ts`), which writes either a proposal
  or (if no workspace was ever bound) an `unbound-candidate` artifact. Three
  real trigger sites: `agent.ts:1039` (`flow-complete`), `agent.ts:1090`
  (`explicit`), `src/commands/harness.ts:600` (`process-termination`). It
  IS wired up and running in production.
- **The gap itself**: `dispatchWrapUpBestEffort` wraps the call in try/catch
  and on error only emits a transient `io.onSystem` message
  (`agent.ts:1024-1026`) — nothing durable. `harness.ts`'s equivalent catch
  (`harness.ts:601-611`) only does `console.error` to stderr — also nothing
  durable. No error file, no flag, no field anywhere records that a dispatch
  was attempted or what its outcome was.
- **Consequence**: a session where wrap-up dispatch genuinely failed (missing
  model credentials, a git/evidence-write error) is indistinguishable in the
  Review UI from a session that never reached a wrap-up trigger at all — both
  collapse into the same opaque `unknown` catch-up item, because
  `classifySession` only ever looks at what's already durably on disk, and
  dispatch failures leave nothing there.
- **Workspace lifecycle (background, not the fix target)**:
  `WorkspaceManifest.status` (`src/sac/workspace-service.ts:26`) is a simple
  one-way `"active" | "archived"` field, no richer state machine. Proposal
  state is tracked separately, per-proposal, in `proposal-lifecycle.ts`.

## Open questions carried into the PRD

- Exact persisted-artifact shape/location for the new outcome record (a new
  file under the session directory vs. an `activity.jsonl`-style event vs.
  something else) — left as a TRD-level question, grounded against
  `machine-wrap-up.ts`'s and `catch-up.ts`'s actual existing I/O patterns.
- Whether the Review UI surfaces this via the existing `unknown` variant
  (extended with an optional field) or a new `CatchUpItem` variant — TRD's
  call.

## Next step

Task Manager flow to implement. TRD found a smaller fix than expected:
`runWrapUp` already computes rich per-group outcome data
(`WrapUpGroupOutcome`, including `"error"` with a message) — both callers
(`agent.ts`, `harness.ts`) just discard the return value. The fix is one new
best-effort artifact write inside `runWrapUp` itself (mirroring the existing
`writeUnboundCandidateArtifact` pattern), a new read in `classifySession`,
and one new optional field on `CatchUpUnknownItem` — `agent.ts`/`harness.ts`
need no changes at all.
