# PRD: understandable Flow acceptance
Version: 0.1.1

Status: draft; not implemented by this package.

## Problem

The owner saw hashes, UUIDs and seven green self-reported Evidence records for `keryx hub status`, but could not tell what to try or how to make a decision. The reviewer had to know repository internals and use an agent to interpret the screen. A zero exit code was easier to see than its provenance and criterion coverage.

## Goal and users

Product owners and developers can review the actual submitted result without comparing hashes manually. Contributors can supply reproduction guidance without gaining decision authority. Reviewers retain technical traceability when needed.

## Requirements

### R1 — Result narrative
Show what was delivered, user-visible effect, limitations and the exact type of decision being requested. Missing narrative is explicit; never invent claims from a title or passing logs.
Verification: judged.

### R2 — Reproduction guidance
Show ordered steps, prerequisites, where to run/click, expected results and safe copy controls. Instructions are untrusted content and are never executed by the browser.
Verification: judged.

### R3 — Criterion coverage
Show every pinned criterion with pass/fail/inconclusive/missing/conflicting support and exact relevant evidence. Unmapped legacy evidence stays unmapped.
Verification: judged.

### R4 — Provenance
Differentiate contributor claims, independent agent reports, human decisions and server-observed checks. No promotion to trusted CI from method names, authorship text or exit zero.
Verification: judged.

### R5 — Technical details
Move IDs, digests, raw logs and transport metadata into an accessible collapsed disclosure; preserve exact target enforcement and direct links.
Verification: judged.

### R6 — Acceptance
An authorized human sees a plain-language confirmation naming the result and effect. The server revalidates all existing policy, coverage, selection and version gates. Accepting an Intent is not accepting its Flow or publishing code.
Verification: judged.

### R7 — Commented return
Return requires a nonblank comment, optionally associated with criteria. Preserve it durably in a human Decision and show it to the implementer. Returning is not deletion, cancellation or terminal rejection.
Verification: judged.

### R8 — Revision history
Preserve old subjects, evidence, comments and decisions; rework produces a new Attempt/submission or legacy result revision. No reopening of already accepted work through this screen.
Verification: judged.

### R9 — Concurrency and draft preservation
Stale targets conflict explicitly. Offline, response loss, double clicks and project switches cannot duplicate or misapply decisions or lose a return comment.
Verification: judged.

### R10 — Compatibility
Existing Flows without a guide remain readable and honestly marked; old acceptance receipts and the technical review-only publication block remain intact.
Verification: judged.

### R11 — RU/EN and accessibility
Ship both languages, keyboard use, focus/announcements, textual status cues and a 375px layout without page-wide horizontal scrolling.
Verification: judged.

### R12 — Demonstrable verification
Deliver executable contract/component/browser tests and two seeded journeys: accept a supported result, and return a failing result with a comment followed by resubmission.
Verification: judged.

## Success criteria

### Release criteria

- AC1–AC14 in the specification pass against the exact candidate.
- Both legacy and canonical real HTTP paths are tested; demo-only proofs are insufficient.
- The author supplies a changed-file report, schema checks and independent review before owner acceptance.

### Outcome criteria

- In the first owner walkthrough after deployment, the owner can describe the change, find a reproduction step and make a decision without opening technical details. Observation: owner feedback recorded in the implementation Flow.
- Decision-time improvement is not measured — no baseline timing or telemetry collection is authorized by this specification.

## Risks and recommendation

Main risks are fabricated coverage, confusing selection with acceptance, losing legacy provenance, and stale decisions. Reuse domain decisions and immutable artifacts; keep UI-only explanatory drafts separate from acceptance authority. Implement the compatibility path together with the canonical screen, not as a second independent workflow.
