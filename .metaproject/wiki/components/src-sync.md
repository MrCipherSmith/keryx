# Module src/sync

Version: 1.0.0
Type: component
Status: accepted

## Summary

`src/sync` groups 5 file(s). Depends on `src/lib`. Exposes 15 public symbol(s).

## Overview

`src/sync` owns the incremental-rebuild layer that tracks whether keryx's derived artifacts (code graph, wiki, memory) are up-to-date with the repository's current git state. It records a build provenance stamp (commit + branch + timestamp) inside each module's data directory whenever a module is regenerated, and later computes an exact file-level diff between that stamp and the current HEAD so only the changed paths need to be processed. Git hooks for `post-merge` and `post-checkout` are also managed here so that a `git pull` or branch switch automatically surfaces an advisory sync report without blocking the developer.

## How it works

The module is split into three thin layers. `provenance.ts` forms the lowest layer: it wraps raw `git` process calls (`gitCmd`, `gitHead`) and provides `recordProvenance` / `readProvenance` to write and read a `.provenance.json` file under `.metaproject/data/<module>/`. The JSON encodes the commit SHA, branch name, and ISO build timestamp. For non-git projects every provenance call silently returns `null`, signalling the caller to perform a full rebuild instead.

`diff.ts` sits above provenance: given the commit SHA stored in a provenance file, it calls `git diff --name-status <base>` (via the shared `gitCmd`) and parses the tabular output into a `SyncDiff` value — three plain string arrays (`added`, `modified`, `deleted`). Renames are split into a synthetic delete of the old path and an add of the new path. A `codeOnly` filter restricts any `SyncDiff` to source-code extensions so that documentation-only changes do not trigger graph/wiki rebuilds.

`hooks.ts` is the installation layer: it writes or removes a managed shell block (delimited by `# keryx:keryx-sync:begin` / `# keryx:keryx-sync:end` markers) inside `.git/hooks/post-merge` and `.git/hooks/post-checkout`. The block runs `keryx sync` in advisory, non-blocking mode — a hook failure is swallowed so it never interrupts a git operation. The installer preserves any pre-existing hook content outside its managed block.

## Key concepts

**Provenance** — the `Provenance` interface (`{ commit, branch, builtAt }`) records the exact git state at which a derived artifact was last generated. It is the anchor point for all incremental sync decisions.

**SyncedModule** — a string union (`"gdgraph" | "gdwiki" | "memory"`) that enumerates which keryx modules carry their own provenance stamps. The constant `SYNCED_MODULES` drives iteration over all three.

**SyncDiff** — the core delta type (`{ added: string[], modified: string[], deleted: string[] }`) representing file-level changes between a provenance commit and the current working tree. Renames appear as a delete + add pair; copies appear as an add only.

**Managed-block discipline** — the convention used by `hooks.ts` to inject shell code into existing git hook files without destroying user-owned content. Begin/end sentinel comments bracket the keryx-owned section; the installer updates only that section on re-runs and removes only that section on uninstall.

**Advisory sync** — the design principle that git hooks report drift but never auto-apply a heavy rebuild; the developer explicitly runs `keryx sync --apply` to reconcile artifacts.

## Main flows

**1. Recording provenance after a build** — When a module such as `gdgraph` finishes rebuilding, `src/commands` calls `recordProvenance(cwd, "gdgraph", builtAt)` from `provenance.ts`. `gitHead` runs two `git rev-parse` calls to capture the current commit SHA and branch name. These are merged with the provided ISO timestamp into a `Provenance` object and written as JSON to `.metaproject/data/gdgraph/.provenance.json`. On a non-git project `gitHead` returns `null` and the function returns early with no file written.

**2. Computing what changed since the last build (incremental sync)** — A `keryx sync` invocation reads the stored provenance via `readProvenance(cwd, module)`, extracts the `commit` field, and passes it to `diffSince(cwd, commit)` in `diff.ts`. `diffSince` runs `git diff --name-status <commit>` against the current working tree (capturing both committed changes since that SHA and any uncommitted edits), parses the output with `parseNameStatus`, and returns a `SyncDiff`. Callers then apply `codeOnly(diff)` to drop documentation-only paths before deciding which graph/wiki/memory entries to update.

**3. Installing git hooks** — `installSyncHooks(projectRoot)` in `hooks.ts` iterates over `["post-merge", "post-checkout"]`. For each hook it reads the existing hook file (defaulting to a bare shebang if absent), checks for a pre-existing managed block, and either replaces that block or appends a new one. The generated shell function runs `keryx sync` and unconditionally returns 0. The file is then written back with execute permission (`0o755`). Uninstalling via `uninstallSyncHooks` reverses this by stripping the managed block and rewriting the file.

---

## Reference (from code graph)

Extracted deterministically by `keryx wiki collect`; regenerated by
`--force`. The prose sections above are the agent/human-owned part.

### Public API

- `Provenance` (interface)
- `SYNCED_MODULES`
- `SyncedModule`
- `provenancePath` (function)
- `gitCmd` (function)
- `gitHead` (function)
- `recordProvenance` (function)
- `readProvenance` (function)
- `SyncDiff` (interface)
- `isCodeFile` (function)
- `emptyDiff` (function)
- `totalChanges` (function)
- `parseNameStatus` (function)
- `diffSince` (function)
- `codeOnly` (function)

### Key files

- `src/sync/provenance.ts` - imported by 5, imports 1
- `src/sync/diff.ts` - imported by 2, imports 1
- `src/sync/hooks.ts` - imported by 2, imports 1
- `src/sync/diff.test.ts` - imported by 0, imports 1
- `src/sync/hooks.test.ts` - imported by 0, imports 1

### Depends on

- `src/lib` - 2 import(s)

### Depended on by

- `src/commands` - 5 import(s)
- `src/wiki` - 1 import(s)

### Graph signals

- Files: 5
- Cross-module imports: 2

## Related Wiki

Graph-derived - regenerated by `keryx wiki collect --force`. Only pages that
exist are linked; when enriching, add new links only to pages you have verified.

- [Wiki Index](../index.md)
- [Module src/lib](src-lib.md)
- [Module src/commands](src-commands.md)
- [Module src/wiki](src-wiki.md)

## Changelog

- 1.0.0 - Prose sections enriched by gdwiki enrich workflow (2026-07-10). Status promoted to accepted.
- 0.1.0 - Generated by `keryx wiki collect` at 2026-07-10T08:14:04.890Z. Prose sections are drafts for the gdwiki enrich workflow.
