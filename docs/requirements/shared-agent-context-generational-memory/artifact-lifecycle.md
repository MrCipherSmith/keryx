# Shared Agent Context — Generational Memory Artifact Lifecycle
Version: 0.1.0

## Status

Future / planned lifecycle. Durable artifacts remain governed by their native
Memory, Wiki, or Skills owner lifecycle.

## Lifecycle state model

```text
Session observation
  → admitted working-set entry → expired | withdrawn | privacy-deleted
  → explicit proposal → owner review → accepted durable owner artifact
                                      ↘ rejected/dismissed/stale

accepted artifact → superseded | withdrawn | privacy-deleted | policy-deleted
                 → SAC reference becomes stale; optional minimal tombstone
```

The first arrow needs authorised admission and a TTL. The durable route requires
a separately created proposal and the existing owner review/acceptance receipt.
No status transition rewrites a previous record, auto-promotes content, or
moves owner-artifact bodies into SAC.

Every session-derived arrow additionally requires a live RP-05 sealed
`MinimalEvidence` reference. Observation, working-set entry, durable reference,
and tombstone carry visibility-safe origin/revision, trust, sensitivity, scan
decision, retention class, and deletion state. A transition cannot lower
sensitivity or upgrade trust. Restricted-for-audience or deleted evidence is
denied at admission/retrieval/promotion; deletion stales all derived references
and leaves only the minimal policy-permitted tombstone.

## Temporal validity and supersession

Every reusable reference has a source revision, `validFrom`, optional `validTo`,
and an owner-visible applicability scope. Supersession appends a relation from a
newer owner revision to an older one; it preserves history and requires owner
evidence. Expiry means a working-set item is no longer eligible. Withdrawal
means an owner artifact should not be used. A stale reverse link records that a
source revision/deletion/ACL no longer supports a prior SAC reference. None of
these states implies the body is preserved by SAC.

## Contradiction sets

Creation or discovery of incompatible claims appends members to a contradiction
set; it does not pick a winner or delete the prior member. Set resolution is
limited to an owner-backed supersession, withdrawal, or explicit owner decision.
Until then, assembly either presents permitted competing references with their
scope or returns typed abstention. Membership and reasons are filtered by ACL;
hidden members do not become an existence oracle.

## Selective forgetting and deletion

| Event | Required result |
|---|---|
| TTL expiry | Remove working-set eligibility and derived cache/index entries. |
| Owner withdrawal | Mark reference unusable and retain owner-defined audit state. |
| Privacy deletion | Execute authorised owner deletion, erase required derived copies, stale reverse links, retain only minimal permitted tombstone. |
| Policy/legal deletion | Same mechanics with policy authority/receipt and retention schedule. |

Deletion and restriction propagate across Observation -> WorkingSetEntry ->
DurableKnowledgeReference reverse links before any later retrieval or
promotion. No generation may preserve eligibility by copying an older state.

A tombstone stores a non-reconstructable digest/reference state, reason,
effective time, authority/receipt and retention rule. When its retention ends it
is deleted too. A tombstone cannot satisfy retrieval or be treated as evidence.

## Retention and recovery

Working sets are bounded by TTL and workspace retention. Durable retention and
backup policy stay with owners. Indexes and derived receipts must be rebuildable
and honour deletion before re-use. Recovery replays append-only lifecycle
events/idempotency keys, never reconstructs deleted bodies from a Session,
workspace cache, transcript, or vector index.
