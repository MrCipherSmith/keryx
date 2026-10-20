---
Title: Module src/lib
Version: 1.0.5
Type: component
Status: accepted
VerifiedAt: 1675e43360b9d786d2916a9518ebe46bb3b7747c
VerifiedScope: sha256:cda63da37f7899f85bae9feaf383be51fc126eec79d05bfb182879a147e15de7
Summary: `src/lib` groups 11 file(s). Depends on `src/testing`. Exposes 7 public symbol(s).
---
# Module src/lib

## Summary

`src/lib` is the shared utilities layer for keryx. It depends only on the `src/testing` module and is the foundation that all other modules (`src/commands`, `src/gdskills`, `src/security`, `src/health`, `src/memory`, `src/mcp`) build on. It provides safe filesystem operations, JSON I/O, CLI argument parsing, terminal output formatting, shell configuration helpers, and large code-generation templates. The majority of files in this module are dependency leaves with no internal cross-dependencies, making this the stable base of the system.

## Overview

The module consists of eleven focused files:

| File | Imports | Exports | Purpose |
|------|---------|---------|---------|
| `fs.ts` | 0 | filesystem utilities | Atomic writes, file locks, path safety |
| `json.ts` | 0 | JSON I/O | Safe reading with fallback defaults |
| `args.ts` | 0 | CLI parsing | Declarative boolean-flag API |
| `config-dir.ts` | 0 | paths | Platform-aware config directory resolution |
| `ui.ts` | 1 | terminal output | ANSI colors, style primitives, helpers |
| `shell-config.ts` | 1 | shell detection | Shell type and config file paths |
| `test-cwd.ts` | 0 | test utilities | Cwd mutex for concurrent tests |
| `templates.ts` | 0 | code generation | Metaproject index and dashboard rendering |
| `git.ts` | — | Git integration | Git repository detection and operations |
| `gitignore.ts` | — | gitignore helpers | Pattern matching for .gitignore files |
| `paths.ts` | — | path utilities | Path manipulation helpers |
| `version.ts` | — | versioning | Version string handling |

## How it works

### Filesystem safety (`fs.ts`)

- **Atomic writes** — `writeFileAtomic` writes to a uniquely-named temp file then renames it to the target, guaranteeing readers never see a partial write.
- **Directory locks** — `withFileLock` uses `mkdir` as an atomic lock acquisition (the OS ensures at most one success), with built-in stale-lock expiry and a polling retry loop.
- **Path predicates** — `isPathInside` uses `path.resolve` and `path.relative` to check containment without string matching, preventing path-traversal bugs.
- **Existence helpers** — `pathExists` and `isNotFound` provide clear boolean checks for file/directory presence.

### JSON I/O (`json.ts`)

- **Typed reading** — `readJsonFile` reads with clear error messages for malformed JSON.
- **Fallback variant** — `readJsonFileOr` returns a default value if the file is missing or malformed, allowing callers to start with safe defaults.

### CLI parsing (`args.ts`)

- Wraps Node's `parseArgs` with a declarative boolean-flag API.
- Automatic short-flag aliases for `--help` and `--yes`.
- Used by `src/commands` (the module's primary consumer) for consistent argument handling.

### Terminal output (`ui.ts`)

- ANSI color support that degrades gracefully when output is piped or redirected.
- Respects `NO_COLOR` and `FORCE_COLOR` environment variables.
- Exports low-level style primitives and high-level helpers: `banner`, `heading`, `statusLine`, `nextSteps`, `helpOptions`.
- All style helpers call `colorEnabled()` on every invocation for correct output mode.

### Shell configuration (`shell-config.ts`)

- Detects the current shell (bash, zsh, fish, etc.) from `SHELL` and `PS1`.
- Resolves shell config file paths (`~/.bashrc`, `~/.zshrc`, etc.) for the detected shell.
- Supports override via `KERYX_SHELL` environment variable.

### Cwd mutex (`test-cwd.ts`)

- Solves a Bun concurrency issue by serializing `chdir` calls behind a promise chain.
- Maintains a module-level promise chain that prevents races between concurrently running test files.

### Template rendering (`templates.ts`)

- `renderIndexMarkdown` — assembles agent-readable index with module rows, skill references, intent router tables, and data references.
- `renderMetaprojectDashboardHtml` — generates the HTML metaproject dashboard, parameterized by module enablement flags.
- Both are used by `keryx index refresh` to regenerate `.metaproject/index.md`.

## Key concepts

- **Dependency leaf** — Most `src/lib` files have zero internal dependencies, meaning they can be imported without pulling in the full module graph.
- **Atomic write** — `writeFileAtomic` creates parent directories, writes to a temp path (including PID, timestamp, UUID), then atomically renames it. If writing fails, the temp file is removed.
- **Directory lock** — `withFileLock` uses `mkdir` for atomic lock acquisition with configurable stale-lock expiry (`DEFAULT_LOCK_STALE_MS`).
- **Path containment** — `isPathInside` uses `path.resolve` and `path.relative` to check containment, not string matching.
- **Color degradation** — `colorEnabled()` checks `NO_COLOR`, then `FORCE_COLOR`, then `stdout.isTTY`. All style helpers call it on every invocation.
- **Cwd serialization** — `test-cwd.ts` maintains a module-level promise chain that serializes `chdir` sections.
- **Shell auto-detection** — `shell-config.ts` infers the shell from environment variables and maps it to the correct config file.

## Main flows

### Safe file write

1. A command calls `writeFileAtomic(path, content)`.
2. `fs.ts` creates the parent directory (`mkdir({ recursive: true })`).
3. A uniquely-named temp file is created (includes PID, timestamp, UUID).
4. Content is written to the temp file.
5. The temp file is atomically renamed to the target path.
6. If writing fails, the temp file is removed.

### JSON config load with fallback

1. A module calls `readJsonFileOr(configPath, defaultValue)`.
2. `json.ts` attempts to read and parse the file.
3. If the file is missing or contains invalid JSON, the provided default is returned.
4. Callers start with safe defaults without needing try/catch blocks.

### Shell config detection

1. `shell-config.ts` checks `KERYX_SHELL` for an override.
2. If not set, it reads `SHELL` environment variable and `PS1` to infer the shell.
3. The appropriate config file path is returned based on the detected shell.

### Metaproject index regeneration

1. `keryx index refresh` calls `renderIndexMarkdown` from `templates.ts`.
2. Enabled module flags and rule sources are passed as parameters.
3. The function assembles module rows, skill references, intent router tables, agent workflow steps, and data references.
4. The resulting Markdown string is written to `.metaproject/index.md` via `writeFileAtomic`.

---

<!-- keryx:reference:begin v=1 hash=904cecfb98ceae75b831351df5a0c65814dedb611bb14c83fdc2f1e57a6e6caa -->
## Reference (from code graph)

Extracted deterministically by `keryx wiki collect`; regenerated by
`--force`. The prose sections above are the agent/human-owned part.

### Public API

- `pathExists`
- `isNotFound`
- `toPosix`
- `isPathInside`
- `writeFileAtomic`
- `DEFAULT_LOCK_STALE_MS`
- `withFileLock`
- `isLockHeld`
- `FileLockRacePoint`
- `processIsAlive`
- `LeaseOwnerBase`
- `LeaseLiveness`
- `LeaseOptions`
- `LeaseHandle`
- `LeaseOwnership`
- `AcquireLeaseResult`
- `LeaseInspection`
- `readLeaseOwnerSync`
- `inspectLeaseSync`
- `acquireLeaseSync`

### Key files

- `src/lib/fs.ts` - imported by 268, imports 0
- `src/lib/config-dir.ts` - imported by 75, imports 0
- `src/lib/args.ts` - imported by 68, imports 0
- `src/lib/contained-write.ts` - imported by 64, imports 1
- `src/lib/shell-config.ts` - imported by 60, imports 1
- `src/lib/json.ts` - imported by 50, imports 0

### Depends on

- `src/harness/tool` - 5 import(s)
- `src/harness/provider` - 4 import(s)
- `src/harness/policy` - 4 import(s)
- `src/rules` - 2 import(s)
- `src/harness/hooks` - 2 import(s)
- `src/gdskills` - 2 import(s)

### Depended on by

- `src/commands` - 259 import(s)
- `src/review` - 67 import(s)
- `src/tui` - 48 import(s)
- `src/gdskills` - 45 import(s)
- `src/integrations` - 25 import(s)
- `src/remote` - 22 import(s)

### Dependency basis

- Production imports only: 269 import(s) from test file(s) (e.g. `src/bundle/external.test.ts`) excluded from the two sections above in both directions.

### Graph signals

- Files: 191
- Cross-module imports: 36
<!-- keryx:reference:end -->

## Related Wiki

Graph-derived - regenerated by `keryx wiki collect --force`. Only pages that
exist are linked; when enriching, add new links only to pages you have verified.

- [Wiki Index](../index.md)
- [Module src/testing](src-testing.md)
- [Module src/commands](src-commands.md)
- [Module src/gdskills](src-gdskills.md)
- [Module src/security](src-security.md)
- [Module src/health](src-health.md)
- [Module src/memory](src-memory.md)
- [Module src/mcp](src-mcp.md)

## Changelog

- 1.0.5 - Reference refreshed from the code graph. Source graph was stale; VerifiedAt was not advanced.
- 1.0.4 - Unwrapped from the markdown code fence an earlier enrich left around the page; no content changed.
- 1.0.3 - Reference refreshed from the code graph (1675e433).
- 1.0.2 - Reference refreshed from the code graph (4e80355f).
- 1.0.1 - Reference refreshed from the code graph (5886c474).
- 0.1.0 - Generated by `keryx wiki collect` at 2026-07-10T08:14:04.890Z. Prose sections are drafts for the gdwiki enrich workflow.
