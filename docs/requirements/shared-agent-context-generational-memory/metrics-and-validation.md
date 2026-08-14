# Shared Agent Context — Generational Memory Metrics and Validation
Version: 0.1.0

## Status

Future / planned validation contract. Execution metrics are disabled for this
documentation run.

## Evaluation principles

The corpus is multidimensional: a higher retrieval score cannot compensate for
temporal error, hidden-data disclosure, failed deletion, unsafe promotion, or
failure to abstain. Each case binds immutable fixtures, expected allowed
references, denied references, owner revisions, applicability, evidence
diversity, policy version and oracle result. Corpus data is synthetic or
explicitly authorised; secret/PII fixtures must not escape their test boundary.

## Required corpus dimensions

| Dimension | Required assertion |
|---|---|
| Single-session retrieval | Relevant authorised evidence is found without promoting an observation. |
| Multi-session synthesis | Compatible evidence is combined only when scope/time/trust allow it. |
| Temporal update | Current superseding artifact wins; old revision is not represented as current. |
| Contradiction | Visible incompatible claims form a set or cause abstention; neither silently overwrites the other. |
| False premise | Unsupported premise returns abstention, not a fabricated memory. |
| Applicability | Correct but out-of-scope knowledge is not injected or used as an answer. |
| Evidence diversity | Repeated derivatives of one source do not count as independent corroboration. |
| Selective forgetting | Expiry removes working-set eligibility and derived retrieval copies. |
| Privacy deletion | Body/derived copies are removed as required; only permitted minimal tombstone remains. |
| Access control | Hidden owner artifacts, set members and tombstones produce no existence oracle. |
| Promotion boundary | No corpus path creates durable knowledge without explicit owner acceptance. |
| Secure evidence admission | Every session-derived observation references a valid sealed RP-05 MinimalEvidence record; missing, changed-scan, or unsealed evidence is denied. |
| Sensitivity monotonicity | Observation, working set, durable reference, and tombstone never lower source sensitivity or upgrade source trust. |
| Restricted/deleted propagation | Restricted or deleted evidence is denied across admit, retrieve, promote, and tombstone paths; no older generation remains eligible. |

## Metrics and release gates

Report precision/recall only alongside: temporal-currentness accuracy;
contradiction detection/abstention correctness; false-premise abstention rate;
applicability precision; evidence-diversity integrity; deletion propagation
latency; tombstone minimisation checks; ACL non-disclosure rate; and zero counts
for automatic promotion, SAC durable-body writes, and Flow/workspace mutation.

Release is blocked by any leaked deleted body/embedding, automatic promotion,
global-index authority, stale item presented as current, unresolved
contradiction answered as fact, or hidden-reference disclosure. Compare any
optional index against deterministic owner-scoped baseline by corpus revision;
enable it only if it meets all gates and improves its declared retrieval metric.

The required negative corpus includes restricted-for-audience and deleted
RP-05 evidence at each of `admit`, `retrieve`, `promote`, and `tombstone`, plus
attempted sensitivity downgrade, trust upgrade, stale scan decision, and
retention mismatch. Every case must fail closed without reconstructing source
content or preserving an eligible derivative.
