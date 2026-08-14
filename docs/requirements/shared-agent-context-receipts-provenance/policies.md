# Shared Agent Context — Receipt and Provenance Policies
Version: 0.1.0

## Status

**Future / planned policies.** They specify future receipt behavior and do not classify current local receipt files as security evidence.

## P-01: Metadata-only policy

Receipt/capsule schemas are allowlists. Any unknown content-bearing field or known forbidden field—retrieved content, prompt, transcript, credential, PII, secret, token, detector detail, or hidden reasoning—is rejected before queue or segment persistence. Digests/references do not authorize retrieval.

## P-02: Source-of-truth policy

Receipts are derived operational metadata. Context Operations owns retrieval traces; source owners own content/revisions; Security owns security decisions; target owners own write receipts. SAC receipts may link these records but cannot replace or synthesize them.

## P-03: Durability-class policy

Policy selects D0/D1/D2/D3 before the operation and stores its version. D3 is mandatory for material/mutation/security boundaries and fails closed on any durable-write uncertainty. D1 sampling and D2 batching are operational optimizations only; they cannot be represented as complete audit coverage.

## P-04: Replay and visibility policy

Replay operates on retained metadata and current authorization. It must not disclose newly hidden references, reconstruct deleted content, or infer a hidden source from a drift error. It reports safe category-level drift and records comparison policy/version.

## P-05: Local integrity-boundary policy

Local segment checksums/hash links and checkpoints are diagnostic mechanisms under the same owner. They may help detect corruption, truncation, or sequence mismatch, but are not tamper-evident and must not be presented as security proof or a verified external claim.

## P-06: Cross-boundary protection policy

Protected anchor/signature mechanisms are introduced only if an explicit trust-boundary policy requires export or verification by a distinct principal/administrator. The policy must name issuer, recipient audience, key/protection boundary, algorithm, rotation/revocation, verification command, retention, and failure behavior. No cloud audit service or signature is required by default.

## P-07: Retention, quota, and repair policy

Retention classes define time/size limits, legal/incident holds, and minimum tombstone/checkpoint preservation. Rotation occurs before configured segment limits are exceeded. Pruning is idempotent and produces a minimised tombstone. Quota pressure first rejects/sheds only policy-permitted D1/D0 work; it never silently evicts D3 records. Corruption is quarantined; repair writes a separate repair record and never rewrites history or invents a missing receipt.

## P-08: Measurement honesty policy

Metrics store measured values with units, source, confidence/availability, and `unknown` where needed. Fabricated zero cost/time/tool-call values are prohibited. No SLO success is claimed until an approved baseline and measurement window exist.
