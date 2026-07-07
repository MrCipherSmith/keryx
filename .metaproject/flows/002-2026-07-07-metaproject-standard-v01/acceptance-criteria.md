# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `gd-metapro flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `gd-metapro flow ac confirm <id> <ACn>`.

## Criteria

- AC1: `gd-metapro standard validate` exists, validates the workspace against `metaproject.schema.json` + profile rules (required files, manifest schema, declared paths, enabled-module manifests, root entrypoints link `.metaproject/index.md`), prints a clear PASS/FAIL report, and exits non-zero when the workspace is non-compliant.
- AC2: `gd-metapro standard doctor` prints actionable diagnostics (each issue with a concrete fix hint) and exits non-zero when unresolved issues exist.
- AC3: `gd-metapro standard capabilities` prints the standard version, active profiles, and each enabled module with its commands/capabilities, sourced from `metaproject.json`.
- AC4: `gd-metapro init` and `gd-metapro update` both write a `metaproject.json` that includes the schema-required `standardVersion` and the `profiles` array; the reference repo's own regenerated manifest validates cleanly against `metaproject.schema.json` (i.e. `standard validate` passes on this repo).
- AC5: New tests cover `standard validate` (a passing workspace and at least two failing cases — missing `standardVersion` and a missing/renamed manifest path), `capabilities` output, and profile evaluation; `bun run check` (typecheck + full test suite) passes.
- AC6: Developer docs are updated to match the implementation — `docs/docs/cli-reference.md` documents the `standard` command and its three subcommands, the README references it, and the `metaproject-standard` spec/PRD status notes no longer describe these three commands as unimplemented; no doc↔code drift remains for the new surface.
