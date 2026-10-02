# Implementation Plan

Status: final

## Approach

Add `src/harness/external/strict-schema.ts` with `toStrictOutputSchema(bundled)` and `dropOptionalNulls(value, bundled)`. runtime.ts stages the strict document as its own file for codex (`resultSchemaPath`), keeps the full schema for validation, and strips optional nulls from a codex final message before validating. Alternative considered: drop `--output-schema` for codex; rejected because it removes the decoding constraint for no reason the transform cannot solve.

## Steps

1. Transform and reverse step with unit tests.
2. Wire into runtime.ts, tests for codex path.
3. Live probe of the strict document against codex, journal it.
4. Docs, CHANGELOG, version 0.3.43, PR, review, release, live smoke.

## Risks

- The validator may reject something the transform keeps; the live probe (AC4) is the check.
- A null stripped from a property the model meant as a real value; limited to properties the schema never required.
