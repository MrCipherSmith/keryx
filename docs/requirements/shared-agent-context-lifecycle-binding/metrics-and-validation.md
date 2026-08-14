# Shared Agent Context — Lifecycle Binding Metrics and Validation
Version: 0.1.0

## Status

Future / planned validation contract. Execution metrics are disabled for this
documentation run.

## Product metrics

| Metric | Definition | Guardrail |
|---|---|---|
| Authorised resume success | Valid current-Session resolutions that reach an ordinary authorised overview/read. | Count no content bytes as a discovery metric. |
| Manual ID handoff reduction | Resumes using `--session current` compared with explicit ID pasting. | Never treat missing binding as a failure to be bypassed. |
| Discovery denial safety | Foreign/revoked/ambiguous attempts with no workspace/session metadata exposed. | Target is 100% non-disclosing outcomes. |
| Preview side-effect rate | Flow/worktree preview calls that change any persistent state. | Must remain zero. |
| Auto-promotion/link rate | Promotions or link-backs without an explicit authorised action. | Must remain zero. |
| Flow mutation rate | Flow writes attributable to lifecycle binding surfaces. | Must remain zero. |

## Required validation matrix

| Scenario | Expected result |
|---|---|
| Trusted Session has one fresh visible binding | `current` returns minimal binding metadata; normal ACL/budget checks still apply. |
| No binding or expired/revoked binding | Typed unusable result, no identifier/content leakage. |
| Two candidate bindings | `binding_ambiguous`; no arbitrary selection. |
| Caller has another workspace's ID | Non-disclosing denial/not-found equivalent; no existence oracle. |
| Role/ACL changes after Session start | Resolution/read/link-back deny at point of use. |
| `shell --workspace` | Explicit selection only; no workspace body placed in env or prompt. |
| Agent `current` / `list` | Metadata/reference only, visible entries only, pagination/limits enforced. |
| Flow/worktree preview | Returns deterministic digest/warnings and makes no SAC, Flow, or worktree mutation. |
| Session completes | Appends minimal completion association; leaves Flow state and promotion unchanged. |
| Owner accepts target | Owner acceptance succeeds independently; no workspace resource appears automatically. |
| Explicit link-back retries/crash | Same idempotency key yields one durable outcome; target owner artifact is never duplicated or reverted. |
| Overview/read after binding | Uses normal bounded Context Operations assembly; nothing is auto-injected. |

## Evidence and release gate

Before enabling any surface, preserve test evidence for the matrix above,
including negative disclosure assertions and mutation snapshots for Flow,
workspace, and worktree state. A release is blocked by any automatic
promotion/link-back, Flow mutation, actor spoofing, hidden-ID disclosure, or
unbounded model-context injection. Metrics may use aggregated/minimal receipt
metadata only and must not retain Session or workspace bodies.
