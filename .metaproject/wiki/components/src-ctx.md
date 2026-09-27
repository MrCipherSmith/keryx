---
Title: Module src/ctx
Version: 1.1.2
Type: component
Status: accepted
Summary: "The `src/ctx` module provides the gdctx routing guard: a pre-execution hook layer that intercepts shell commands from AI coding harnesses and redirects token-heavy operations through `keryx ctx`. It also generates orientation context for agent awareness."
---

# Module src/ctx

VerifiedAt: 4e80355f1b9fa8576742d151d54397abbd527b38
VerifiedScope: sha256:4be292df5e08e19348539ae83d75894ef69c05fe25dd244586cfb41c3fad8755

## Summary

`src/ctx` groups 11 file(s). Depends on `src/lib`. Exposes 20 public symbol(s).

## Overview

`src/ctx` owns the gdctx routing guard: the pre-execution hook layer that intercepts shell commands issued by AI coding harnesses (Claude Code, Codex, Cursor, Windsurf, Antigravity, OpenCode) and forces token-heavy commands (`rg`, `cat`, `git diff`, etc.) through `keryx ctx` instead of letting them run raw. It also produces orientation context — a bounded project-root Metaproject excerpt followed by a compact code-graph map and wiki index — so an agent sees the mandatory local entrypoint and structured navigation before it starts broad work. The module is the enforcement and awareness layer for the gdctx discipline enforced across the whole workspace.

## How it works

The module is organized into three layers.

### 1. Classifier (bottom layer)

The harness-agnostic **classifier** (`hook-classify.ts`) is a pure function that:

- Receives a raw shell command string
- Splits it into pipeline segments
- Skips over environment assignments and benign wrappers (`sudo`, `env`, etc.)
- Returns a `HookClassification` containing:
  - Whether to block
  - Which command family matched
  - The suggested `keryx ctx` replacement
  - Whether an explicit escape marker (`# keryx:raw <reason>`) was present

The classifier has no knowledge of any specific harness.

### 2. Runtime registry (middle layer)

Each `CtxRuntime` implementation in `runtimes.ts` encapsulates four harness-specific concerns:

| Concern | Description |
|---------|-------------|
| Payload parsing | How to parse the payload from stdin |
| Signaling | How to signal BLOCK vs ALLOW (exit-code-based for Claude/Codex/Windsurf; stdout JSON for Cursor/Antigravity) |
| Install artifact | Where the install artifact lives |
| Merge/strip | How to merge/strip the managed hook entry in that artifact |

- **JSON-config runtimes** share generic sentinel helpers (`_keryxManaged: "ctx-agent-hooks"`) for idempotent install and surgical uninstall.
- **OpenCode** (no JSON hook config) instead gets a generated JS bridge plugin at `.opencode/plugin/keryx-ctx-guard.js`.

### 3. Adapters (top layer)

Two thin adapters provide the CLI surface:

- **`hook.ts`** — CLI entry point for `keryx ctx hook <runtime>`:
  1. Reads the harness payload from stdin
  2. Resolves the runtime
  3. Calls the classifier
  4. Writes the block/allow signal to stdout/stderr/exitCode

- **`hook-install.ts`** — Generic read/write loop for JSON-config runtimes:
  1. Reads the existing settings file (if any)
  2. Delegates to the runtime's `merge` function
  3. Writes the result back
  4. Re-reads and runs the runtime's `validate` function

### Orientation module (`orient.ts`)

Stands apart from the hook pipeline. Generates a bounded, freshness-aware Markdown block combining:

1. A project-root `.metaproject/index.md` excerpt (max 60 useful lines)
2. A trimmed code-graph summary
3. The wiki page index

Notes:
- Index lookup deliberately does not walk ancestors — the harness launch cwd is treated as the project boundary.
- The excerpt skips low-value `Data` and `Refresh` sections.
- It ends with a marker directing the model to read the full file whenever truncation occurred.

## Key concepts

### CtxRuntime

The central interface every harness adapter implements. It bundles:

- Payload parser
- Block/allow signalers
- Install locator
- Optional merge/strip/validate methods (or `customInstall`/`customUninstall` for non-JSON harnesses)

### HookClassification

Result of the classifier:

| Field | Type | Description |
|-------|------|-------------|
| `block` | `boolean` | Whether to block the command |
| `matched` | `string` | The command family matched |
| `suggestion` | `string` | The `keryx ctx` replacement form |
| `escapeReason` | `string \| undefined` | Present when an escape marker opted the command out |

### HookAction

What the hook process should emit:

| Field | Type | Description |
|-------|------|-------------|
| `exitCode` | `number` | Process exit code |
| `stdout` | `string \| undefined` | Optional stdout content |
| `stderr` | `string \| undefined` | Optional stderr content |

### Constants

| Constant | Purpose |
|----------|---------|
| `CTX_HOOK_SENTINEL` / `MANAGED_KEY` | Sentinel values written into managed JSON groups for idempotent install and surgical uninstall |
| `Confidence` | `"verified"` (first-party docs) or `"experimental"` (community docs, with warning) |

### Escape marker

`# keryx:raw <reason>` appended to a command opts it out of the guard and self-documents why raw output was genuinely needed.

### Orientation block

A Markdown snapshot from `orient.ts` combining:

- A bounded project-root Metaproject entrypoint excerpt
- Code-graph stats
- The wiki index

The excerpt is precedence guidance, not an enforced runtime gate. The full `.metaproject/index.md` remains the authoritative routing source.

## Main flows

### Hook intercept flow

When an agent runs `rg pattern src/`:

1. The harness fires `keryx ctx hook claude` before the Bash tool executes.
2. `hook.ts` reads the JSON payload from stdin.
3. It calls `CLAUDE_RUNTIME.parseCommand()` to extract the shell command string.
4. The command is passed to `classifyCommand()`, which splits it into segments and matches `rg` against the `ROUTES` table.
5. The classifier returns:
   ```typescript
   {
     block: true,
     matched: "rg",
     suggestion: 'keryx ctx rg "pattern" [path]'
   }
   ```
6. `hook.ts` calls `CLAUDE_RUNTIME.block(command, classification)`, which returns `{ exitCode: 2, stderr: "..." }` built by `buildBlockMessage`.
7. The process writes to stderr and exits with code 2.
8. Claude Code aborts the tool call and surfaces the routing message to the agent.

### Hook install flow

When running `keryx ctx install-hook --runtime claude`:

1. `installRuntimeHook()` in `hook-install.ts` reads the current `.claude/settings.json` (or starts from `{}`).
2. It calls `CLAUDE_RUNTIME.merge(settings)`, which merges a `PreToolUse/Bash` group carrying the `_keryxManaged` sentinel into the hooks array.
3. It writes the updated JSON back.
4. It re-reads the file and calls `CLAUDE_RUNTIME.validate()` to confirm the guard is present.

Result: a single atomic read-merge-write-verify cycle that is safe to run repeatedly.

### Orientation injection flow

When a harness session-start event triggers orientation:

1. `buildOrientation(cwd)` is called from `orient.ts`.
2. It concurrently checks:
   - `<cwd>/.metaproject/index.md`
   - The gdgraph summary (`data/gdgraph/artifacts/summary.md`)
   - The wiki index (`wiki/index.md`)
3. All three portions are bounded in size.
4. A freshness note derived from `git diff --name-only HEAD` is appended.
5. A single Markdown block is returned.

Behavior:
- If the project-root index exists, the first portion directs the model to read it in full before other project work.
- If it is absent, the previous graph/wiki-only format is preserved.

---

<!-- keryx:reference:begin v=1 hash=7d6153a287c94f35975a9edc0c1d0878fc144b0c63d5fb900221684b6a1cc1ab -->
## Reference (from code graph)

Extracted deterministically by `keryx wiki collect`; regenerated by
`--force`. The prose sections above are the agent/human-owned part.

### Public API

- `Settings`
- `Confidence`
- `GroupShape`
- `CtxRuntime` (interface)
- `preToolUseMatcher` (function)
- `describeExistingGuard` (function)
- `nativeSearchMessage` (function)
- `CTX_RUNTIMES`
- `CLAUDE_RUNTIME`
- `CODEX_RUNTIME`
- `CURSOR_RUNTIME`
- `WINDSURF_RUNTIME`
- `ANTIGRAVITY_RUNTIME`
- `OPENCODE_RUNTIME`
- `UNSUPPORTED_RUNTIMES`
- `runtimeIds` (function)
- `getRuntime` (function)
- `resolveRuntimes` (function)
- `CTX_HOOK_SENTINEL`
- `MANAGED_KEY`

### Key files

- `src/ctx/runtimes.ts` - imported by 14, imports 2
- `src/ctx/orient.ts` - imported by 6, imports 4
- `src/ctx/hook-install.ts` - imported by 5, imports 3
- `src/ctx/hook-classify.ts` - imported by 6, imports 0
- `src/ctx/orient-runtimes.ts` - imported by 5, imports 1
- `src/ctx/assembly.ts` - imported by 5, imports 0

### Depends on

- `src/integrations` - 4 import(s)
- `src/lib` - 3 import(s)
- `src/gdgraph` - 1 import(s)

### Depended on by

- `src/commands` - 14 import(s)
- `src/sac` - 2 import(s)
- `src/gdgraph` - 1 import(s)
- `src/session` - 1 import(s)
- `src/wiki` - 1 import(s)

### Dependency basis

- Production imports only: 13 import(s) from test file(s) (e.g. `src/commands/routing-entrypoint-lifecycle.test.ts`) excluded from the two sections above in both directions.

### Graph signals

- Files: 27
- Cross-module imports: 8
<!-- keryx:reference:end -->

## Related Wiki

Graph-derived - regenerated by `keryx wiki collect --force`. Only pages that exist are linked; when enriching, add new links only to pages you have verified.

- [Wiki Index](../index.md)
- [Module src/lib](src-lib.md)
- [Module src/commands](src-commands.md)

## Changelog

- 1.1.2 - Reference refreshed from the code graph (4e80355f).
- **1.1.1** - Reference refreshed from the code graph (5886c474).
- **1.1.0** - Documented bounded project-root Metaproject bootstrap orientation, root-only discovery, truncation, and the no-index compatibility path.
- **1.0.0** - Prose sections enriched by gdwiki agent: Overview, How it works, Key concepts, Main flows written from key-file reads.
- **0.1.0** - Generated by `keryx wiki collect`. Prose sections are drafts for the gdwiki enrich workflow.
