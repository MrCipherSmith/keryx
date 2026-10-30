# Flow supersession implementation and validation plan
Version: 0.1.0

Status: future; no runtime changes or real closure performed by this package.

## Separate work and sequence

Create a separate future implementation Flow with the eight [acceptance criteria](specification.md#acceptance-criteria). Preserve the current headless sessions Flow and its twenty-four criteria. Main-session ownership covers the requirements roadmap and future Flow creation; those are outside this bounded package-writing task.

1. Confirm the current Hub storage, state, versions, human authentication and board contracts through project routing. Read the testing skill and `.metaproject/data/testing/context.md` before selecting tests. Confirm migration/rollback and existing client fixtures.
2. Specify and review the concrete human-only API route, error mapping, JSON schemas and old-client negotiation. Add linked schema artifacts if a JSON wire body is introduced. Avoid exposing the action as an agent mutation tool.
3. Implement additive persistence, transaction and idempotency semantics, cycle checks, busy checks and closed guards on every existing mutation and queue/list path. Preserve execution phases, immutable pins and specifications.
4. Implement English/Russian human UI, active/closed/all filtering, readable history and replacement links. Exercise small-screen and both-locale rendering as appropriate to the existing UI.
5. Run authorization, invalid-link, state, busy, race, stale-version, replay, retention and representative old-client checks. Obtain review judgments for AC1–AC7 before the real operation.
6. Perform the mandatory real acceptance check below with an authenticated human operator, then obtain independent AC8 review. A release cannot claim full acceptance while this step is pending or blocked.

No active cancellation is implemented in this sequence. If active-source closure becomes necessary, stop that expansion and create a separate cancellation design rather than treating the current contract as permission.

## Mandatory real acceptance check

This is required post-implementation validation and the final real operation, not a task to perform during specification writing. The user's existing explicit instruction authorizes this future closure through the product's human workflow. The authenticated operator performs it; an agent token must not impersonate a human, forge credentials or directly edit storage.

Expected source facts:

- Old Flow: `53751ed0-ea9d-45d3-9bea-b5d0c3877f10`.
- Original draft: sixteen criteria, legacy specification path `specs/hub-remote-agents.md`.
- Original pinned digest: `fa7f7cddb56295aea912c8074e1d9a3d9d1fe02ab01b170ceb4a5a6e0ab5403b`.

Expected replacement facts:

- Replacement Flow: `98a3b05b-9d24-493f-b9bf-a9cfdd276ab9`.
- Expanded full headless sessions scope: twenty-four criteria; supplied verified snapshot has status `in-progress` and version `3`. Re-read the current state and version rather than resetting them to this snapshot.
- Context pin: `7827a1827565992e61b85d43e5e73763303b3aa9590973e6484b8c0edb1834e2`.

Procedure:

1. Through authorized product reads, verify both identifiers, their shared project, original criteria/path/digest and replacement criteria/pin. Verify the old source is still eligible and not busy. Capture the current versions of both and the replacement's current state; preserve it whatever progress has occurred since this snapshot.
2. If facts differ, source is ineligible, or human access is unavailable, record the discrepancy and leave AC8 unpassed. Do not force states, change criteria, fabricate a pin, bypass authentication or substitute a fixture for the real check.
3. The human opens the new closure UI or authenticated human API workflow, selects the replacement and enters the reason: “The original remote-agent draft is superseded because its scope expanded to full headless Keryx sessions in the replacement Flow.” Submit with current expected versions and an idempotency key through that workflow.
4. Read back the source and audit record. Verify superseded disposition, exact replacement link, nonblank reason, authenticated human author, server time and one event. Verify all sixteen original criteria, legacy path and pinned digest remain unchanged and readable; no done or accepted outcome was manufactured.
5. Verify the replacement's twenty-four criteria, context pin and current state are unchanged by the closure operation. Verify the default board excludes the old draft and closed/all views retain it with navigation to the replacement, in Russian and English.
6. Save redacted before/after evidence, event identifier, versions, operator confirmation and reviewer judgment in the implementation Flow's acceptance evidence. Do not retain credentials. Judge AC8 passed only after this real operation succeeds and the invariants are verified.

## Acceptance evidence and release gate

| Criterion | Required evidence for reviewer judgment |
|---|---|
| AC1 | Human success and agent/invalid-reason rejection, trusted actor/time |
| AC2 | Phase/busy rejection table and closure/start race |
| AC3 | Link validation including historical-cycle fixture |
| AC4 | Both version checks, exact replay, changed-key payload and concurrency |
| AC5 | Before/after immutable history/pins and delivery semantics |
| AC6 | English/Russian UI and board/history observations |
| AC7 | Representative existing-client read/mutation/queue results |
| AC8 | Actual operator closure and independent review from the procedure above |

Document preparation can pass structural review while implementation acceptance remains pending. Release evidence must distinguish those outcomes. The real check is not waived by tests, a successful simulated operation, lack of operator access or the replacement's later progress.
