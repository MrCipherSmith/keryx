# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: `renderMetaprojectGitignoreBlock()` ignores concrete catalog/index,
  embedding, legacy artifact, runtime report, staging, and lock paths while
  leaving `.metaproject/memory/decisions/example.md` and
  `.metaproject/memory.config.json` trackable under Git matching.
- AC2: Init and update integration tests create temporary Git repositories and
  prove the generated ignore policy with `git check-ignore` for every generated
  class plus a canonical memory entry.
- AC3: Generated index and embedding outputs can be produced after init, are
  ignored, and are reproducible across repeated generation without changing
  canonical Markdown memory.
- AC4: Generated index, manifest, memory skill, dashboard, verifier, and
  documentation templates no longer scaffold or use legacy
  `data/memory/artifacts/latest.{md,json}` paths; verifier consultation uses
  explicit structured memory evidence.
- AC5: Init/update detect legacy memory artifacts and emit a clear advisory
  migration diagnostic that never deletes files, invokes `git rm`, or mutates
  the Git index.
- AC6: CLI/setup documentation explains canonical versus generated memory data,
  explicit report/runtime locations, and safe downstream migration.
- AC7: The currently tracked dirty Keryx legacy artifacts are preserved without
  staging or destructive deletion; the completion report records exact P2-3
  handling and concern if repository-source removal remains unsafe.
- AC8: Focused P2 tests, TypeScript typecheck, and suitable broader checks pass;
  no P3 runtime authority surfaces are modified.
