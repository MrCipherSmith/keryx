# Implementation Plan

Status: implementation spec / ready to freeze

## What

Implement P5 temporal, configuration, catalog, and compatibility consistency
for the Keryx memory subsystem without changing its canonical Markdown model or
offline lexical floor.

## Why

The memory reliability PRD requires one coherent temporal interval contract,
strict actionable validation, additive configuration compatibility, and
disposable generated data before P6 release verification.

## Approach

Use a narrow shared temporal-validity module, then route existing search,
relevant, and injection consumers through it. Harden config/CLI parsing at the
boundary with structured errors and warnings, remove obsolete config fields,
and make catalog generation explicitly optional while leaving search on direct
Markdown scanning. Add RED tests for date boundaries, config/CLI validation,
catalog absence/deletion, and legacy compatibility before GREEN implementation;
refactor only after the focused suite is green.

## Steps

1. Establish failing P5 temporal/config/catalog/compatibility tests while
   preserving P3/P4 invariants.
2. Implement one calendar-aware exclusive-interval helper and migrate all
   relevant consumers.
3. Validate config and CLI bounds/status/class/query; warn/ignore
   `allowAutoAccept`, remove `template`, and retain known memory types.
4. Reframe `memory index` as a reproducible optional catalog; ensure catalog or
   embedding absence/corruption cannot affect lexical recall.
5. Run focused, changed, type, and appropriate broader gates; update only P5
   checklist/status after evidence is green and prepare verified handoff.

## Risks

- Date parsing must reject impossible calendar days and future dates while
  retaining legacy entries with absent temporal fields as open/current.
- Additive config sections may be absent in old configs; defaults must deep
  merge without weakening hard bounds or accepted-only automatic recall.
- Existing dirty generated artifacts from P2 remain untouched; no cleanup,
  staging, commit, push, PR, or P6 completion occurs in this flow.

## Test Strategy

Use Bun tests following `.metaproject/data/testing/context.md`, with targeted
memory temporal/config/catalog suites first, then `keryx test run --changed`,
TypeScript check, and a scoped broader compatibility gate. Use filesystem
snapshots to prove catalog/embedding deletion leaves lexical output byte-
identical and deterministic, and retain no-network/embedding fallback tests.
