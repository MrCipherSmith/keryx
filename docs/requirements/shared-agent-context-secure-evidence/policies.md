# Shared Agent Context — Secure Minimal Evidence: Policies
Version: 0.1.0

## Status

**Future / planned policy.** Security and owner policies already in force stay
authoritative until an approved implementation adopts this contract.

## P-1: Data minimisation and schema closure

- Persist only `MinimalEvidence` fields defined by the specification after a
  successful pre-persistence scan/minimisation decision.
- Full transcript, message history, prompts, hidden reasoning, tool traces,
  credentials, PII beyond explicitly approved redacted fields, and arbitrary
  attachments are denied from the normal SAC data plane.
- Unknown fields fail closed. A new field requires schema, Security, lifecycle,
  and abuse-corpus review before enablement.

## P-2: Sealing and provenance

- Only the Harness/session owner may seal terminal session output and issue a
  one-time `WrapUpProvenance` capability.
- Provenance is bound to session revision/digest, actor, workspace/Flow scope,
  expiry, use state, and Security policy version. Client payloads cannot mint,
  edit, transfer, or replay it.
- A non-terminal, expired, consumed, cross-workspace, or revision-mismatched
  provenance is denied without persisting candidate content.

## P-3: Security gate and trust propagation

- Security scans and minimises before persistence; SAC treats unavailable,
  indeterminate, failed, or approval-required outcomes as non-authorising.
- Derived trust cannot exceed source trust; derived sensitivity cannot be below
  source sensitivity. Multiple sources use the least trust/highest sensitivity
  unless a stricter owner rule applies.
- Receipts store only permitted decision metadata/digests, never detector detail
  that recreates restricted content.

## P-4: Archive exception

- Archive is off by default and is prohibited from the normal proposal path.
- Enabling it requires documented lawful/operational purpose, Security/Harness
  ownership, explicit audience/ACL, protected storage and key controls, finite
  expiry, deletion/crypto-erasure method, revocation process, and audit.
- Archive access never promotes or writes knowledge. Any extracted content is
  treated as untrusted and requires a fresh schema/scan/minimisation pass.

## P-5: Retention, deletion, and incident response

- TTL is a deadline, not deletion evidence. Expiry triggers a deletion job or
  verified cryptographic inaccessibility plus a minimised deletion receipt.
- A deleted record is not restored through SAC. References become
  `deleted`/`unresolved`; source owners govern any lawful recovery separately.
- Security incidents, revoked access, failed deletion, or classification change
  block new use, invalidate derived records, preserve only permitted audit
  metadata, and route remediation to the source/security owner.

## P-6: Promotion and owner boundaries

- Minimal evidence creates at most an immutable `proposed` candidate. It is not
  accepted Know-how and cannot auto-promote.
- Only a target owner’s guarded writer may alter Wiki, Memory, or Skills; Flow
  state changes use Flow’s native interface, never SAC.
- Context Operations remains the canonical assembly/trace owner. SAC must not
  construct a competing transcript or retrieval ledger.
