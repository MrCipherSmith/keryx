# Flow supersession product requirements
Version: 0.1.0

Status: future; implementation and release validation pending.

## Problem and goal

An obsolete Hub draft can remain indistinguishable from actionable work after its scope moves into a replacement Flow. Existing freeze/start/submit/accept actions cannot express retirement without falsely implying delivery. Let a human explicitly close an eligible obsolete draft as superseded, retain its history, and navigate to its replacement.

Users are project operators who retire drafts, reviewers who need an audit trail, and agents and older clients that must not continue closed work.

## Requirements

### R1 — Human decision with a reason

Only an authenticated, project-authorized human may close an eligible draft as superseded. Require a nonblank reason and an existing replacement Flow in the same project. Derive actor and timestamp from trusted server authentication and time. Agent credentials cannot invoke this action or supply a human identity.

Verification: judged

### R2 — Safe eligibility and links

Allow source states `initializing` and `ready` only. Reject every other source state, self-reference, cross-project links, closed replacements and cycles. Closure must not cancel an active operation. A concurrently starting source must cause either closure or start to fail atomically.

Verification: judged

### R3 — Atomic audit and concurrency

Require expected source and replacement versions and an idempotency key. Commit closure, version advancement and one audit event atomically. Retry the same successful operation without duplicating events; reject reused keys with different semantics and stale new requests.

Verification: judged

### R4 — Preserve historical meaning

Preserve original criteria, pins, artifacts and prior events. Record superseded closure separately from execution phase. Do not mark criteria done, record human acceptance, imply delivery, or modify the replacement Flow's state, criteria or pin.

Verification: judged

### R5 — Readable human experience

Provide Russian and English close controls, explanation, reason input, replacement selection, explicit confirmation, closed detail/history and links in both directions. Boards default to active work and offer closed-only and all filters without losing closed records.

Verification: judged

### R6 — Compatible clients and writers

Keep historical execution phases stable. Default active listings exclude closed work; expose closure metadata additively in detail/history. Every mutation that could advance a closed Flow must reject it server-side, including requests from older clients. Older records with no closure metadata remain open.

Verification: judged

### R7 — Honest narrow release

Ship only supersession of non-running drafts; active cancellation, reopen, deletion, automatic retirement and generalized closure reasons are deferred. The current headless sessions Flow continues unchanged.

Verification: judged

### R8 — Real operator validation

Release requires the specific real old-draft closure in the [plan](plan.md#mandatory-real-acceptance-check), executed through the new human product workflow after implementation. Preserve a redacted evidence record proving the old and replacement facts, closure audit, retained pin and unchanged replacement.

Verification: judged

## Success criteria

Release criteria:

- All eight [specification acceptance criteria](specification.md#acceptance-criteria) pass, with reviewer judgments and evidence.
- Negative authorization, concurrency, link-validation and old-client scenarios pass before the real operation.
- The mandatory real closure is performed and independently verified; missing operator access or changed preconditions blocks this release criterion.

Outcome criteria:

- In the first operator review after release, the default board excludes the retired sixteen-criterion draft while closed history shows its reason and working replacement link; record the observation in the release evidence.
- Broader reduction in duplicate work: not measured — this narrow feature has no agreed usage baseline or observation window.

## Risks and recommendation

The main risks are accidentally declaring delivery, racing start against closure, confusing historic phase with active work, and trusting a client-supplied actor. Use an explicit disposition and server-side transaction and authorization checks. Implement this as a separate future Flow after the headless sessions work; keep the real human operation as the final release gate.
