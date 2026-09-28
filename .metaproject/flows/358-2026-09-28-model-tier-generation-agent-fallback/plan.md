# Implementation Plan

Status: ready

## Approach

Keep `src/gdskills/model-tier.ts` deterministic and pure. Add a generation axis by reusing
`parseModelVersion`/`familyKey` from `src/harness/routing/derive-default-table.ts` (move them to a shared
module if that is needed to avoid an import cycle). Change `light` from "lowest below the session" to "next
step below". Add the agent fallback as an injected port (`RankAgent`) so the module stays free of network
and fs; the caller (`spawn_subagent`, `keryx review tier`) supplies the real implementation, tests supply a
fake.

## Steps

1. T1 context: read model-tier.ts, derive-default-table.ts, model-profile.ts, spawn-subagent-tool.ts, review tier command, compile.ts.
2. T2 generation-aware rank plus step-down `light` (AC1-AC3), with tests.
3. T3 agent fallback port, cache, validation, `agent-ranked` value in schema and types (AC4-AC6).
4. T4 wire the port into `spawn_subagent` and `keryx review tier`; TUI row (AC9).
5. T5 curated lineup and seed; compile.ts regression test (AC7, AC8).
6. T6 docs: both rule copies, README, docs site, CHANGELOG, bump 0.3.27 (AC10).
7. T7 verify and review.

## Risks

- Cross-family comparison by generation is wrong (sonnet 5 vs opus 4.8): only same family and vendor is compared by version.
- The agent fallback spends tokens on every dispatch if the cache misses: cache key is the catalogue hash, and the fallback only runs when ranking is refused or ambiguous.
- No concrete model id may enter rules, skills or dispatch templates: the guard test must pass.
