# Shared Agent Context Runtime Truth — Metrics and Validation
Version: 0.1.0

## Validation principle

Correctness is judged against independent source-owner fixtures and returned
FWK bytes, not policy metadata or agent self-report.

## Required metrics

| Metric | Definition | Gate |
|---|---|---|
| Selection fidelity | returned selected IDs equal executed plan IDs | 100% |
| Baseline independence | cases where baseline was derived from candidate data | 0 |
| Mandatory integrity | required ID omitted from successful result | 0 |
| Optional omission completeness | omitted optional IDs reported / actually omitted | 100% |
| ID stability | unchanged canonical refs retaining ID after reorder/edit | 100% |
| Retarget incidents | old ID resolving to another canonical ref | 0 |
| Freshness correctness | source mutation cases classified correctly | 100% |
| Detail usefulness | eligible reads returning bounded content or explicit metadata-only | 100% |
| Cost honesty | cost fields measured or explicitly unknown | 100% |
| Hidden disclosure | hidden IDs/refs appearing in plan/explain/result | 0 |
| Surface parity | normalized CLI/MCP/shell corpus equality | 100% |

## Fixed corpus

- Empty workspace and mandatory-core-only workspace.
- 1, 32, 33, and 10,000 optional descriptors.
- Required item larger than token budget.
- Reorder, insert, delete, rename display title, content edit, canonical ref move.
- Pinned fresh, pinned changed, unpinned, expired, withdrawn, and denied sources.
- Candidate exact baseline, strict subset, unknown ID, duplicate ID, mandatory
  removal, hidden ID, timeout, malformed output.
- Detail owners returning body, metadata-only, redacted, changed, and denied.
- CLI, stdio MCP, and shell adapter parity.

## Mandatory falsifiers

1. Configure a candidate that selects one of two baseline-authorized items. The
   receipt attribution and returned manifest must both show the candidate and
   one selected item.
2. Configure a report whose candidate contains an ID absent from an independently
   executed baseline. Activation must fail.
3. Register 33 optional items under a 32-item budget. The operation must succeed
   partially instead of overflowing.
4. Reorder resources between overview and read. An old stable ID must resolve to
   the same canonical owner reference or report changed/unavailable, never a
   different item.
5. Edit an unpinned evidence file. The next read must not label it fresh.
6. Remove the cost probe. Output must say unknown rather than zero.

## Performance and operability

Report, without a default improvement claim:

- p50/p95/p99 planning and assembly latency;
- descriptor count and peak memory;
- token estimation error;
- receipt append latency and bytes per read;
- cache hit/miss and drift-rebuild count;
- performance at 1, 100, and 10,000 descriptors.

## Rollout gates

1. Characterization failures are committed before implementation.
2. Deterministic plan passes correctness/property corpus.
3. Stable-ID migration and rollback are verified.
4. Owner detail adapters pass redaction and bounds tests.
5. Adapter parity passes.
6. Candidate stays shadow-only until an independent task corpus proves benefit
   and every security non-regression gate passes.

## Incident triggers

Disable the corrected path or candidate immediately on hidden disclosure,
retargeted ID, fabricated cost, required-item omission, plan/manifest mismatch,
or source mutation reported as fresh. Preserve metadata-only evidence and fall
back to the pinned deterministic baseline.
