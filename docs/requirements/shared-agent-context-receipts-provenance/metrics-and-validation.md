# Shared Agent Context — Receipt and Provenance Metrics and Validation
Version: 0.1.0

## Status

**Future / planned validation.** Metrics below define future measurement, not current read-performance evidence. Execution metrics for this documentation run are disabled.

## Capsule and replay corpus

| Case | Required result |
|---|---|
| CP-01 Metadata boundary | Valid capsule stores references/revisions/digests only; each forbidden raw-content field is rejected. |
| CP-02 No drift | Same visible source/ACL/policy/plan produces `no_drift`. |
| CP-03 Source drift | Revision, withdrawal, or unresolved source produces `source_changed` without copied content. |
| CP-04 ACL drift | Revoked/changed visibility produces safe `acl_changed` without hidden-reference oracle. |
| CP-05 Policy/selection drift | Changed policy/config/budget/mandatory result produces correct categories. |
| CP-06 Pruned capsule | Retained tombstone returns `not_replayable`/safe reason, never a reconstructed source. |

## Durability, lifecycle, and integrity corpus

| Case | Required result |
|---|---|
| DL-01 D3 append failure | Dependent material operation returns non-success and no success receipt claim. |
| DL-02 D2 batch restart | Durable queue sequence is reconciled once after restart; no duplicate receipt. |
| DL-03 D1 sampling | Deterministic rule/version explains inclusion/exclusion; excluded read is not claimed audited. |
| DL-04 Rotation/prune | Checkpoint/tombstone chain remains verifiable as local operational metadata. |
| DL-05 Quota pressure | D1/D2 policy behavior is explicit; D3 is never silently dropped. |
| DL-06 Corruption/repair | Verify quarantines corruption; repair reports a gap/rebuild only from allowed metadata and never invents an event. |
| DL-07 Boundary anchor | One-owner local case succeeds with anchor absent; cross-boundary policy requires configured protected anchor verification. |

## Read SLO definitions

No numeric objective is set until a versioned local baseline exists. A future release must configure targets by operation/budget class and report the following for a declared measurement window and corpus:

| SLO | Definition |
|---|---|
| Read availability | Proportion of authorised reads completing with an allowed outcome, excluding deliberately denied requests. |
| Read latency | p50/p95/p99 end-to-end latency split into source resolution, assembly, policy, and receipt/queue overhead. |
| D3 durability latency | Time from operation commit point to durable receipt/checkpoint completion. |
| Replay explainability | Proportion of eligible retained capsules yielding a safe no-drift or classified-drift result. |
| Receipt loss | Expected D3 receipt absence or duplicate after fault corpus; required value is zero. |
| Storage boundedness | Segment/queue/capsule growth against configured per-scope quotas and retention schedules. |

Targets must distinguish `unknown` measurements from zero and compare SAC-enabled versus SAC-disabled/control paths where meaningful. A missed SLO triggers throttling, lower permitted D1 sampling, queue backpressure, or feature rollback according to policy; it never authorizes dropping D3 receipts.

## Acceptance gates

1. All metadata-boundary and replay cases pass without raw content disclosure.
2. D1/D2/D3 crash, batching, quota, rotation, prune, verify, and repair cases pass with declared acknowledgement semantics.
3. Local checkpoint tests are reported as operational integrity diagnostics, never external security proof.
4. Protected-anchor tests are conditional on a declared cross-boundary policy and do not make anchors mandatory for one-owner local use.
5. SLO baselines are collected with real measured fields; placeholder zero cost/time values are rejected.

## Proposed measures

Track minimised counts for receipt class selection, D3 durability failure, queue depth/age, batch size/lag, sampling inclusion rate, replay drift categories, pruned/tombstoned capsules, segment rotation, quota state, verification gaps, repair outcomes, and baseline read latency components. Do not record source text or security-sensitive payloads to derive measures.
