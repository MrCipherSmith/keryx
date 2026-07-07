# Tasks

Task definitions live here; task **statuses** live in flow.json and are managed
only via `gd-metapro flow task done <id> <taskId>`.

| ID | Kind | Title | Satisfies |
|----|------|-------|-----------|
| T1 | context | Collect context and blast radius (done in Phase 1) | — |
| T2 | implement | Manifest standard fields: `standardVersion` + `profiles` + `updatedAt` in `init.ts`/`update.ts`/types | AC4 |
| T5 | implement | `src/standard/` module: bundled schemas + validator + profile eval + capabilities | AC1, AC2, AC3 |
| T6 | implement | `src/commands/standard.ts` (`validate`/`doctor`/`capabilities`) + `cli.ts` wiring + `printHelp` | AC1, AC2, AC3 |
| T3 | test | Tests for validator, command, and manifest fields; `bun run check` green | AC5 |
| T7 | docs | Update `docs/docs/cli-reference.md` + README + standard spec status | AC6 |
| T4 | review | code-verifier + focused review; open draft PR | AC5 |

## Task detail

- **T2:** Add `STANDARD_VERSION = "0.1.0"`. Both manifest generators emit
  `standardVersion`, `profiles` (computed from enabled modules per profiles.md),
  and `updatedAt`. Update manifest TS types. The repo's own regenerated manifest
  must satisfy `metaproject.schema.json`.
- **T5:** `schemas.ts` (bundled copies of the two JSON schemas), `validate.ts`
  (required files, manifest-vs-schema via `contracts.ts` + manual module `anyOf`,
  declared paths exist, enabled modules have manifests, root entrypoints link
  `.metaproject/index.md`), `profiles.ts` (minimal/agent/ci/full), `capabilities.ts`,
  `service.ts` facade with structured results.
- **T6:** Thin handlers; `validate`/`doctor` set non-zero exit on violations;
  `capabilities` prints standard version, profiles, modules + commands.
- **T3:** Cover pass + fail (missing `standardVersion`, missing manifest, broken
  path), capabilities output, profile evaluation.
- **T7:** Mark the standard commands implemented; keep docs↔code in sync.
