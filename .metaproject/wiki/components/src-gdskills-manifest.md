# Module src/gdskills/manifest

Version: 1.0.0
Type: component
Status: accepted

## Summary

`src/gdskills/manifest` is the manifest-driven install path for bundled skills and rules: it validates the bundled install manifest, plans which files to write for a harness target, applies that plan with drift-safe writes, and records per-target install state.

## Overview

This module owns the install manifest model for bundled skills and rules. It loads `src/gdskills/bundled/install-manifest.json`, validates it against the agent-platform install-manifest schema, and turns a profile plus `--with`/`--without` flags and optional stack detection into a deterministic install plan. It then writes the planned files and keeps a per-target record of what it wrote in `.metaproject/data/skills/install-state/<target>.json`. According to the code graph, `src/commands` consumes it.

## How it works

The module has three layers, one per stage of an install, plus a state file.

`manifest.ts` holds the types (`InstallManifest`, `ManifestProfile`, `ManifestComponent`, `ManifestModule`, `HarnessId`), schema validation (`parseInstallManifest`, `loadBundledManifest`), and path resolution. `defaultBundledSourceRoot` handles both the source tree and the flat packaged `dist/cli.js` layout, so the manifest is found in either.

`plan.ts` is selection and lookup, and it does not write anything. `planInstall` checks the target against `SUPPORTED_TARGETS` (`claude` and `keryx-shell`), then calls `selectModules` to resolve profile to components to modules, including the dependency closure and `--with`/`--without`. Each selected module's glob paths are mapped to destinations by `destinationFor`, a per-target table. Problems are collected into `InstallPlan.errors` rather than thrown, and `ok` is false when any exist. `destinationRootsForTarget` exposes the same roots to other code, so the orphan scan cannot drift from what install writes.

`apply.ts` executes a plan. `applyInstall` refuses a plan with errors or an unreadable prior state. It checks every recorded path with `resolveContainedPath` before using it. An existing file that is unrecorded or whose hash has drifted is skipped unless `force` is set. Writes go through `writeContained`, and `writeSkillsInstallState` then records the result.

`state.ts` owns the install-state file. `readSkillsInstallState` returns only schema-valid state. `skillsInstallStateIsUnreadable` tells a corrupt file apart from one that does not exist yet. `resolveContainedPath` rejects absolute paths, `..` segments, backslashes, paths outside the destination roots, and any path that goes through a symlink. `writeSkillsInstallState` upserts module records and removes the file when none are left.

`index.ts` is a barrel that re-exports all of these, plus the `doctor` and `uninstall` modules.

## Key concepts

- **Profile** (`ManifestProfile`): a named selection of `modules` and `components`, such as `full` or a per-stack profile. A profile with `stackDetectionAware` gates its components by detection markers.
- **Component** (`ManifestComponent`): a family-tagged group of modules, with optional `detectionMarkers`. Components are how stack packs get pulled in.
- **Module** (`ManifestModule`): a unit of content with a `kind`, `paths`, `targets`, `dependencies`, `defaultInstall`, `cost` and `stability`. Only `rule` and `skill` modules have an install destination in v1. A `hook-runtime` module always fails a plan.
- **defaultInstall**: profile-listed modules always install. A component-sourced module installs only when `defaultInstall` is true, when it was named by `--with`, or when another selected module depends on it.
- **Harness target** (`HarnessId`): the harness a plan is for. `HARNESS_IDS` is the runtime mirror of the schema enum, and the plan accepts only `SUPPORTED_TARGETS`.
- **Install state** (`InstallState`, `InstalledModuleRecord`): the per-target record of `installedModules`, with `writtenPaths`, a sha256 per path, and the profile. It is the basis for drift detection and for what doctor and uninstall may touch.

## Main flows

1. **Plan.** `loadBundledManifest()` returns the validated manifest. `planInstall({ manifest, profileId, with, without, target, stack, repoRoot })` checks the target, then runs `selectModules`. Each `--with` and `--without` id must change the resulting plan, or the plan fails. Glob paths are resolved, each source goes through `destinationFor`, and each file is hashed. A collision check rejects two sources that write the same destination. The result is an `InstallPlan`.
2. **Apply.** `applyInstall(plan, destRoot, { sourceRoot })` first refuses a plan with errors, a corrupt prior state, or a recorded path that fails `resolveContainedPath`. For each planned file it skips an existing file that is unrecorded or drifted, unless `force` is set. Otherwise it writes the file and hashes it. It then calls `writeSkillsInstallState` with the module records.
3. **State read.** `readSkillsInstallState` and `skillsInstallStateIsUnreadable` read `<target>.json` through the schema check. A missing file means nothing is recorded yet, which is normal. A corrupt file is reported as a problem. Apply, and the doctor and uninstall code the state comments name, rely on this distinction.

---

## Reference (from code graph)

Extracted deterministically by `keryx wiki collect`; regenerated by
`--force`. The prose sections above are the agent/human-owned part.

### Key files

- `src/gdskills/manifest/state.ts` - imported by 6, imports 5
- `src/gdskills/manifest/plan.ts` - imported by 6, imports 4
- `src/gdskills/manifest/apply-doctor-uninstall.test.ts` - imported by 0, imports 8
- `src/gdskills/manifest/manifest.ts` - imported by 6, imports 2
- `src/gdskills/manifest/index.ts` - imported by 1, imports 6
- `src/gdskills/manifest/apply.ts` - imported by 2, imports 4

### Depends on

- `src/lib` - 8 import(s)
- `src/integrations` - 3 import(s)
- `docs/requirements/keryx-agent-platform-expansion/schemas` - 2 import(s)
- `src/contracts` - 2 import(s)

### Depended on by

- `src/commands` - 1 import(s)

### Dependency basis

- Production imports only: 4 import(s) from test file(s) (e.g. `src/gdskills/manifest/apply-doctor-uninstall.test.ts`) excluded from the two sections above in both directions.

### Entry points

- `src/gdskills/manifest/index.ts`

### Graph signals

- Files: 12
- Cross-module imports: 15

## Related Wiki

Graph-derived - regenerated by `keryx wiki collect --force`. Only pages that
exist are linked, other modules are named as code paths; when enriching, add
new links only to pages you have verified.

- [Wiki Index](../index.md)
- [Module src/lib](src-lib.md)
- [Module src/integrations](src-integrations.md)
- [Module src/contracts](src-contracts.md)
- [Module src/commands](src-commands.md)
- `docs/requirements/keryx-agent-platform-expansion/schemas` (no wiki page)

## Changelog

- 1.0.0 — Prose enriched from Key files by the gdwiki skill.
- 0.1.0 - Generated by `keryx wiki collect` at 2026-10-19T10:13:19.815Z. Prose sections are drafts for the gdwiki enrich workflow.
