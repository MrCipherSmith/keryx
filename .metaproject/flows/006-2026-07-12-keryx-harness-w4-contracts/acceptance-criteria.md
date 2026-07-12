# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: C-01 — `docs/decisions/keryx-harness/contract-inventory.md` registers every one of the 35 schemas (plus `schema-version-registry.json`) with its stable `$id`, owner, persistence class, and migration policy sourced from `schema-version-registry.json` (storedVersion/acceptedRange/migrationId); there are zero missing rows (all 35 present, grouped by family).
- AC2: C-02 — a deterministic validator exists in `src/contracts/` that supports every JSON Schema keyword actually used by the 35 schemas — `type, $ref (cross-file + local $defs), required, properties, additionalProperties(bool), enum, const, items, minLength, maxLength, pattern, format:date-time, minimum, maximum, minItems, maxItems, uniqueItems, allOf, oneOf, if/then` — and ships a keyword-coverage proof asserting used ⊆ supported; no external Draft 2020-12 library is added; the validator is deterministic (no Date.now/network/IO beyond reading schema files).
- AC3: C-03 — fixture matrices under `src/contracts/` drive the validator over `schemas/fixtures/fixture-matrix.json` such that every family's positive case validates and its negative case is rejected, plus mutation, migration (storedVersion/acceptedRange), and fixture-hash matrices; all deterministic; the suite is RED before C-02 and GREEN after.
- AC4: No regression and no new dependency — `tsc --noEmit` is clean, the full `bun test` suite is ≥ the pre-change baseline of 554 pass with the new tests green and 0 fail, and `package.json`/lockfile add no new production dependency.
- AC5: Scope — the frozen requirements package (`docs/requirements/keryx-project-agent-harness/`, incl. the 35 schemas and fixtures) and ADR-0001…0004 are NOT modified; all new code lives under `src/contracts/` and new docs under `docs/decisions/keryx-harness/`; `src/harness/` remains reserved (untouched).
