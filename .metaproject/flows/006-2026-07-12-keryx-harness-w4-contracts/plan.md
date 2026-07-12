# Implementation Plan — Flow 006 (W4 contracts)

Status: frozen scope (W4 only)

## Approach

Build a code contract layer over the 35 frozen schemas: an inventory (C-01), a
deterministic validator in a new `src/contracts/` module covering the exact
used-keyword set with a coverage proof (C-02), and fixture matrices driving that
validator over the committed positive/negative catalogs (C-03). No external
Draft 2020-12 dependency (D-07 deterministic floor); schemas read from the frozen
dir via a DI path (single source). TDD: C-01 → C-03 RED → C-02 GREEN → verify.

## Worker routing & Model Policy

| Task | Kind | Worker | Model | Rationale |
|---|---|---|---|---|
| T1 | context | orchestrator inline | Haiku-class | schema map + used-keyword set + fixtures inventory (done) |
| T5 (C-01) | docs | job-documenter | **Haiku 4.5** | mechanical inventory from schemas + version registry |
| T6 (C-03) | test | tests-creator | **Sonnet** | fixture matrices, RED before validator |
| T7 (C-02) | implement | task-implementer | **Opus 4.8** | deterministic validator + keyword coverage (logic) |
| T8 | review | review-orchestrator | **Opus 4.8** | code-verifier + coverage completeness + no-dep + frozen untouched |
| T2/T3/T4 | umbrella | orchestrator | Opus | seed phases |

Orchestrator = Opus. Workers via `subagent-dispatch` → `subagent-result`.

## Steps

1. T1: schema map + authoritative used-keyword set + fixtures inventory (context.md).
2. T5 (C-01): `docs/decisions/keryx-harness/contract-inventory.md` — every schema
   (+registry) with `$id`, owner, persistence, migration policy (from
   `schema-version-registry.json`); zero gaps; linked to the registry.
3. T6 (C-03): RED tests + matrices in `src/contracts/` driven by
   `fixture-matrix.json` + catalogs: per-family positive validates / negative
   rejects; mutation, migration (`storedVersion`/`acceptedRange`), fixture-hash;
   deterministic. RED before C-02 exists.
4. Orchestrator validates the C-03 test intent (drives fixture-matrix; deterministic).
5. T7 (C-02): implement `src/contracts/{validator,resolver,keyword-coverage}.ts`
   covering the full used-keyword set (`const/maximum/maxLength/minItems/maxItems/
   uniqueItems/allOf/oneOf/if-then/format:date-time/$defs+cross-file $ref`); prove
   `used ⊆ supported`; make C-03 green; no external dependency.
6. T8: `tsc --noEmit` + full `bun test` (≥554 + new green); coverage completeness;
   `package.json`/lock unchanged (no new prod dep); frozen pkg untouched.
7. `keryx health run`; confirm ACs; completion choice (ask user A/B/C).

## Verification (TDD, real code)

C-03 RED before C-02, GREEN after. Gate: `tsc` clean; full `bun test` ≥ baseline
554 + new tests green; keyword-coverage asserts every used keyword is supported;
no new production dependency.

## Risks

- **Missed keyword** → used-keyword set extracted authoritatively from all 35
  schemas; C-02 coverage proof asserts `used ⊆ supported`; C-03 exercises every
  family via fixture-matrix.
- **$ref/$defs resolution bugs** (cross-file + local pointers) → dedicated
  resolver + fixtures that exercise `harness-envelope#/$defs/schemaVersion`.
- **Accidental external dep** → AC forbids new prod dep; T8 checks package.json/lock.
- **Editing frozen schemas/fixtures** → read-only DI path; new code only in
  `src/contracts/`; inventory in `docs/decisions/keryx-harness/`.
- **Non-determinism** → no Date.now/network/IO beyond reading schema/fixture files.
