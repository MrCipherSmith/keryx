# Module src/ctx

Version: 1.0.0
Type: component
Status: accepted

## Summary

`src/ctx` groups 11 file(s). Depends on `src/lib`. Exposes 20 public symbol(s).

## Overview

`src/ctx` owns the gdctx routing guard: the pre-execution hook layer that intercepts shell commands issued by AI coding harnesses (Claude Code, Codex, Cursor, Windsurf, Antigravity, OpenCode) and forces token-heavy commands (`rg`, `cat`, `git diff`, etc.) through `keryx ctx` instead of running raw. It also provides orientation context — a compact code-graph + wiki index block injected at the start of agent turns so the agent always knows that structured navigation is available. The module is the enforcement and awareness layer for the gdctx discipline enforced across the whole workspace.

## How it works

The module is organized in three layers. The bottom layer is the harness-agnostic **classifier** (`hook-classify.ts`), a pure function that receives a raw shell command string, splits it into pipeline segments, skips over environment assignments and benign wrappers (`sudo`, `env`, etc.), and returns a `HookClassification` — whether to block, which command family matched, what the suggested `keryx ctx` replacement is, and whether an explicit escape marker (`# keryx:raw <reason>`) was present. The classifier knows nothing about any specific harness.

The middle layer is the **runtime registry** (`runtimes.ts`). Each `CtxRuntime` implementation encapsulates the four harness-specific concerns: how to parse the payload from stdin, how to signal BLOCK vs ALLOW back to the harness (exit-code-based for Claude/Codex/Windsurf; stdout JSON for Cursor and Antigravity), where the install artifact lives, and how to merge/strip the managed hook entry in that artifact. JSON-config runtimes share generic sentinel helpers (`_keryxManaged: "ctx-agent-hooks"`) that make install idempotent and uninstall surgical. OpenCode, which has no JSON hook config, instead gets a generated JS bridge plugin written to `.opencode/plugin/keryx-ctx-guard.js`.

The top layer has two thin adapters. `hook.ts` is the CLI entry point for `keryx ctx hook <runtime>`: it reads the harness payload from stdin, resolves the runtime, calls the classifier, and writes the runtime's block or allow signal to stdout/stderr/exitCode. `hook-install.ts` owns the generic read/write loop for JSON-config runtimes: it reads the existing settings file (if any), delegates to the runtime's `merge` function, writes the result back, and immediately re-reads to run the runtime's `validate` function.

`orient.ts` stands apart: it does not participate in the hook pipeline at all. It generates a bounded, freshness-aware Markdown block combining a trimmed code-graph summary and the wiki page index, intended for injection at the start of every agent turn so the agent always knows graph and wiki navigation are available before resorting to broad search.

## Key concepts

- **`CtxRuntime`** — the central interface every harness adapter implements. It bundles a payload parser, block/allow signalers, an install locator, and optional merge/strip/validate methods (or `customInstall`/`customUninstall` for non-JSON harnesses).
- **`HookClassification`** — the result of the classifier: `block: boolean`, plus `matched` (the command family), `suggestion` (the `keryx ctx` form), and `escapeReason` (present when the escape marker opted the command out).
- **`HookAction`** — what the hook process should emit: `exitCode`, optional `stdout`, optional `stderr`. The exact combination varies by harness protocol (exit-2 + stderr vs. stdout JSON decision).
- **`CTX_HOOK_SENTINEL` / `MANAGED_KEY`** — the sentinel values written into every managed JSON group so install is idempotent and uninstall removes only the keryx entry.
- **`Confidence`** — `"verified"` for runtimes confirmed against first-party docs; `"experimental"` for community-doc-based runtimes that print a warning at install time.
- **Escape marker** — `# keryx:raw <reason>` appended to a command opts it out of the guard and self-documents why raw output was genuinely needed.
- **Orientation block** — the Markdown snapshot from `orient.ts` combining code-graph stats and the wiki index, bounded to stay token-cheap on every injection.

## Main flows

**Hook intercept flow (e.g. agent runs `rg pattern src/`):** The harness fires `keryx ctx hook claude` before the Bash tool executes. `hook.ts` reads the JSON payload from stdin, calls `CLAUDE_RUNTIME.parseCommand()` to extract the shell command string, passes it to `classifyCommand()`, which splits the command into segments and matches `rg` against the `ROUTES` table. The classifier returns `{ block: true, matched: "rg", suggestion: 'keryx ctx rg "pattern" [path]' }`. `hook.ts` calls `CLAUDE_RUNTIME.block(command, classification)`, which returns `{ exitCode: 2, stderr: "..." }` built by `buildBlockMessage`. The process writes to stderr and exits with code 2, causing Claude Code to abort the tool call and surface the routing message to the agent.

**Hook install flow (e.g. `keryx ctx install-hook --runtime claude`):** `installRuntimeHook()` in `hook-install.ts` reads the current `.claude/settings.json` (or starts from `{}`), calls `CLAUDE_RUNTIME.merge(settings)` which merges a `PreToolUse/Bash` group carrying the `_keryxManaged` sentinel into the hooks array, writes the updated JSON back, then re-reads and calls `CLAUDE_RUNTIME.validate()` to confirm the guard is present. The result is a single atomic read-merge-write-verify cycle that is safe to run repeatedly.

**Orientation injection flow (e.g. session-start hook):** A harness session-start event calls `buildOrientation(cwd)` from `orient.ts`, which concurrently fetches the gdgraph summary (`data/gdgraph/artifacts/summary.md`) and the wiki index (`wiki/index.md`). It trims each to a bounded number of lines, appends a freshness note derived from `git diff --name-only HEAD`, and returns a single Markdown block. The harness injects this block as a system message so the agent sees the graph/wiki map before it can attempt broad search.

---

## Reference (from code graph)

Extracted deterministically by `keryx wiki collect`; regenerated by
`--force`. The prose sections above are the agent/human-owned part.

### Public API

- `CTX_HOOK_SENTINEL`
- `MANAGED_KEY`
- `Settings`
- `HookAction` (interface)
- `Confidence`
- `CtxRuntime` (interface)
- `CLAUDE_RUNTIME`
- `CODEX_RUNTIME`
- `CURSOR_RUNTIME`
- `WINDSURF_RUNTIME`
- `ANTIGRAVITY_RUNTIME`
- `KeryxCtxGuard`
- `OPENCODE_RUNTIME`
- `UNSUPPORTED_RUNTIMES`
- `CTX_RUNTIMES`
- `runtimeIds` (function)
- `getRuntime` (function)
- `resolveRuntimes` (function)
- `classifyCommand`
- `buildBlockMessage`

### Key files

- `src/ctx/runtimes.ts` - imported by 5, imports 2
- `src/ctx/orient.ts` - imported by 4, imports 1
- `src/ctx/hook-install.ts` - imported by 3, imports 1
- `src/ctx/hook-classify.ts` - imported by 3, imports 0
- `src/ctx/hook.ts` - imported by 1, imports 2
- `src/ctx/hook-install.test.ts` - imported by 0, imports 2

### Depends on

- `src/lib` - 3 import(s)

### Depended on by

- `src/commands` - 7 import(s)

### Graph signals

- Files: 11
- Cross-module imports: 3

## Related Wiki

Graph-derived - regenerated by `keryx wiki collect --force`. Only pages that
exist are linked; when enriching, add new links only to pages you have verified.

- [Wiki Index](../index.md)
- [Module src/lib](src-lib.md)
- [Module src/commands](src-commands.md)

## Changelog

- 1.0.0 - Prose sections enriched by gdwiki agent (2026-07-10): Overview, How it works, Key concepts, Main flows written from key-file reads.
- 0.1.0 - Generated by `keryx wiki collect` at 2026-07-10T08:14:04.890Z. Prose sections are drafts for the gdwiki enrich workflow.
