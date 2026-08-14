# Shared Agent Context — Receipts, Provenance, and Operability PRD
Version: 0.1.0

## Status

**Future / planned.** The requirements describe a target operational model and make no claim that the current receipt path reports real cost or has a surfaced lifecycle.

## Problem

Context reads need provenance that can explain what was selected and why, but receipts must not become a second content store or a false security log. Synchronous local appends can add read-path cost, existing receipt costs can be placeholder values, and operators lack explicit retention, quota, pruning, verification, repair, and replay/drift behavior. Local hash-linked files are useful operational metadata but do not prove a claim to an external principal.

## Goal

Provide future context capsules and operational receipts that reconstruct the metadata decision for a read, classify drift on replay, choose durability proportional to materiality, and remain bounded through explicit lifecycle controls.

## Users

- Agents and operators explaining an authorised context result without seeing copied source content.
- Owners diagnosing source/ACL/policy/selection drift.
- Storage operators managing receipt growth, retention, verification, repair, and quotas.
- Security reviewers deciding when a cross-principal/export trust boundary needs protected anchoring.

## Requirements

1. Every context capsule and receipt shall contain metadata/references/digests only; raw retrieved content and sensitive execution material are forbidden.
2. A capsule shall bind workspace revision, retrieval-plan digest, selected/omitted item IDs and source revisions, policy/configuration revision, authorization outcome class, and a ledger checkpoint/reference.
3. Replay shall recompute permitted metadata and classify drift as source, ACL/visibility, policy/configuration, selection/budget, owner-reference, or no drift. It shall not reread hidden content merely to explain drift.
4. Receipts shall use named durability classes with clear acknowledgement semantics. Material security or mutation boundaries require synchronous durable receipts; low-risk reads may use durable queues or deterministic sampling under policy.
5. Batching/sampling shall not silently weaken a required durability class. Queue failure, quota exhaustion, or uncertain append state blocks a mandatory receipt-dependent operation.
6. Receipt lifecycle shall define retention, rotation, pruning, verification, repair, and per-workspace/project quotas with minimised tombstones and operator-visible states.
7. Operational metadata shall be explicitly distinct from security evidence. Local checksums/hash links can help detect accidental loss or reordering under the same owner but are not security proof. Protected anchors/signatures are required only when a configured trust boundary is crossed.
8. Future read SLOs shall use measured latency/availability/receipt-overhead definitions and configured targets, not fabricated cost fields or unverified performance claims.

## Success criteria

- A capsule explains a context result with no raw source content and reproduces deterministic drift classification.
- A mandatory receipt is either durably recorded at its required class or the dependent operation fails closed.
- Rotating/pruning a segment preserves required checkpoints/tombstones and never breaks a valid capsule explanation.
- Verify/repair identifies corrupt or missing records without inventing evidence; quota handling never evicts required records silently.
- A protected anchor is absent in a one-owner local deployment and required only by an explicit cross-principal/export policy.

## Risks and recommendation

Too much receipt data can harm the very read path SAC is meant to improve; too little can hide drift. Start with metadata-only capsules and classed durability, measure local baselines, then enable batching/sampling only where failure semantics are explicit. Keep cross-boundary anchors optional-by-policy rather than imposing signatures or cloud audit everywhere.
