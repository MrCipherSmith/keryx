# Shared Agent Context — Receipt and Provenance Artifact Lifecycle
Version: 0.1.0

## Status

**Future / planned lifecycle.** Existing local receipt chains are not retroactively upgraded by this document.

## Artifact states

| Artifact | States | Lifecycle rule |
|---|---|---|
| D1 sample decision | evaluated -> included | excluded -> expired | Deterministic policy/version explains decision; excluded events have no implied per-read record. |
| D2 queued receipt | queued -> appended -> checkpointed | failed/quarantined -> pruned | Queue sequence is durable before response; append is batched. |
| D3 receipt | prepared -> committed -> checkpointed | failed | Dependent success is returned only after durable commit. |
| Context capsule | created -> replayed -> stale/no-drift | retained -> pruned/tombstoned | Derived metadata only. |
| Segment | hot -> rotated -> retained | verified -> pruned/quarantined | Rotation preserves checkpoint linkage. |
| Protected anchor | absent | issued -> verified -> rotated/revoked -> retained | Exists only under cross-boundary policy. |
| Repair record | opened -> verified -> resolved | unresolved -> retained | Separate append-only explanation; never a rewrite. |

## Rotation and retention

Segments rotate on whichever comes first: configured age, byte quota, record count, or policy revision boundary. Rotation writes a final local checkpoint and starts a new segment referencing the prior checkpoint. This creates an operational continuity record, not security evidence. Retention applies separately to receipt metadata, capsule metadata, queue records, verification reports, repair records, and optional protected anchors.

## Prune and quota behavior

`prune` selects only records whose retention is expired and not on a hold. It writes a tombstone containing segment/record range, reason, time, policy revision, and prior checkpoint digest; it does not retain deleted payload metadata beyond the permitted minimum. Quotas have soft warning, constrained, and hard-stop states. In constrained state, D1 sampling may be reduced only by versioned policy; D2 may reject new non-material reads; D3-dependent operations stop rather than silently losing receipt durability.

## Verify and repair

`verify` checks schema/version, sequence/order, allowed fields, queue-to-segment reconciliation, checkpoint linkage, retention tombstones, and optional protected-anchor status. It reports `valid`, `gap`, `corrupt`, `unverifiable-local`, or `anchor-invalid` without inventing data.

`repair` first isolates affected records/segments and writes a repair intent. It may rebuild a derived receipt from still-authorised source metadata, reconcile a durable queue entry, or mark a permanent gap. It cannot rewrite an old record, recreate content, claim an external actor's action, or turn a local chain into security evidence. Any material D3 gap leaves the related operation non-verifiable until its owner-specific recovery policy resolves it.

## Capsule replay lifecycle

Replay produces a new comparison report linked to the original capsule and current checkpoint, not a mutated original capsule. A pruned capsule may retain a tombstone sufficient to say why it is not replayable; it cannot be silently reconstructed from raw content.
