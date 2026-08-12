# Keryx Shared Agent Context — Artifact Lifecycle
Version: 1.4.0

## Source of truth and derived artifacts

| Artifact | Source of truth | State/lifecycle | Retention rule |
|---|---|---|---|
| Workspace manifest | SAC local manifest | active → archived | Retain until authorised archive/deletion policy. |
| Facts/Work/Know-how receipt | Derived from source modules | fresh → stale/expired/denied → regenerated | May be deleted/rebuilt; never primary knowledge. |
| Access receipt | Derived pointer to Context Operations assembly/trace | recorded → retention expiry | Retain minimal metadata per project policy; no raw content. |
| Proposal | Immutable SAC candidate record + append-only events | proposed → pending-write → accepted/rejected/dismissed/stale | Retain audit metadata; content subject to security/data policy. |
| Review decision | Append-only decision event | terminal except correction link | Retain with proposal, target-write and prior-event reference. |
| Accepted knowledge | Owning wiki/memory/skill system | owner-defined | SAC stores only reference. |

## Freshness rules

A derived FWK receipt is stale when any referenced revision changes, an
EvidenceRef is no longer resolvable/visible, its TTL expires, an ACL changes,
or an accepted Know-how item becomes withdrawn/stale. `stale` is observable and
not equivalent to deletion. Regeneration must produce a new receipt revision.

## Proposal state machine

```text
proposed → pending-write → accepted
proposed → rejected | dismissed | stale
stale → proposed (new evidence and new proposal revision only)
```

Creation persists an immutable `proposed` record with a proposal revision,
evidence revisions, target intent and idempotency key. Every outcome is an
append-only transition event with an event ID, prior-event ID, correlation ID,
actor/role revision, policy/version, review decision and target-write receipt
where applicable. No record is overwritten to express a transition.

Before creation, a trusted server boundary issues a one-time
`WrapUpProvenance` only from explicit completed Session output or a read-only
Flow wrap-up snapshot. It binds authenticated actor, workspace, source
reference/revision, exact summarized-output digest, evidence revisions and
expiry. SAC verifies and consumes this capability at persistence time. The
stored proposal retains only minimal source metadata; client-provided
session/Flow identifiers never authorize a proposal and SAC never mutates the
referenced Flow snapshot.

`pending-write` is a durable, append-only write-intent before SAC calls an
owner. It binds the proposal revision, trusted reviewer, current security
policy revision, fresh evidence, approval reference, correlation ID and owner
idempotency key. An owner must treat that key as its write deduplication key.
After a crash, recovery first performs an owner-side durable receipt lookup by
intent/key: the owner returns the original write receipt or performs exactly
one write. `accepted` retains the complete receipt binding (intent reference,
proposal/revision/workspace, correlation/idempotency, reviewer authority and
policy revision) and is appended only afterwards. Failed writes append a
non-accepted typed outcome. A correction creates a linked new proposal/target
revision; it never rewrites audit history.

## Access receipt and Context Operations linkage

An AccessReceipt is not a second retrieval trace. It must reference the
canonical Context Operations assembly/trace ID and correlation ID, together
with the assembly/configuration revision, security policy/version, selected
item IDs and omitted item IDs. It may add SAC's authorization outcome, actor
subject hash, workspace reference and retention metadata, but it must not copy
the assembled content, prompt or detector detail. A receipt for an optional
partial result records `partial: true` and all omitted optional IDs; mandatory
overflow records `context_overflow` rather than a successful assembly.

## Append-only integrity boundary

`access-receipts.jsonl` and `activity.jsonl` are append-only local diagnostic
files under the repository's ownership and lock/write discipline. Append-only
does not make them tamper-evident. Until an integrity mechanism exists, readers
must treat them as operational audit metadata, not proof of an external actor's
claim. A future tamper-evident mode must define the writer identity, protected
key/storage boundary, record hash chain or signed checkpoint, verification
command and recovery behavior; it is not implied by this package.

## Deletion and minimisation

SAC deletes derived receipts before primary manifests. Archiving revokes normal
discovery but preserves only policy-permitted audit metadata. Deletion must not
delete Flow, Harness, wiki, memory or source artifacts. A reference to a deleted
target becomes `unresolved`; SAC must not keep a copied fallback.

## Migration and compatibility

Schema versions use additive changes within a major version. Breaking changes
require a new schema major, explicit migration command/flow, backup of primary
manifest and regeneration of derived files. Readers reject unknown major schema
versions rather than guessing semantics.
