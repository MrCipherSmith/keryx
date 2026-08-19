# SAC: durable wrap-up dispatch outcome recording for Review UI

Status: formalized (flow-orchestrator, 2026-08-19)
Source: docs/requirements/keryx-sac-wrapup-dispatch-outcome/ (README.md, prd.md, trd.md)

## Problem

`runWrapUp` (`src/sac/machine-wrap-up.ts:517`) already computes rich
per-group outcome data on every dispatch attempt — `WrapUpGroupOutcome`
(`machine-wrap-up.ts:315-333`) is `"proposed"` | `"conflict"` |
`"unbound-candidate"` | `"no_credential"` | `"error"` (with a message),
never a thrown exception for the `"error"` case (the F-002 fix already
guarantees this). But both real callers — `dispatchWrapUpBestEffort`
(`src/commands/agent.ts:1013-1027`) and `src/commands/harness.ts:595-611` —
discard the returned `WrapUpOutcome` entirely; they only catch a *thrown*
exception (rare) and log it transiently (`io.onSystem`/`console.error`),
nothing durable. `classifySession` (`src/sac/catch-up.ts:151-186`) only
ever looks at what's durably on disk, so a session whose wrap-up dispatch
genuinely failed collapses into the exact same opaque `unknown` catch-up
item, rendered with the exact same generic "No proposal, terminal state, or
unbound-candidate artifact recorded." message
(`src/tui/review-inspector.ts:106-113`), as a session that never reached a
wrap-up trigger at all. The operator cannot tell these two materially
different situations apart from the Review UI.

## Expected Outcome

`runWrapUp` persists one new best-effort durable artifact
(`{recordType: "wrap-up-outcome", trigger, generatedAt, groups}`) under the
session's `slate-archive/` directory, mirroring the existing
`writeUnboundCandidateArtifact` convention exactly (same directory, same
`writeFileAtomic`, same filename-suffix scheme). `classifySession` reads
the newest such artifact (when present and every group is a failure
outcome) and populates a new optional `wrapUpOutcome` field on
`CatchUpUnknownItem`. `describeReviewItem`'s `"unknown"` branch
(`review-inspector.ts`) shows the real trigger/timestamp/per-group failure
reason when that field is present, and is byte-for-byte unchanged when
absent. See `docs/requirements/keryx-sac-wrapup-dispatch-outcome/trd.md`
§1.2-§1.6 for the exact resolved shape.

## Out of Scope

- No changes to `agent.ts` or `harness.ts` — both already call `runWrapUp`
  at all three trigger sites; the new write happens inside the function
  they already call (TRD §1.2).
- No change to `classifySession`'s existing `blocked`/`unbound-candidate`/
  `proposal` priority ordering — those checks stay first and already win
  over the new check by construction (TRD §6).
- No richer workspace-level state machine — `WorkspaceManifest.status`
  stays the existing binary `"active" | "archived"`.
- No retry/auto-recovery logic for failed dispatches, no alerting — durable
  recording + surfacing only.
- No migration/backfill for sessions that already ran wrap-up before this
  ships.
- No list-row (`formatReviewListLines`) change — only the detail view
  changes (TRD §1.6).
