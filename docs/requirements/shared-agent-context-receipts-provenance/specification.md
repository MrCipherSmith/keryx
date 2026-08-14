# Shared Agent Context — Receipts, Provenance, and Operability Specification
Version: 0.1.0

## Status and identity

**Future / planned normative specification.** Package ID: `shared-agent-context-receipts-provenance` (RP-10). It governs derived operational records and does not make them primary knowledge or external security evidence.

## Metadata boundary

Receipts/capsules may store opaque IDs, typed logical references, revisions, hashes/digests, timestamps, outcome/result codes, policy/configuration revisions, bounded counters, and retention/checkpoint metadata. They must not store retrieved text, snippets, prompts, transcripts, user secrets, credentials, PII, token material, detector output, hidden reasoning, or copied owner artifacts. Source owners remain authoritative for content and their own security evidence.

## Context capsule contract

```text
ContextCapsule = {
  capsuleId, workspaceId, workspaceRevision,
  assemblyTraceRef, retrievalPlanDigest, selectedItemRefs[], omittedItemRefs[],
  sourceRevisionDigest, authorizationOutcome, policyId, policyRevision,
  configurationRevision, budgetClass, createdAt,
  receiptClass, ledgerCheckpointRef, retentionClass
}
```

Each item reference is typed and contains only stable item ID, owner/source kind, revision/digest, and visibility-safe status. `sourceRevisionDigest` covers the ordered selected/omitted metadata, not source bytes. `assemblyTraceRef` links to Context Operations' canonical trace; a capsule is not a copied retrieval trace. Unknown major capsule schema versions are rejected rather than guessed.

## Replay and drift

Planned `replayCapsule` resolves current authorised metadata under the caller's current visibility and compares it to the stored capsule. It reports zero or more explicit drift categories:

| Drift | Meaning |
|---|---|
| `source_changed` | An allowed referenced source revision/digest is changed, missing, withdrawn, or unresolved. |
| `acl_changed` | Current visibility/role/capability outcome differs. |
| `policy_changed` | Security, retrieval, retention, or configuration revision differs. |
| `selection_changed` | Current plan/budget/mandatory-optional result differs. |
| `owner_reference_changed` | Owner target/reference mapping changed without copying content. |
| `no_drift` | Compared metadata is equivalent under the same declared comparison policy. |

Replay never circumvents current authorization, discloses a newly hidden reference, or downloads source content solely for explanation. It returns `not_replayable` when essential retained metadata/checkpoint is unavailable and `partially_replayable` when policy permits only a safe subset.

## Receipt durability classes

| Class | Acknowledgement semantics | Permitted use |
|---|---|---|
| `D0-none` | No receipt contract; operation outcome is not receipt-auditable. | Explicitly disabled, low-value telemetry only. Never a material security/mutation action. |
| `D1-sampled` | Deterministically selected metadata receipt is enqueued only for sampled events. | High-volume non-material reads with a declared sampling rule and no claim of per-read audit. |
| `D2-queued` | Metadata is committed to a durable local queue before success; segment append/checkpoint may be batched later. | Authorised non-material reads where queue durability is sufficient. |
| `D3-sync` | Receipt and checkpoint are durably committed before the dependent success response. | Material decisions, promotion/owner-write boundaries, security-relevant access policy, and any policy-mandated read. |

Receipt class is selected by a versioned policy before work starts and appears in the result/capsule. A batching or sampling failure may downgrade only an operation whose policy explicitly permits its lower class; it cannot transform `D3-sync` into `D2`, `D1`, or `D0`. If the durable queue/checkpoint/quota state is uncertain for D3, the dependent operation fails closed or returns a typed non-success outcome.

## Batching, sampling, and cost measurement

`D2-queued` events are assigned an immutable queue sequence, then appended in order to a rotated segment with a recorded checkpoint. Batch acknowledgement proves local queue persistence, not cross-principal proof. `D1-sampled` uses a reproducible policy/version and non-secret sampling input so operators can explain inclusion/exclusion without recording content. Sampling is forbidden for classes selected as D3.

`observedCost` records actual measured duration, configured budget class, and available tool/counter values with `unknown` explicitly represented when unavailable. Placeholder zero values must not be interpreted as measurements or used to train/adapt policy.

## Storage, checkpoints, and protected anchors

Receipt segments are append-only local operational files under a configured owner lock/write discipline. Segment/checkpoint digest links support local corruption, truncation, and ordering diagnostics. They are not tamper-evident and are not sufficient proof of an external actor's claim.

A `ProtectedAnchor` or signature is optional and forbidden-by-default inside one trusted local owner. A policy may require it only when a stated trust boundary is crossed, such as export to another principal, an independently administered store, or an external auditor. That policy must define issuer identity, protected key/storage boundary, signing/anchor algorithm, verification/revocation/rotation, failure handling, and recipient audience. Cloud storage/audit is never a default requirement.

## Planned operations and acceptance criteria

Planned operations are `receipt.inspect`, `receipt.replay`, `receipt.verify`, `receipt.rotate`, `receipt.prune`, `receipt.repair`, `receipt.quota`, and `receipt.export-anchor`. They are future owner-controlled interfaces, not current command claims.

- Capsules and all durability classes contain no forbidden raw content.
- Replay classifies source/ACL/policy/selection/owner-reference drift without disclosure expansion.
- D3 receipt-dependent operations fail closed on durability uncertainty; D1/D2 behavior remains explicit.
- Rotation/pruning preserve required checkpoints or retention tombstones; repair never invents an event.
- Local chains are operational diagnostics only; protected anchors are required solely by explicit cross-boundary policy.
