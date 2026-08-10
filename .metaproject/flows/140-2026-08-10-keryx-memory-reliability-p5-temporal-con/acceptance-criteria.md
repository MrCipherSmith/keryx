# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: One shared temporal-validity helper is used by general memory search, relevant automatic recall, and procedural injection; no consumer duplicates the interval rule.
- AC2: Current and as-of queries use `validFrom <= t < validTo`, reject impossible calendar dates and future query dates, and cover leap-day, boundary-equal, expired, future, and no-bound entries.
- AC3: CLI/config parsing validates status, class, query, result/report/injection limits, and byte bounds with structured actionable errors while preserving defaults when additive config sections are absent.
- AC4: `allowAutoAccept` is deprecated and ignored; configured `true` produces a warning, and ingest/reflection plus every automatic path remain draft-only with no implicit acceptance.
- AC5: The unused `MemoryTypeConfig.template` field is removed or otherwise no longer constrains known types; all known memory types remain accepted by defaults, old configs still load, and tests/docs/schema agree.
- AC6: `memory index` keeps its command name but reports/builds an optional reproducible generated catalog; search does not claim, read, or depend on the catalog.
- AC7: Missing catalog is not an integrity failure; stale/corrupt catalog states, if diagnosed, are advisory warnings only and do not alter recall success.
- AC8: Deleting catalog and embedding files leaves lexical search output byte-identical and deterministic; rebuilding the catalog is reproducible and no-network behavior remains intact.
- AC9: Legacy entries/configs and temporal, typing, dedup, embedding, no-network, CLI/config, and catalog compatibility suites pass; only P5 checklist/status is updated after verification.
