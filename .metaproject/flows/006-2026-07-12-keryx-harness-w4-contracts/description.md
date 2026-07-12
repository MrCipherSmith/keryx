# Flow 006 — W4 contracts (C-01…C-03)

Status: formalized
Source: user description (harness implementation runbook, Phase 4)

## Problem

The harness has 35 frozen JSON schemas + a version registry + committed
fixtures, but no code registry, no validator, and no runnable fixture matrices.
Before ports (W5) and the fake provider (W6) can persist/validate typed payloads,
W4 must: register every durable/public payload with stable `$id`/owner/persistence/
migration policy (C-01), provide a **deterministic** validator covering every JSON
Schema keyword the 35 schemas actually use (C-02, no external Draft 2020-12
dependency — D-07 deterministic floor), and add positive/negative/mutation/
migration/fixture-hash matrices per family (C-03).

## Expected Outcome

- **C-01 (docs)** — `docs/decisions/keryx-harness/contract-inventory.md` lists all
  35 schemas (+registry) with `$id`, owner, persistence, migration policy (from
  `schema-version-registry.json`); zero gaps.
- **C-02 (implement)** — `src/contracts/` deterministic validator covering the
  exact used-keyword set + a keyword-coverage proof (used ⊆ supported); no
  external dependency; reads frozen schemas via a DI'd path.
- **C-03 (test)** — fixture matrices in `src/contracts/` driven by
  `schemas/fixtures/fixture-matrix.json` + catalogs: positive validates, negative
  rejects, plus mutation/migration/fixture-hash; deterministic.

## Out of Scope (do NOT touch)

- Any wave other than W4. No ports/provider/runtime code (W5+); `src/harness/`
  stays reserved (empty).
- The frozen requirements package (`docs/requirements/keryx-project-agent-harness/`)
  — read/cite the 35 schemas + fixtures, never edit them.
- ADR-0001…0004 and the W1 registry — edits only via new deliverables.
- No new production dependency (no external Draft 2020-12 lib).
- Schema bundling into the package (deferred to W5+ runtime) — W4 reads the frozen
  schemas via a DI path (single source, no duplication).
