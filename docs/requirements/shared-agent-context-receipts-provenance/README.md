# Shared Agent Context — Receipts, Provenance, and Operability
Version: 0.1.0

## Status

**Future / planned requirements.** RP-10 defines a future operational-receipt model. It does not claim that current read receipts expose lifecycle, accurate cost, batching, replay, quota, or protected-anchor behavior.

## Purpose

Make SAC context retrieval diagnosable and replayable with bounded metadata while keeping receipts out of the raw-content and security-evidence business by default.

## Document index

| Document | Purpose |
|---|---|
| [README.md](README.md) | Package status, scope, and index. |
| [prd.md](prd.md) | Problem, goal, requirements, risks, and recommendation. |
| [specification.md](specification.md) | Capsule, replay/drift, durability, storage, and planned operation contracts. |
| [policies.md](policies.md) | Metadata minimisation, integrity-boundary, retention, and quota policies. |
| [artifact-lifecycle.md](artifact-lifecycle.md) | Receipt, segment, capsule, checkpoint, pruning, and repair lifecycle. |
| [metrics-and-validation.md](metrics-and-validation.md) | Validation corpus, read SLO definitions, and operational measures. |
| [implementation-plan.md](implementation-plan.md) | Phased future delivery and activation gates. |

## Scope

- Metadata-only context capsules and replayable drift explanations.
- Explicit receipt durability classes, deterministic sampling, and safe batching.
- Segment retention, rotation, pruning, verification, repair, and quota behavior.
- Clear distinction between operational provenance and protected security evidence.
- Read-path SLO definitions based on future measured baselines.

## Non-goals

- Persisting retrieved content, prompts, transcripts, credentials, PII, detector details, or hidden reasoning in a receipt/capsule.
- Calling local hash-linked files security evidence or tamper-evident.
- Requiring cloud audit services, signatures, or protected anchors inside one trusted local owner by default.
- Replacing source-owner audit, security, or target-write receipts.

## Related requirements

- [Shared Agent Context artifact lifecycle](../shared-agent-context/artifact-lifecycle.md)
- [Shared Agent Context metrics and validation](../shared-agent-context/metrics-and-validation.md)
- [Promotion semantics and integrity](../shared-agent-context-promotion-integrity/README.md)

## Completion condition

This documentation package is complete when its links, versions, future status, and cross-document contracts remain consistent. Runtime activation requires the validation and measurement gates in [metrics-and-validation.md](metrics-and-validation.md).
