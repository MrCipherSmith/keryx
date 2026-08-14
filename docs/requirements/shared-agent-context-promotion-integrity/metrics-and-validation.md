# Shared Agent Context — Promotion Integrity Metrics and Validation
Version: 0.1.0

## Status

**Future / planned validation contract.** Metrics are design targets, not claims about current runtime measurements. Execution metrics for this documentation run are disabled.

## Mandatory validation suites

| Suite | Required assertions |
|---|---|
| Matrix | Every allowed kind/target selects the named sole owner; every unknown, omitted, and mismatched pair is rejected before owner discovery; no non-skill route reaches Skills. |
| Preview integrity | Alter each render-affecting field one at a time; owner rerender changes digest; old decision cannot promote. Verify mutable sidecars/attachments are impossible or ignored and rejected. |
| Authority | Spoof actor/reviewer/role fields across CLI, MCP, and Harness adapters; resolve server identity only; deny same-subject, alias-controlled, stale-role, and unauthorised reviews. |
| Idempotency | Same complete binding returns original result; same external key with a different owner/workspace/proposal/revision/operation/digest fails with conflict and no target mutation. |
| Recovery | Execute every crash point in the lifecycle matrix with process restart and a changed process correlation ID; assert at most one target mutation and at most one accepted/link-back outcome. |
| Containment | Test traversal, encoded traversal, absolute path, symlink escape, unknown locator, workspace mismatch, proposal ID path injection, and target swap after validation. |
| Receipt/link-back | Validate target receipt and workspace link-back are complete, mutually bound, and required before accepted; simulate missing or conflicting receipts. |

## Fault-injection crash matrix

The test harness must inject a terminating fault after each durable boundary named below, restart with a new process correlation ID, then call recovery with the stable intent identity.

| ID | Injection point | Must prove |
|---|---|---|
| FI-01 | Before pending intent persistence | Owner was not called. |
| FI-02 | After pending intent persistence | Recovery performs owner receipt lookup before any owner write. |
| FI-03 | During owner target/receipt transaction | Owner exposes either no receipt/mutation or one matching committed receipt/mutation. |
| FI-04 | After owner commit before reply | Recovery finds the receipt and does not duplicate the target. |
| FI-05 | After receipt validation before pending-link-back persistence | Recovery revalidates complete binding and creates one link-back. |
| FI-06 | During workspace link-back transaction | Recovery determines the workspace commit state and creates no duplicate reference. |
| FI-07 | After link-back commit before accepted event | Recovery appends one accepted event with the existing two receipts. |
| FI-08 | After accepted persistence before response | Re-delivery returns terminal result and makes no owner call. |
| FI-09 | During receipt lookup outage | No new write occurs until a matching receipt can be determined or explicit authorised resolution occurs. |

## Acceptance gates

1. All normative negative tests pass with zero owner mutations.
2. At least one valid fixture per matrix row passes preview, independent review, promote, owner receipt, link-back, and discovery verification.
3. All nine crash injections converge without duplicate target bytes, duplicate target receipt, duplicate workspace reference, or automatic acceptance.
4. Cross-proposal and cross-revision idempotency collisions are detected in both owner and SAC persistence layers.
5. A link-back receipt is retrievable from the original workspace and resolves to the owner target using typed containment checks.
6. Security policy unavailability, advisory mode, exception, stale revision, or `needs-approval` blocks promotion.

## Proposed operational measures

Track only minimised metadata: preview-stale rejection count, reviewer-independence denials, binding conflicts, recovery attempts/outcomes, time from approved review to accepted, link-back backlog age, and unresolved receipt count. Segment by owner and target type; do not retain raw proposal content to produce these measures. Any future SLO must be set only after representative baseline data exists.

## Traceability

Each test record must reference the proposal revision, preview digests, decision, intent, target receipt, workspace link-back receipt, and fault point when applicable. A process correlation ID may aid diagnostics but cannot be the sole key that connects a recovery test to its expected outcome.
