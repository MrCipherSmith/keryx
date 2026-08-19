# PRD: Wrap-Up Dispatch Outcome Recording

## 1. Overview

The machine wrap-up composer (`runWrapUp`, dispatched via
`dispatchWrapUpBestEffort`) writes a proposal or an unbound-candidate
artifact when it succeeds, but today records nothing durable when it fails
or when it simply hasn't fired yet. Both cases collapse into the same
opaque `unknown` catch-up item in the TUI's Review section, so the operator
cannot tell "wrap-up never ran for this session" apart from "wrap-up ran and
failed, here's why." This PRD adds a durable, per-session record of every
wrap-up dispatch attempt and its outcome, and surfaces it in the Review
detail view.

## 2. Context

- **Product:** Keryx SAC (Session/Activity/Context) subsystem + its TUI
  Review surface
- **Module:** `src/sac/` (`machine-wrap-up.ts`, `catch-up.ts`), `src/commands/`
  (`agent.ts`, `harness.ts`), `src/tui/` (`review-inspector.ts`,
  `inspector-sources.ts`)
- **User Role:** Keryx operator reviewing the TUI's Review sidebar section to
  find sessions/workspaces needing attention
- **Tech Stack:** TypeScript/Bun

## 3. Problem Statement

`dispatchWrapUpBestEffort` (`src/commands/agent.ts:1013-1027`) and its
`harness.ts:595-611` equivalent both wrap the wrap-up dispatch call in a
try/catch that, on failure, only emits a transient console/transcript
message — nothing is written to disk. `classifySession`
(`src/sac/catch-up.ts:151-186`) classifies a session purely from what's
durably on disk (`terminal-state.json`, `slate-archive/*-unbound-candidate.json`),
so a session whose dispatch failed produces exactly the same `unknown`
catch-up item, rendered with exactly the same generic "No proposal, terminal
state, or unbound-candidate artifact recorded." message
(`src/tui/review-inspector.ts:106-113`), as a session that never reached a
wrap-up trigger at all. The operator has no way — from the Review UI or from
anything on disk — to distinguish these two materially different situations,
which matters because one needs investigation (something is broken) and the
other is simply not actionable yet (nothing has happened).

## 4. Goals

- G1: Every wrap-up dispatch attempt (from all three trigger sites) writes a
  durable, per-session record of: which trigger fired it, when, and its
  outcome — success-with-proposal, success-with-unbound-candidate, or
  failure-with-reason.
- G2: The record is written regardless of whether the attempt succeeds or
  fails — a failure must not skip recording.
- G3: The Review UI's detail view can surface this record when present, so
  the operator can distinguish "no attempt recorded yet" from "attempted,
  failed, here's why" from the already-correct `proposal`/`blocked`/
  `unbound-candidate` cases.
- G4: The absence of a record continues to mean exactly "no attempt
  recorded yet" — not an inferred failure.

## 5. Non-Goals

- Do not change `classifySession`'s existing `blocked`/`unbound-candidate`/
  `proposal` classification logic — those already have durable evidence and
  are already correct.
- Do not add a richer workspace-level state machine — `WorkspaceManifest.status`
  stays the existing binary `"active" | "archived"`.
- Do not change the wrap-up composer's actual dispatch/proposal-writing
  logic (Seed-kind grouping, unbound-candidate criteria) — only add durable
  outcome recording around the existing calls.
- Do not retroactively backfill outcome records for sessions that already
  ran through wrap-up before this change ships — no migration.
- Do not add retry/auto-recovery logic for failed dispatches, and no
  alerting/notification — recording and surfacing only.

## 6. Functional Requirements

- FR-1: MUST — `runWrapUp` (or its caller, `dispatchWrapUpBestEffort`, per
  TRD's call on the exact boundary) MUST persist a durable outcome record
  after every dispatch attempt from all three trigger sites
  (`agent.ts:1039` `flow-complete`, `agent.ts:1090` `explicit`,
  `harness.ts:600` `process-termination`).
- FR-2: MUST — the record MUST include: trigger name, a timestamp, and an
  outcome discriminator (`ok-proposal` | `ok-unbound-candidate` | `failed`),
  plus a human-readable reason string when `failed`.
- FR-3: MUST — the record MUST be written on the failure path too — the
  current `catch` blocks in `agent.ts:1024-1026` and `harness.ts:601-611`
  must be extended to write the durable record before/alongside their
  existing transient message, not skip it.
- FR-4: MUST — `classifySession`/`buildCatchUp` MUST read this record (when
  present) for sessions that would otherwise classify as `unknown`, and the
  Review UI's detail rendering (`review-inspector.ts`) MUST surface it —
  either by extending the `unknown` `CatchUpItem` variant with an optional
  outcome field, or by introducing a new variant (TRD's call, per FR-4's
  Constraints below) — replacing the generic "No proposal, terminal state,
  or unbound-candidate artifact recorded." message with the actual recorded
  outcome and reason when one exists.
- FR-5: MUST — when no outcome record exists for a session, the Review UI's
  behavior is completely unchanged from today (the existing generic
  `unknown` message) — this is the "no attempt recorded yet" case from G4,
  and must not be conflated with a failure.
- FR-6: MAY — a session with a `failed` outcome record MAY still fall
  through to `blocked`/`unbound-candidate` classification if a later,
  separate wrap-up attempt for the same session subsequently succeeds and
  writes the corresponding durable artifact (`terminal-state.json` etc.) —
  i.e. a stale failure record does not need to permanently override a
  session that later resolved normally. TRD should state how "later
  succeeded" is detected (e.g. record timestamp vs. artifact timestamp) if
  this is implemented, or explicitly defer it as a known limitation if not.

## 7. Non-Functional Requirements

- NFR-1: Writing the outcome record must not introduce a new failure mode
  that could itself go unrecorded — if the record-write itself fails, fall
  back to at least the current transient message behavior (best-effort,
  same spirit as the rest of `dispatchWrapUpBestEffort`).
- NFR-2: The record write must be cheap and synchronous-enough to not
  meaningfully delay session/process shutdown at the `process-termination`
  trigger site (`harness.ts:600`) — no network calls, no expensive I/O.
- NFR-3: No change to any existing `CatchUpItem` variant's meaning for
  `proposal`/`blocked`/`unbound-candidate` — only `unknown`'s presentation
  (or a new variant alongside it) changes.
- NFR-4: The reason string for a `failed` outcome must not leak secrets or
  raw credentials — sanitize/truncate error messages before persisting,
  consistent with this repo's general security posture for durable
  artifacts.

## 8. Constraints

- Must be grounded against `machine-wrap-up.ts`'s and `catch-up.ts`'s actual
  existing I/O patterns — TRD decides the exact artifact shape/location (a
  new file under the session directory vs. an `activity.jsonl`-style event
  vs. something else), not this PRD.
- Must not modify `WorkspaceManifest`'s status field or its lifecycle.
- Must not modify the wrap-up composer's proposal/unbound-candidate writing
  logic itself — only wrap it with outcome recording.
- Must reuse the existing three trigger call sites — no new trigger points.

## 9. Edge Cases

- EC-1: A session with real Slate engagement whose wrap-up simply hasn't
  fired yet (e.g. still an active/mid-flow session). No outcome record
  exists → Review UI shows exactly today's generic `unknown` message, not a
  failure (per G4/FR-5). This is the single most important case to get
  right — it must not become a false-positive "failed" report.
- EC-2: Wrap-up dispatch succeeds and writes a proposal — an outcome record
  of `ok-proposal` also gets written. The session is now correctly
  classified as `proposal` by the existing logic (Non-Goal: unchanged) — the
  outcome record is redundant-but-harmless for this case; TRD may choose not
  to surface it in the UI at all here since the `proposal` detail is already
  fully informative.
- EC-3: Wrap-up dispatch fails, THEN a later separate mechanism (e.g. a
  manual `/interrupt` and resume, or a subsequent session) produces a
  `terminal-state.json` for the same session anyway. See FR-6 — TRD decides
  whether to reconcile or just leave the stale failure record present
  alongside the now-also-present `blocked` classification (classification
  priority in `classifySession` already checks `terminal-state.json` first,
  so `blocked` would still win — TRD should confirm this ordering is
  preserved).
- EC-4: The outcome-record write itself fails (e.g. disk full, permissions).
  Per NFR-1, this must not crash the calling turn/process — falls back to
  today's transient-message-only behavior.

## 10. Acceptance Criteria (Gherkin)

```gherkin
Feature: Wrap-up dispatch outcome recording

  Scenario: A failed wrap-up dispatch is durably recorded
    Given a session triggers wrap-up dispatch (any of the three trigger sites)
    And the dispatch call throws or otherwise fails
    When the failure is caught
    Then a durable outcome record is written for that session
    And the record's outcome is "failed" with a human-readable reason
    And the existing transient console/transcript message still appears

  Scenario: A successful wrap-up dispatch is durably recorded
    Given a session triggers wrap-up dispatch
    And the dispatch succeeds, writing a proposal
    When the dispatch completes
    Then a durable outcome record is written with outcome "ok-proposal"

  Scenario: Review UI surfaces a failure record
    Given a session has a durable outcome record with outcome "failed"
    And the session would otherwise classify as "unknown"
    When the operator opens that item's detail in the Review section
    Then the detail shows the recorded trigger, timestamp, and failure reason
    And it does NOT show the generic "No proposal, terminal state, or
      unbound-candidate artifact recorded." message

  Scenario: No record means no attempt yet, not a failure
    Given a session has real Slate engagement
    And no wrap-up outcome record exists for it
    And it has no terminal-state.json or unbound-candidate artifact
    When the operator opens that item's detail in the Review section
    Then the detail shows exactly today's unchanged generic message
    And nothing implies a dispatch failure occurred

  Scenario: Already-correct classifications are unaffected
    Given a session has a terminal-state.json (blocked) or an
      unbound-candidate artifact or a pending proposal
    When the operator opens that item's detail in the Review section
    Then the detail is byte-for-byte identical to its pre-change behavior
```

## 11. Verification

- **How to test:** unit tests around the outcome-record writer (success and
  failure paths, from a mocked/injected dispatch call) and around
  `classifySession`/`buildCatchUp`'s new record-reading behavior (record
  present vs. absent vs. superseded by a later `terminal-state.json`, per
  EC-3). Snapshot/assert the Review detail rendering for the new
  presentation.
- **Where to test:** alongside existing `src/sac/catch-up.test.ts` (or
  equivalent, TRD to confirm exact file) and `src/tui/review-inspector.test.ts`.
- **Observability checks:** none beyond the durable record itself — no new
  logging/metrics surface required, the record IS the observability
  mechanism this PRD adds.
