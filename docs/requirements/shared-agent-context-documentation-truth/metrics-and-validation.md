# Shared Agent Context — Documentation Truth: Metrics and Validation
Version: 0.1.0

## Status

**Future / planned validation.** These measures do not assert present coverage
or gate results.

## Required measures

| Metric | Definition | Gate |
|---|---|---|
| Current-claim evidence | Current implementation/test-total claims with same-commit pinned evidence | 100% |
| Historical labelling | Historical result/count claims explicitly marked historical/stale | 100% |
| Operation-doc coverage | Supported SAC operations with registry-derived/validated docs and help | 100% |
| Example executability | Required examples that pass in isolated expected fixture | 100% |
| Status taxonomy validity | Invalid/ambiguous status combinations in checked docs | 0 |
| Link integrity | Broken internal docs/graph/wiki/evidence links | 0 |
| Graph/wiki coverage | Required SAC roots/edges/pages with source revision marker | 100% or explicit approved gap |
| Drift age | Unresolved high-ranked-source disagreement beyond release threshold | 0 |
| Disclosure regressions | Example/doc output leaks for hidden/denied state | 0 |

## Validation matrix

| Area | Required cases |
|---|---|
| Evidence | Same commit, different commit, missing SHA, changed build tool, missing digest, historical suite total, stale artifact, forbidden raw content. |
| Status | Planned/unverified; implemented-at-commit without current verification; disabled/denied; unavailable/degraded; local-only transport; invalid contradictory combinations. |
| Docs/registry | Current command syntax, deprecated alias, changed default, changed error, removed operation, generated snippet drift, manual override attempt. |
| Examples | Valid local success, expected disabled/denied failure, unsupported transport, pagination/no-resource result, teardown, no network/production mutation. |
| Coverage | Missing SAC root, missing owner edge, stale generation marker, broken wiki link, generated-vs-authored label, graph exists but lacks semantic proof. |
| Non-disclosure | Absent vs hidden resource, error/count/cursor differences, paths/secrets/raw receipt output, unauthorized example invocation. |

## Evidence rules

Validation records capture only commands/fixture IDs, normalised results,
environment scope, commit/build pin, timestamps, digests, and limitations.
They may not capture hidden reasoning, transcripts, secrets, prompts, or hidden
resource content. A metric failure prevents the affected scope from being called
`current-verified`; it never causes a fabricated “all green” aggregate.
