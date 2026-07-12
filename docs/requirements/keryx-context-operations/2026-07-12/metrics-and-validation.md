# Context Operations — Metrics and Validation
Version: 1.0.0

## Validation principles

No benchmark claim is valid without committed fixtures, explicit baseline,
model/provider configuration, timing environment and raw report. Evals measure
the whole task, not only semantic similarity.

## Required metrics

| Metric | Definition | Gate |
|---|---|---|
| Provenance coverage | selected items with resolvable source/hash ÷ selected items | >= 95% corpus median; 100% for mandatory items |
| Policy inclusion | mandatory policy/AC items present when applicable | 100% |
| Stale-source precision | items correctly labelled stale ÷ stale labels | report, then threshold after corpus maturity |
| Retrieval recall@5 | queries with approved source in top 5 | must not regress vs deterministic baseline |
| Context budget compliance | manifests within all configured bounds | 100% |
| Unsafe promotion rate | untrusted feedback promoted without review | 0 |
| CLI/MCP parity | semantically equivalent fixture outputs | 100% |

## Test matrix

- Unit: scoring, budget allocator, temporal/status filtering, source hashing.
- Contract: all JSON schemas accept positives and reject negatives, включая
  `context_overflow`, adapter descriptors и enabled network adapter без
  `capabilityId`.
- Security: injection/secret/PII feedback does not enter accepted memory.
- Integration: source services available/unavailable/stale combinations.
- Replay: same commit/config/query produces equivalent normalized manifest.
- Capability: semantic and adapter paths are absent from disabled imports and
  no-network tests.
- Corpus: `fixtures/context-operations/cases.json` содержит code navigation,
  architecture, decision, review, conflict, poison и budget-overflow scenarios;
  каждый case перечисляет expected mandatory и forbidden source IDs.

## SLO proposals

R0 should target <= 2 seconds p95 deterministic assembly and <= 256 KiB
rendered context on a documented developer-class benchmark environment. Эти
ceiling требуют будущего baseline report и не являются текущими performance
claims.
