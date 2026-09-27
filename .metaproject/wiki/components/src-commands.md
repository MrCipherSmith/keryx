---
Title: Module src/commands
Version: 1.1.2
Type: component
Status: accepted
Summary: "Groups 32 command files implementing all top-level CLI entry points for keryx, including workspace initialization, updates, capability management, and the interactive agent loop. Exports 6 public symbols."
---

# Module src/commands

VerifiedAt: 4e80355f1b9fa8576742d151d54397abbd527b38
VerifiedScope: sha256:dd174f2423786bc2661f8fa5e989fcd337dd02c82a6170ad9611ccca59e26bd2

## Summary

The `src/commands` module is the CLI command layer of keryx, providing implementations for every top-level `keryx <subcommand>` entry point. It handles:

- **Workspace lifecycle**: `init.ts` scaffolds new `.metaproject/` directories; `update.ts` refreshes existing workspaces after pulling changes
- **Interactive operations**: `shell.ts` and `agent.ts` drive the agent loop with tool-call validation and risk-separated budgets
- **Capability management**: Thin CLI adapters (`gdgraph.ts`, `ctx.ts`, `skills.ts`, `security.ts`) expose domain services via subcommands
- **User-facing effects**: Writing manifest files, installing git hooks, building dashboards, printing wizards

Depends on `src/lib` (117 imports), `src/gdskills` (17 imports), `src/session` (20 imports), and `src/sac` (18 imports). Exports 6 public symbols consumed by `src` (34 imports) and `src/tui` (25 imports).

## Overview

`src/commands` is the CLI command layer of keryx: it owns the implementations of every top-level `keryx <subcommand>` entry point, the interactive shell/agent driver, and user-facing side effects such as writing `.metaproject/` workspace files, installing git hooks, and printing the setup wizard. The two most connected files — `init.ts` (imported by 9, imports 27) and `update.ts` (imported by 3, imports 21) — together scaffold and refresh the entire metaproject workspace. Capability command files (`gdgraph.ts`, `skills.ts`, `security.ts`, `ctx.ts`) front individual modules, while `shell.ts` and `agent.ts` run the interactive provider and tool-call loop.

## How it works

Each command file exports one or two public functions (e.g. `initCommand`, `updateCommand`, `buildDashboard`) that are called from the top-level CLI entry point in `src/`. Command files share no internal abstractions with each other; they are peer implementations, each responsible for a different CLI surface area.

The two lifecycle commands form the conceptual core. `init.ts` is the workspace constructor: it orchestrates an interactive or `--yes`-driven wizard that collects per-module enable/disable choices, then calls a cascade of `create*Structure`, `install*Hook`, and `writeText*`/`writeJson*` helpers to materialize the entire `.metaproject/` directory tree, write the `metaproject.json` manifest via `buildManifest`, sync agent-entrypoint rule files, register opt-in capabilities, and emit next-step guidance to the user. It distinguishes between "write only if missing" (user-authored files such as `wiki/index.md`) and "write if changed" (managed service files such as `skills/gdgraph/SKILL.md`) to avoid clobbering user edits. `update.ts` is the workspace refresher: it reads the existing manifest via `readManifest` (which can also infer module state from directory presence when the manifest is absent or corrupt), then re-writes all managed service files, re-installs git hooks that the manifest records, backfills modules added after initial setup (e.g. the task manager), reconciles security hook drift between manifest and disk, and regenerates the dashboard HTML via `buildDashboard`. Both commands use the same `installManagedHook` primitive to write or replace keryx-owned sentinel blocks inside `.git/hooks/post-commit` and `.git/hooks/pre-push` without disturbing user content.

The capability-specific command files (`gdgraph.ts`, `ctx.ts`, `skills.ts`, `security.ts`) are thin CLI adapters: they parse subcommands and flags from `args[]`, delegate to domain services in `src/gdgraph`, `src/ctx`, `src/gdskills`, and `src/security`, and format the results for the terminal using helpers from `src/lib/ui`.

`agent.ts` is a separate deterministic interactive driver used by both TUI and readline agent mode. Each user turn may span multiple provider rounds. Tool calls are validated, classified by risk, executed through injected `InteractiveTool` implementations, appended as `role: "tool"` history, and fed back to the provider. Loop safety uses three nested unique-signature pools: `48` total, `40` read, and `8` non-read/unknown-risk. The explicit `maxToolCalls` override remains the total hard ceiling, so the side worker's configured value of `4` still limits read calls as well.

## Key concepts

- **MetaprojectManifest**: the typed representation of `metaproject.json`. `init.ts` builds it via `buildManifest`; `update.ts` reads and reconciles it. The manifest is the single source of truth for which modules are enabled and which git hooks are registered.
- **ModuleConfig**: a discriminated union (`enabled: true | false`) used within the manifest for each module entry. The `enabled: true` branch carries per-module paths, commands, optional hooks, capabilities, and profile fields.
- **Managed hook block**: a named region inside a git hook file delimited by `# keryx:<blockId>:begin` / `# keryx:<blockId>:end` sentinel comments. `installManagedHook` writes or replaces these regions idempotently; `removeManagedHook` strips them without touching other content.
- **InitOptions / UpdateOptions**: per-command option structs parsed directly from `process.argv` slices by `parseInitArgs` / `parseUpdateArgs`, one boolean field per flag. Keeps argument parsing purely functional and testable.
- **writeTextIfChanged / writeTextIfMissing / writeJsonIfChanged**: the three write primitives that enforce the "managed vs. user-owned" contract. Managed service files (skills, manifests, README docs) use `IfChanged`; user-authored scaffolds (wiki index, memory templates) use `IfMissing`.
- **DashboardBuildResult**: the exported type from `update.ts` that wraps the generated dashboard HTML path and the structured data object collected by `collectDashboardData`.
- **GdskillsProfile**: the install profile (minimal, recommended, full, custom) chosen at `init` time and preserved in the manifest; `update.ts` reads it back when reinstalling bundled skills.
- **Agent tool budget**: per-user-turn loop protection keyed by normalized `tool name + input`. Read and non-read signatures consume their risk pool and the total pool. Identical calls may retry three times in one unique slot; unknown risks are conservatively non-read.

## Main flows

**Flow 1 — First-time workspace setup (`keryx init`)**

1. `initCommand` in `init.ts` receives raw CLI args
2. `parseInitArgs` converts args to an `InitOptions` struct
3. If `--yes` is absent, an interactive module selection wizard runs using `confirm` and `choice` from `src/lib/prompt`
4. `createBaseStructure` creates the `.metaproject/` directory tree
5. Per-module `create*Structure` helpers add module subdirectories
6. `syncAgentRules` writes or updates `AGENTS.md`/`CLAUDE.md` imports
7. `installGdskills` unpacks bundled skills
8. Each enabled module's managed service files are written via `writeTextIfChanged` / `writeTextIfMissing`
9. Git hooks that the user opted into are installed with `installManagedHook`
10. `buildManifest` assembles the `MetaprojectManifest` object
11. `writeJsonIfChanged` writes the manifest to `metaproject.json`
12. `nextSteps` prints post-init guidance

**Flow 2 — Workspace refresh after pulling changes (`keryx update`)**

1. `updateCommand` in `update.ts` calls `readManifest`
2. `readManifest` returns either the parsed manifest or one inferred from filesystem presence (recovery path)
3. `refreshServiceFiles` iterates enabled modules, calling `writeTextIfChanged` for all managed files
4. `installManagedHook` re-invokes each hook recorded in the manifest
5. Security hook drift is resolved by comparing manifest entries against on-disk sentinel presence
6. If a hook is no longer in the manifest but still on disk, `removeManagedHook` / `uninstallSecurityAgentHooks` removes it
7. If the task manager module is absent from an older manifest, it is backfilled via `enableTasksInManifest`

**Flow 3 — Dashboard rebuild (`buildDashboard`)**

1. The exported `buildDashboard` function in `update.ts` is called by post-commit hooks and the `keryx update` path
2. It reads the manifest
3. `collectDashboardData` gathers structured data from health JSON artifacts, gdgraph JSONL storage, testing artifacts, and wiki/memory markdown files
4. The combined data object is passed to `renderMetaprojectDashboardHtml` from `src/lib/templates`
5. `writeTextIfChanged` writes the result to `keryx-dashboard.html`

**Flow 4 — Interactive agent tool loop (`runAgentTurn`)**

1. The shell submits a provider request with registered tools
2. Returned tool calls are validated and classified by risk
3. Calls are executed through injected `InteractiveTool` implementations
4. Results are appended as `role: "tool"` history and fed back to the provider
5. The loop repeats with accumulated tool results
6. Reaching a budget exactly does not end the turn: the model receives one normal round to answer from the newest result
7. A tool-free wrap-up is requested only when the model asks for a new signature beyond the total/read/non-read pool, or when a round makes no progress because it only repeats exhausted signatures
8. The wrap-up identifies the exhausted pool

---

<!-- keryx:reference:begin v=1 hash=d27de5eb0b7180e3708c839065ebd2cd394947cb73c3648b9fe649bf854ce533 -->
## Reference (from code graph)

Extracted deterministically by `keryx wiki collect`; regenerated by
`--force`. The prose sections above are the agent/human-owned part.

### Public API

- `readlineAgentHelpText` (function)
- `busLeasesFromClient` (function)
- `bareResumeTarget` (function)
- `LeasedChoiceIO` (interface)
- `resolveLeasedChoice` (function)
- `LeaseChoiceRuntime` (interface)
- `runWithLeaseChoice` (function)
- `runLeasedChatShell` (function)
- `runShell` (function)
- `describeSkippedSession`
- `reviewCommand` (function)

### Key files

- `src/commands/shell.ts` - imported by 18, imports 66
- `src/commands/review.ts` - imported by 27, imports 55
- `src/commands/agent.ts` - imported by 52, imports 27
- `src/commands/init.ts` - imported by 17, imports 38
- `src/commands/providers.ts` - imported by 40, imports 13
- `src/commands/harness.ts` - imported by 8, imports 31

### Depends on

- `src/lib` - 180 import(s)
- `src/review` - 73 import(s)
- `src/trigger` - 26 import(s)
- `src/harness/tool/builtin` - 25 import(s)
- `src/bus` - 24 import(s)
- `src/security` - 23 import(s)

### Depended on by

- `src` - 51 import(s)
- `src/tui` - 33 import(s)
- `src/harness/external` - 7 import(s)
- `src/acp` - 6 import(s)
- `scripts/benchmark` - 5 import(s)
- `src/harness` - 4 import(s)

### Dependency basis

- Production imports only: 463 import(s) from test file(s) (e.g. `src/acp/commands.test.ts`) excluded from the two sections above in both directions.

### Graph signals

- Files: 282
- Cross-module imports: 740
<!-- keryx:reference:end -->

## Related Wiki

Graph-derived - regenerated by `keryx wiki collect --force`. Only pages that exist are linked; when enriching, add new links only to pages you have verified.

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

- 1.1.2 - Reference refreshed from the code graph (4e80355f).
- 1.1.1 - Reference refreshed from the code graph (5886c474).
- 1.1.0 - Documented the interactive agent driver, risk-separated `48/40/8` unique-signature budgets, side-worker total ceiling, and non-premature wrap-up behavior (2026-08-10).
- 1.0.0 - Prose sections enriched by gdwiki enrich workflow.
- 0.1.0 - Generated by `keryx wiki collect` at 2026-07-10T08:14:04.890Z. Prose sections are drafts for the gdwiki enrich workflow.
