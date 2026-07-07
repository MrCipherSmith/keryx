# Implementation Plan

Status: ready

## Approach

Add the standard as an **additive** top-level command family plus manifest
fields, following the existing `cli → commands → feature/service → lib` layering.
The `standard` command is a top-level cross-cutting command (like `rules`), not a
metaproject module. Reuse the existing `src/gdskills/contracts.ts` JSON-Schema
validator for manifest/schema checks; add a small manual `anyOf` check for the
module contract (the validator has no `anyOf`). Make the reference
implementation self-compliant by emitting `standardVersion` + `profiles` from
both generators.

## Steps

1. **T2 — Manifest fields.** In `init.ts` and `update.ts` manifest builders add
   `standardVersion: "0.1.0"`, `profiles` (computed from enabled modules per
   profiles.md), and `updatedAt`. Keep both generators in sync. Update the
   manifest TypeScript types. Add a `STANDARD_VERSION` constant.
2. **T5 — Validator module (`src/standard/`).** Bundle the two schemas
   (`schemas.ts`), implement `validate.ts` (required files, manifest-vs-schema
   via contracts validator + manual module `anyOf`, declared paths exist,
   enabled modules have manifests, root entrypoints link `index.md`), `profiles.ts`
   (evaluate minimal/agent/ci/full requirements), `capabilities.ts` (extract from
   manifest), and a `service.ts` facade returning structured results.
3. **T6 — Command + CLI wiring.** `src/commands/standard.ts` with
   `validate`/`doctor`/`capabilities` sub-handlers (thin: call service, render,
   set exitCode). Register `standard` in `cli.ts` dispatcher + `printHelp()`.
4. **T3 — Tests.** `src/standard/*.test.ts` and/or `src/commands/standard.test.ts`:
   validate passes on a well-formed workspace and fails on missing
   `standardVersion` / missing manifest / broken path; capabilities output;
   profile evaluation. Ensure `bun run check` green.
5. **T7 — Docs.** Update `docs/docs/cli-reference.md` (+ `modules.md`/README as
   needed) and the standard package status notes (mark validate/doctor/
   capabilities implemented). Keep docs/code in sync (no drift).
6. **T4 — Review + draft PR.** code-verifier + focused review; open a draft PR;
   record via `gd-metapro flow implemented 002 --pr <url>`.

## Risks

- **Self-compliance ordering:** adding required `standardVersion` must land with
  the validator so the repo's own manifest validates clean (avoid a red gate).
- **contracts.ts has no `anyOf`/`format`:** handle the module `anyOf` and
  `date-time` format manually rather than extending the validator.
- **Generator drift:** `init.ts` and `update.ts` build the manifest separately;
  both must emit the new fields (same class of bug fixed in PR #2 — consider a
  shared helper).
- **Doc/code drift:** the standard spec marks these commands "planned"; update
  status once implemented so docs match reality.
