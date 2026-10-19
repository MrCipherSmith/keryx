# Module src/integrations

Version: 1.0.0
Type: component
Status: accepted

## Summary

`src/integrations` is the host-harness registry: it declares which keryx hook surfaces each coding agent or IDE supports, and installs, removes and health-checks them inside that harness's own config. It groups 35 file(s) and depends on `src/lib`, `src/rules` and `src/agents`.

## Overview

`src/integrations` owns how keryx wires itself into the coding agents and IDEs it runs alongside. It holds one registry of harness adapters, each listing the surfaces (command gates, context injectors, security checks, instruction blocks, exported agent and rule files) that harness supports, and the installer that writes, removes and checks those surfaces. The public door is `src/integrations/service.ts`; code outside the directory imports from it rather than from the internals.

## How it works

`types.ts` is pure vocabulary with no I/O. A `SurfaceAdapter` is one installable capability, identified by a `SurfaceFlag`, a `subsystem` and a `sentinel`. Three install shapes exist. JSON surfaces implement `merge`, `strip` and `validate` against a settings file. Non-JSON surfaces implement `customInstall` and `customUninstall`, as the markdown-block instruction surfaces and the agent export surfaces do. A third shape, `policy-travels-with-agent` (used by the `zed` and `keryx-shell` adapters), has nothing to write and at most a `probe`.

`registry.ts` is the single list. `HARNESS_ADAPTERS` gives each harness its surfaces, its `unsupported` flags with reasons, and its `decisionCodec`, which is the only place that says how a runtime signals refuse or allow. Everything else is derived from that list: `SETTINGS_FILE_OWNERS` groups the JSON surfaces by target path, and `surfacesOf` and `getHarnessAdapter` read the same array. `assertRegistryCoherent()` runs at module load. It throws when two surfaces on one file declare the same top-level key with different JSON types, which is the `hooks` object-versus-array collision, or when a surface id repeats across adapters that share a file.

Each settings file has one writer. `createSettingsFileOwner` in `settings-file.ts` applies the requested surfaces' `merge` or `strip` on a clone, in the owner's canonical order. It validates before and after a JSON round-trip, and it returns errors without writing when any surface would break. `settings-json.ts` holds the shared walkers that every surface is built from: the `_keryxManaged` sentinel, the `hooks` object helpers, and `mergeIntoHookArray`, which moves a legacy `hooks` array into `unmigratedHooks` instead of discarding it.

`installer.ts` orchestrates one runtime at a time. It resolves `--surface` selectors, partitions the surfaces by the file each one targets, and runs a preflight that writes nothing. Only when every selected target passes does it perform the real writes, then `recordSurfaceInstalled` (`install-state.ts`) for each surface that wrote a file. Claude's settings path is decided per project. `claude-settings.ts` resolves the local or shared file, and `claude-settings-migration.ts` moves managed hook groups between them during `keryx init` and `keryx update`, writing the destination first.

## Key concepts

- **Harness adapter** (`HarnessAdapter`): one coding agent or IDE, with an `id`, a `confidence` of `verified` or `experimental`, an `adapterKind`, its surfaces, its unsupported flags and its `decisionCodec`.
- **Surface** (`SurfaceAdapter`) and **surface flag** (`SurfaceFlag`): one capability a harness can have. The flag is the name a user selects with, such as `block`, `inject-context` or `skills`. The `subsystem` groups surfaces by their owner, such as `ctx-guard`, `orient`, `security`, `instructions`, `acp-permission`, `agents`, `shell-hooks`, `rules-export` or `learning`.
- **Sentinel and `_keryxManaged`**: every keryx-written group carries its surface's sentinel. Install is idempotent, and uninstall removes only keryx's own entries and leaves the user's.
- **Settings-file owner** (`SettingsFileOwner`): the single writer for one settings path, so two surfaces never clobber each other's JSON.
- **Surface slot** (`SurfaceSlot`): declares a top-level key a surface touches and its JSON type. `owns` may create the key. `migrates-legacy` only touches a key that is already present, so it can never introduce a conflicting type.
- **Decision codec** (`DecisionCodec`): how a runtime signals refuse or allow. The exit-code form is the default. The stdout-JSON forms are used by cursor, antigravity and copilot.
- **Install state**: a per-runtime record of each surface that wrote a file, with a sha256 for that file. `doctor` compares it with the live file to report drift.
- **Opt-in surface**: a surface, such as `agents`, that an empty `--surface` selector never installs and that only runs when named.

## Main flows

1. **Install.** `installIntegration` in `installer.ts` calls `resolveSurfaceSelection` to choose the surfaces, then `partitionSurfaces` to group them by target file. The preflight runs `owner.apply` (from `settings-file.ts`) and `customInstallDryRun` on every target. If anything fails, every selected surface comes back `failed` and nothing is written. Otherwise `installSurfaces` writes each JSON file, each custom surface's `customInstall` runs, and `recordSurfaceInstalled` is called for every surface that wrote a file. A surface with no merge, strip or custom install is only probed and never recorded.
2. **Uninstall.** `uninstallIntegration` decides whether each surface is present with `wasSurfaceInstalled`. It checks `validate` first, then falls back to the sentinel on `groupKey`. A surface that was never installed is reported `nothing-to-remove` rather than `removed`. The JSON groups are stripped through `uninstallSurfaces`, and `recordSurfaceUninstalled` runs only for surfaces that were actually removed.
3. **Doctor.** `doctorIntegration` runs `liveStatusOf` for each surface. That means `validate` against the settings file, or `probe` for non-JSON surfaces. It then compares the result with the install-state record. A recorded surface that is not `valid` is reported as drift, and so is a recorded file whose sha256 has changed. A single explicit runtime throws on an unknown `--surface` selector, while a multi-runtime run ignores it. Opt-in surfaces are skipped unless they are recorded or named.
4. **Claude settings move.** During `keryx init` and `keryx update`, `decideClaudeSettingsTarget` reads the manifest and the git HEAD copy of `.claude/settings.json` to settle the scope. `moveClaudeSettingsHooks` then writes every managed group into the chosen file before removing it from the other. That ordering means a failure midway leaves the hooks duplicated for one run, never missing.

---

<!-- keryx:reference:begin v=1 hash=cdb30a56cbefb485bb18ba5026117082decbe4b1fb9108a8243446ddabea3467 -->
## Reference (from code graph)

Extracted deterministically by `keryx wiki collect`; regenerated by
`--force`. The prose sections above are the agent/human-owned part.

### Key files

- `src/integrations/service.ts` - imported by 15, imports 16
- `src/integrations/types.ts` - imported by 24, imports 0
- `src/integrations/registry.ts` - imported by 15, imports 8
- `src/integrations/settings-json.ts` - imported by 13, imports 3
- `src/integrations/claude-settings-migration.ts` - imported by 3, imports 12
- `src/integrations/installer.ts` - imported by 9, imports 6

### Depends on

- `src/lib` - 25 import(s)
- `src/rules` - 12 import(s)
- `src/agents` - 3 import(s)
- `docs/requirements/keryx-agent-platform-expansion/schemas` - 1 import(s)
- `src/contracts` - 1 import(s)

### Depended on by

- `src/commands` - 6 import(s)
- `src/ctx` - 4 import(s)
- `src/rules` - 4 import(s)
- `src/gdskills/manifest` - 3 import(s)
- `src/agents` - 2 import(s)
- `src/bundle` - 1 import(s)

### Dependency basis

- Production imports only: 30 import(s) from test file(s) (e.g. `src/agents/export.test.ts`) excluded from the two sections above in both directions.

### Entry points

- `src/integrations/index.ts`

### Graph signals

- Files: 35
- Cross-module imports: 42
<!-- keryx:reference:end -->

## Related Wiki

Graph-derived - regenerated by `keryx wiki collect --force`. Only pages that
exist are linked, other modules are named as code paths; when enriching, add
new links only to pages you have verified.

- [Wiki Index](../index.md)
- [Module src/lib](src-lib.md)
- [Module src/rules](src-rules.md)
- [Module src/agents](src-agents.md)
- [Module src/contracts](src-contracts.md)
- [Module src/commands](src-commands.md)
- [Module src/ctx](src-ctx.md)
- [Module src/gdskills/manifest](src-gdskills-manifest.md)
- [Module src/bundle](src-bundle.md)
- `docs/requirements/keryx-agent-platform-expansion/schemas` (no wiki page)

## Changelog

- 1.0.0 — Prose enriched from Key files by the gdwiki skill.
- 0.1.0 - Generated by `keryx wiki collect` at 2026-10-19T10:13:19.815Z. Prose sections are drafts for the gdwiki enrich workflow.
