# Tasks — Flow 006 (W4 contracts)

Task definitions live here; task **statuses** live in flow.json and are managed
only via `keryx flow task done <id> <taskId>`.

Scope: **only W4** (implementation-plan.md §W4). No external Draft 2020-12
dependency. `src/harness/` reserved (untouched).

| ID | Kind | Model | Title / definition |
|----|------|-------|--------------------|
| T1 | context | Haiku | Schema family map + authoritative used-keyword set + fixtures inventory (context.md). |
| T2 | implement | — | Umbrella: implement per plan (closed when T7 done). |
| T3 | test | — | Umbrella: TDD tests (closed when T6 authored + T7 makes them green). |
| T4 | review | — | Umbrella: self-review + completion prep (closed when T8 + completion done). |
| T5 | docs (C-01) | Haiku | `docs/decisions/keryx-harness/contract-inventory.md`: all 35 schemas (+registry) with stable `$id`, owner, persistence, migration policy (from `schema-version-registry.json`); zero gaps; grouped by family. Reviewer: contract. |
| T6 | test (C-03) | Sonnet | RED matrices in `src/contracts/`: per-family positive-validates / negative-rejects driven by `schemas/fixtures/fixture-matrix.json` + catalogs; mutation, migration (`storedVersion`/`acceptedRange`), fixture-hash; deterministic ids/clock. RED before C-02. Reviewer: testing. |
| T7 | implement (C-02) | Opus | `src/contracts/{validator,resolver,keyword-coverage}.ts`: deterministic validator covering the full used-keyword set (const/maximum/maxLength/minItems/maxItems/uniqueItems/allOf/oneOf/if-then/format:date-time + local `$defs` + cross-file `$ref`); `used ⊆ supported` proof; reads schemas via DI path; make C-03 green; NO external dependency. Reviewer: contract/logic. |
| T8 | review | Opus | code-verifier (`tsc --noEmit` + full `bun test` ≥ 554 + new green); assert keyword coverage complete; `package.json`/lock unchanged (no new prod dep); frozen requirements pkg + ADRs untouched. |
