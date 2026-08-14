# Shared Agent Context — Generational Memory Specification
Version: 0.1.0

## Status

Future / planned specification. The contracts below introduce no current CLI,
MCP, agent tool, storage path, or durable SAC knowledge database.

## Related requirements

- [Shared Agent Context design rationale](../shared-agent-context/design-rationale.md)
  defines the FWK and owner-boundary baseline.
- [Keryx Memory Reliability](../keryx-memory-reliability/README.md) remains the
  current owner-memory package; this document does not replace it.
- [Secure Minimal Evidence](../shared-agent-context-secure-evidence/README.md)
  defines the required sealed, scanned, minimised source contract for every
  session-derived observation.

## Identity and ownership

| Generation | Owner | Permitted role | Prohibited role |
|---|---|---|---|
| Ephemeral observation | Trusted Session/Harness | Evidence-linked working input for one Session. | Durable knowledge or automatic recall. |
| Workspace working set | SAC workspace registry | TTL-bound authorised references and selection metadata. | Global/shared durable store or owner-artifact body cache. |
| Durable knowledge | Memory, Wiki, or Skills owner | Reviewed, versioned reusable artifact. | SAC-managed direct write or implicit acceptance. |

SAC resolves references and records minimal receipts. Context Operations remains
the assembly/trace owner; it receives only authorised candidates and still
enforces bounded, progressive reads.

## Planned data contracts

```text
Observation {
  id, sessionRef, evidenceRefs[], subjectHash, observedAt, expiresAt,
  visibility, statementDigest, originRef, originRevision, sourceTrust,
  sensitivity, scanDecision, retentionClass, sourceDeletionState
}

WorkingSetEntry {
  id, workspaceRef, observationRef | ownerArtifactRef,
  purpose, applicability, evidenceRefs[], evidenceDiversity,
  originRef, originRevision, sourceTrust, sensitivity, scanDecision,
  retentionClass, sourceDeletionState, validFrom, validTo?, freshness,
  contradictionSetId?, expiresAt, createdReceipt
}

DurableKnowledgeReference {
  owner: memory | wiki | skill, artifactRef, ownerRevision,
  applicability, evidenceDiversity, sourceTrust,
  originRef, originRevision, sensitivity, scanDecision, retentionClass,
  sourceDeletionState,
  validFrom, validTo?, supersedes[], supersededBy?,
  contradictionSetId?, ownerAcceptanceReceipt
}

Tombstone {
  id, subjectHash, priorReferenceDigest, reason: expired | withdrawn |
  privacy_deleted | policy_deleted, effectiveAt, retainedUntil?,
  originRef, originRevision, sourceTrust, sensitivity, scanDecision,
  retentionClass, sourceDeletionState: deleted,
  reverseLinksState: stale, deletionReceipt
}
```

Every session-derived `Observation` MUST reference a currently valid, sealed
`MinimalEvidence` record admitted under RP-05. Admission and every later
transition re-check origin, sensitivity, scan decision, retention/deletion
state, visibility, and current authorization. Derivation may preserve or lower
trust and preserve or raise sensitivity; it MUST NOT upgrade trust, lower
sensitivity, or use restricted/deleted evidence.

Bodies, raw Session transcripts, prompts, hidden reasoning, credentials and
deleted content are not valid fields in these contracts. IDs are opaque and
all references are resolved with current ACL/owner checks.

## Generational transitions

```text
observation (ephemeral)
  -- explicit admit + TTL --> workspace working set
  -- explicit proposal/review/owner accept --> durable owner artifact
working set -- expiry/withdrawal/deletion --> removed reference or tombstone
durable artifact -- owner supersession/withdrawal/deletion --> reference stale
```

An observation may be rejected or expire without any persistent record beyond
permitted audit metadata. Admission verifies RP-05 evidence validity, access,
sensitivity, scan decision, retention/deletion state, purpose and workspace
scope. Durable acceptance is performed exclusively by an
owner's guarded writer; SAC only learns the resulting reference and receipt.
No transition is automatic and no transition mutates a durable artifact in
place.

## Temporal and contradiction resolution

Temporal validity is interval-based: an item is usable only if its source is
visible, its owner revision is current, `validFrom <= now`, and `now < validTo`
when `validTo` exists. `supersedes` creates an explicit directed relation and
does not erase the older revision. A resolver must treat a missing current
proof, overlapping incompatible intervals, unresolved owner revision, or false
premise as `abstain` unless it can return a visible, applicable, evidence-backed
current item. Restricted, expired, withdrawn, or deleted source evidence makes
the derived item ineligible or stale according to owner policy and cannot be
recovered from an older generation.

A contradiction set groups claims about the same declared subject/predicate and
scope without asserting either claim is false. It contains members, relation
reason, temporal/applicability scope, visibility-safe member count, and a
resolution status: `open`, `superseded`, `withdrawn`, or `resolved-by-owner`.
It must never silently select a member based only on recency or embedding
similarity. Hidden members are neither disclosed nor used as a reason to expose
another hidden item.

## Planned surfaces and configuration

Future surfaces may include workspace-scoped `working-set add/list/expire`,
owner-provided `knowledge explain`, and `memory evaluate --corpus <ref>`.
They must be metadata/reference-oriented and feature-gated. No `remember`
surface may directly write durable owner knowledge.

The planned configuration shape is a versioned policy with: default working-set
TTL and maximum size; allowed owner/artifact kinds; required evidence diversity;
applicability and source-trust thresholds; tombstone retention; deletion
authority; and evaluation corpus revision. Defaults must keep automatic durable
promotion disabled and must not configure a global vector DB. An optional,
owner-scoped index may accelerate candidates only; it is disposable and its
output cannot bypass the resolver.

## Integrations and acceptance criteria

Integrations are limited to trusted Session evidence, workspace registry,
Context Operations, native owner lifecycle APIs, security/retention policy, and
the evaluation harness. Acceptance requires explicit transitions, owner-only
durability, typed abstention, visible contradiction handling, verified deletion
semantics, applicability/evidence-diversity checks, and a passing
multidimensional corpus without automatic promotion or SAC-owned durable bodies.
