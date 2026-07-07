# Context

Enriched by flow-orchestrator (Phase 1) from the standard package and code.

## Standard package (source of truth for requirements)

- `docs/requirements/metaproject-standard/specification.md` — required files,
  manifest fields, module contract, artifact contract, validation requirements.
- `docs/requirements/metaproject-standard/profiles.md` — minimal / agent / ci /
  full profile requirements.
- `docs/requirements/metaproject-standard/artifact-lifecycle.md` — canonical /
  generated / transient rules.
- `docs/requirements/metaproject-standard/schemas/metaproject.schema.json` —
  required: `schemaVersion`, `standardVersion`, `createdBy`, `paths`, `modules`.
- `docs/requirements/metaproject-standard/schemas/module.schema.json` —
  required: `enabled`, `manifest`, anyOf(data/core/skills/projectSkills/wiki/memory).

## Impacted code (blast radius)

- `src/commands/init.ts` — builds the manifest object (add `standardVersion`,
  `profiles`, `updatedAt`).
- `src/commands/update.ts` — regenerates the manifest (same fields; keep in sync
  with init).
- `src/lib/templates.ts` — renders `.metaproject/index.md`, `README.md`,
  dashboard; may reference the standard version.
- `src/cli.ts` — dispatcher + `printHelp()`; register the `standard` command.
- `src/gdskills/contracts.ts` — existing hand-rolled draft-2020-12 JSON-Schema
  validator (`CONTRACTS`, `validateAgainstSchema`); REUSE for manifest validation
  (supports $ref, type/enum/required/properties/additionalProperties/pattern/
  minLength/minimum/items — no `format`, no `anyOf`, so the module `anyOf` needs a
  small manual check).
- `src/commands/module-commands.ts` — MODULE_COMMANDS (single source of truth for
  module command lists); reuse for `capabilities` output.

## New code

- `src/standard/` — `types.ts`, `schemas.ts` (bundled copies of the two JSON
  schemas), `validate.ts`, `profiles.ts`, `capabilities.ts`, `service.ts`.
- `src/commands/standard.ts` — `validate` / `doctor` / `capabilities` handlers.

## Constants

- `STANDARD_VERSION = "0.1.0"` (matches the draft package).
- Reference-implementation default profiles for a full workspace: `["minimal",
  "agent", "ci", "full"]` (all 8 modules enabled) — compute from enabled modules
  per `profiles.md`, do not hardcode blindly.

## Baseline

- `bun run check` green at flow start (typecheck + tests). Health gate: warn.
- CLI conventions: thin `commands/*` handler → `<feature>/` service → `lib/*`;
  handlers own `process.exitCode`; JSON schemas validated via contracts.ts.
