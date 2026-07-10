# Module src/commands

Version: 1.0.0
Type: component
Status: accepted

## Summary

`src/commands` groups 32 file(s). Depends on `src/lib`, `src/gdskills`, `src/security`. Exposes 4 public symbol(s).

## Overview

`src/commands` is the CLI command layer of keryx: it owns the implementations of every top-level `keryx <subcommand>` entry point and is the only module that performs user-facing side effects such as writing `.metaproject/` workspace files, installing git hooks, and printing the interactive setup wizard. The two most connected files — `init.ts` (imported by 9, imports 27) and `update.ts` (imported by 3, imports 21) — together scaffold and refresh the entire metaproject workspace. The remaining command files (`gdgraph.ts`, `skills.ts`, `security.ts`, `ctx.ts`) each front a specific keryx capability module, delegating to the domain layer while handling CLI argument parsing and user-facing output themselves.

## How it works

Each command file exports one or two public functions (e.g. `initCommand`, `updateCommand`, `buildDashboard`) that are called from the top-level CLI entry point in `src/`. Command files share no internal abstractions with each other; they are peer implementations, each responsible for a different CLI surface area.

The two lifecycle commands form the conceptual core. `init.ts` is the workspace constructor: it orchestrates an interactive or `--yes`-driven wizard that collects per-module enable/disable choices, then calls a cascade of `create*Structure`, `install*Hook`, and `writeText*`/`writeJson*` helpers to materialize the entire `.metaproject/` directory tree, write the `metaproject.json` manifest via `buildManifest`, sync agent-entrypoint rule files, register opt-in capabilities, and emit next-step guidance to the user. It distinguishes between "write only if missing" (user-authored files such as `wiki/index.md`) and "write if changed" (managed service files such as `skills/gdgraph/SKILL.md`) to avoid clobbering user edits. `update.ts` is the workspace refresher: it reads the existing manifest via `readManifest` (which can also infer module state from directory presence when the manifest is absent or corrupt), then re-writes all managed service files, re-installs git hooks that the manifest records, backfills modules added after initial setup (e.g. the task manager), reconciles security hook drift between manifest and disk, and regenerates the dashboard HTML via `buildDashboard`. Both commands use the same `installManagedHook` primitive to write or replace keryx-owned sentinel blocks inside `.git/hooks/post-commit` and `.git/hooks/pre-push` without disturbing user content.

The capability-specific command files (`gdgraph.ts`, `ctx.ts`, `skills.ts`, `security.ts`) are thin CLI adapters: they parse subcommands and flags from `args[]`, delegate to domain services in `src/gdgraph`, `src/ctx`, `src/gdskills`, and `src/security`, and format the results for the terminal using helpers from `src/lib/ui`.

## Key concepts

- **MetaprojectManifest**: the typed representation of `metaproject.json`. `init.ts` builds it via `buildManifest`; `update.ts` reads and reconciles it. The manifest is the single source of truth for which modules are enabled and which git hooks are registered.
- **ModuleConfig**: a discriminated union (`enabled: true | false`) used within the manifest for each module entry. The `enabled: true` branch carries per-module paths, commands, optional hooks, capabilities, and profile fields.
- **Managed hook block**: a named region inside a git hook file delimited by `# keryx:<blockId>:begin` / `# keryx:<blockId>:end` sentinel comments. `installManagedHook` writes or replaces these regions idempotently; `removeManagedHook` strips them without touching other content.
- **InitOptions / UpdateOptions**: per-command option structs parsed directly from `process.argv` slices by `parseInitArgs` / `parseUpdateArgs`, one boolean field per flag. Keeps argument parsing purely functional and testable.
- **writeTextIfChanged / writeTextIfMissing / writeJsonIfChanged**: the three write primitives that enforce the "managed vs. user-owned" contract. Managed service files (skills, manifests, README docs) use `IfChanged`; user-authored scaffolds (wiki index, memory templates) use `IfMissing`.
- **DashboardBuildResult**: the exported type from `update.ts` that wraps the generated dashboard HTML path and the structured data object collected by `collectDashboardData`.
- **GdskillsProfile**: the install profile (minimal, recommended, full, custom) chosen at `init` time and preserved in the manifest; `update.ts` reads it back when reinstalling bundled skills.

## Main flows

**Flow 1 — First-time workspace setup (`keryx init`)**
`initCommand` in `init.ts` is called with raw CLI args. `parseInitArgs` converts them to an `InitOptions` struct. If `--yes` is absent, the function runs an interactive module selection wizard using `confirm` and `choice` from `src/lib/prompt`. After selections are recorded, `createBaseStructure` creates the `.metaproject/` directory tree, then per-module `create*Structure` helpers add module subdirectories. `syncAgentRules` writes or updates `AGENTS.md`/`CLAUDE.md` imports. `installGdskills` unpacks bundled skills. Each enabled module's managed service files are written via `writeTextIfChanged` / `writeTextIfMissing`. Git hooks that the user opted into are installed with `installManagedHook`. `buildManifest` assembles the `MetaprojectManifest` object, which `writeJsonIfChanged` writes to `metaproject.json`. Finally, `nextSteps` prints the post-init guidance.

**Flow 2 — Workspace refresh after pulling changes (`keryx update`)**
`updateCommand` in `update.ts` calls `readManifest`, which returns a `ManifestReadResult` carrying either the parsed manifest or one inferred from filesystem presence (recovery path). `refreshServiceFiles` then iterates the enabled module set, calling `writeTextIfChanged` for all managed files (skill READMEs, module manifests, dashboard HTML) and re-invoking `installManagedHook` for each hook that the manifest records. Security hook drift is resolved by comparing manifest entries against on-disk sentinel presence: if a hook is no longer in the manifest but still on disk, `removeManagedHook` / `uninstallSecurityAgentHooks` removes it. If the task manager module is absent from an older manifest, it is backfilled via `enableTasksInManifest`.

**Flow 3 — Dashboard rebuild (`buildDashboard`)**
The exported `buildDashboard` function in `update.ts` is called by post-commit hooks and the `keryx update` path. It reads the manifest, invokes `collectDashboardData` to gather structured data from health JSON artifacts, gdgraph JSONL storage, testing artifacts, and wiki/memory markdown files, then passes the combined data object to `renderMetaprojectDashboardHtml` from `src/lib/templates` and writes the result to `keryx-dashboard.html` via `writeTextIfChanged`.

---

## Reference (from code graph)

Extracted deterministically by `keryx wiki collect`; regenerated by
`--force`. The prose sections above are the agent/human-owned part.

### Public API

- `initCommand` (function)
- `DashboardBuildResult`
- `updateCommand` (function)
- `buildDashboard` (function)

### Key files

- `src/commands/init.ts` - imported by 9, imports 27
- `src/commands/update.ts` - imported by 3, imports 21
- `src/commands/gdgraph.ts` - imported by 2, imports 16
- `src/commands/skills.ts` - imported by 2, imports 12
- `src/commands/security.ts` - imported by 1, imports 11
- `src/commands/ctx.ts` - imported by 2, imports 7

### Depends on

- `src/lib` - 50 import(s)
- `src/gdskills` - 13 import(s)
- `src/security` - 12 import(s)
- `src/gdgraph` - 11 import(s)
- `src/memory` - 9 import(s)
- `src/ctx` - 7 import(s)

### Depended on by

- `src` - 21 import(s)
- `src/capability` - 4 import(s)
- `src/review` - 1 import(s)
- `src/standard` - 1 import(s)

### Graph signals

- Files: 32
- Cross-module imports: 159

## Related Wiki

Graph-derived - regenerated by `keryx wiki collect --force`. Only pages that
exist are linked; when enriching, add new links only to pages you have verified.

- [Wiki Index](../index.md)
- [Module src/lib](src-lib.md)
- [Module src/gdskills](src-gdskills.md)
- [Module src/security](src-security.md)
- [Module src/gdgraph](src-gdgraph.md)
- [Module src/memory](src-memory.md)
- [Module src/ctx](src-ctx.md)
- [Module src](src.md)
- [Module src/capability](src-capability.md)

## Changelog

- 1.0.0 - Prose sections enriched by gdwiki enrich workflow.
- 0.1.0 - Generated by `keryx wiki collect` at 2026-07-10T08:14:04.890Z. Prose sections are drafts for the gdwiki enrich workflow.
