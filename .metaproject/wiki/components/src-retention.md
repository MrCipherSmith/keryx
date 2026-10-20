---
Title: Module src/retention
Version: 1.0.2
Type: component
Status: accepted
VerifiedScope: sha256:2f1d309102ecc7b3ffdbe8b1db96b357e0385037245a05a57f56c4ca5588542b
Summary: "`src/retention` groups 7 file(s). Depends on `src/lib`. Exposes 15 public symbol(s)."
---
# Module src/retention

## Summary

`src/retention` owns the policy and filesystem seam for bounding two kinds of content that grow under `.metaproject/` without limit: the gdctx raw and artifact stores, and the refused-write conflict sidecars kept per workspace. It defines what a retention target is, the age and byte limits applied to each, and a sweep engine that reports every target as `ok`, `incomplete` or `empty` rather than folding failures into a clean result.

## Overview

`src/retention` decides which retention-relevant artifacts under `.metaproject/` are too old or too large to keep, and removes them. It covers the gdctx raw and artifact directories and the `*-write-conflicts` directories under `.metaproject/workspaces/`, which had no cleanup before this module. The module holds the policy and the mechanism; the `keryx retention sweep` command and the ctx write path decide when a sweep runs.

## How it works

The module has four layers. `src/retention/fs-deps.ts` defines `RetentionFsDeps` (`readdir`, `statEntry`, `remove`) as the only way sweep logic touches the filesystem. `defaultFsDeps` is the Node `fs/promises` implementation. The seam exists so the unreachable-store path can be tested with a fake that throws, instead of relying on OS permission tricks that fail when run as root.

`src/retention/policy.ts` holds the domain types, the limits, and discovery. `gdctxTargets` returns the two fixed gdctx targets. `discoverOwnerConflictTargets` walks `workspaces/<id>/` for `*-write-conflicts` directories, and records unreadable paths as issues instead of hiding them behind an empty result.

`src/retention/sweep.ts` is the single place that decides eligibility. It sorts entries oldest first and selects those past the age cutoff, then evicts the oldest survivors until the byte cap holds. Dry run runs the same decision logic with `deps.remove` never called. `sweepAll` runs the targets, and `sweepProject` adds discovery and folds any discovery issue into an `incomplete` report.

`src/retention/auto-sweep.ts` applies the same policy to the gdctx targets only, at most once per 24 hours, from the ctx write path. A stamp file records start and completion separately, and an exclusive `wx` claim keeps concurrent ctx runs from sweeping at the same time.

## Key concepts

- **`RetentionUnit`**: `"file" | "directory"`. A file target sweeps one file per entry. A directory target sweeps a whole subdirectory, and `statEntry` recurses to total its bytes.
- **`RetentionEntryStat`**: the two facts the policy needs, `bytes` and `mtimeMs`.
- **`RetentionTarget`**: one directory to sweep, with its `id`, `unit`, `maxAgeDays` and `maxBytes`.
- **`TargetDiscoveryResult`**: `targets` plus `issues`. The two are kept apart so "nothing found" cannot be mistaken for "could not look".
- **`TargetSweepResult` and `SweepReport`**: each target ends `ok`, `incomplete` or `empty`, with `reasons` whenever it is not `ok`. Report-level `discoveryIssues` make the whole report `incomplete`.
- **`describeError`**: returns the Node error `code` when there is one, such as `EACCES`, and the message otherwise.

| Constant | Value | Applies to |
|----------|-------|------------|
| `DEFAULT_MAX_AGE_DAYS` | 14 | gdctx raw and artifacts |
| `GDCTX_RAW_MAX_BYTES` | 200 MiB | gdctx raw |
| `GDCTX_ARTIFACTS_MAX_BYTES` | 50 MiB | gdctx artifacts |
| `OWNER_CONFLICT_MAX_AGE_DAYS` | 30 | owner write-conflict directories |
| `OWNER_CONFLICT_MAX_BYTES` | 20 MiB | each owner write-conflict directory |

## Main flows

### 1. Discover targets

`discoverTargets` concatenates the fixed gdctx pair from `gdctxTargets` with what `discoverOwnerConflictTargets` finds. A missing `workspaces/` directory yields no targets and no issue. An unreadable `workspaces/`, or an unreadable workspace under it, adds to `issues`, and discovery continues with the rest. `sweepProject` carries those issues into the report.

### 2. Sweep one target

`sweepTarget` lists the directory and stats each entry. A failed stat marks the target `incomplete` and skips that entry. Entries older than `maxAgeDays` are selected with reason `age`. If the surviving bytes still exceed `maxBytes`, the oldest unselected entries are selected with reason `bytes-cap` until the total fits. With `dryRun`, selected entries are reported as `would-remove`. Otherwise each is passed to `deps.remove`. A failed removal is recorded as `remove-failed`, and the loop continues. A removal that finds the entry already gone counts as removed.

### 3. Automatic sweep from the ctx write path

`maybeAutoSweepGdctx` returns early when `KERYX_RETENTION_AUTO` is `0`, `off` or `false`. Otherwise it reads `.metaproject/data/retention/last-auto-sweep.json`. A stamp whose `startedAtMs` is under 24 hours old throttles the run. A stamp with no `completedAtMs` means a sweep started and its outcome is unknown, so the claim's pid is checked to tell a live sweep (`in-progress`) from a dead one. Otherwise the process takes the `wx` claim, re-reads the stamp under the claim, writes a started-only stamp, runs `sweepAll` over `gdctxTargets` with `dryRun: false`, and writes `completedAtMs` only after the sweep returns. The function is documented as never throwing and never printing. Its result goes back to the caller, and the ctx command's own output is unchanged.

<!-- keryx:reference:begin v=1 hash=cfa92769800fc3e6b7ff9c17bace1990519f50c70401bea21c92bd4501a459ce -->
## Reference (from code graph)

Extracted deterministically by `keryx wiki collect`; regenerated by
`--force`. The prose sections above are the agent/human-owned part.

### Public API

- `RetentionUnit`
- `RetentionEntryStat`
- `RetentionFsDeps`
- `describeError`
- `defaultFsDeps`
- `RetentionTarget`
- `DEFAULT_MAX_AGE_DAYS`
- `GDCTX_RAW_MAX_BYTES`
- `GDCTX_ARTIFACTS_MAX_BYTES`
- `OWNER_CONFLICT_MAX_AGE_DAYS`
- `OWNER_CONFLICT_MAX_BYTES`
- `gdctxTargets`
- `TargetDiscoveryResult`
- `discoverOwnerConflictTargets`
- `discoverTargets`

### Key files

- `src/retention/fs-deps.ts` - imported by 8, imports 0
- `src/retention/policy.ts` - imported by 5, imports 2
- `src/retention/auto-sweep.ts` - imported by 3, imports 3
- `src/retention/sweep.ts` - imported by 3, imports 3
- `src/retention/auto-sweep.test.ts` - imported by 0, imports 3
- `src/retention/sweep.test.ts` - imported by 0, imports 3

### Depends on

- `src/lib` - 2 import(s)

### Depended on by

- `src/commands` - 4 import(s)

### Dependency basis

- Production imports only: 3 import(s) from test file(s) (e.g. `src/forgetting/journal.test.ts`) excluded from the two sections above in both directions.

### Graph signals

- Files: 7
- Cross-module imports: 2
<!-- keryx:reference:end -->

## Related

- [Wiki Index](../index.md)
- [Module src/lib](src-lib.md)
- [Module src/commands](src-commands.md)
- [Module src/forgetting](src-forgetting.md)

## Changelog

- 1.0.2 - Reference refreshed from the code graph. Source graph was stale; VerifiedAt was not advanced.
- 1.0.1 - Unwrapped from the markdown code fence an earlier enrich left around the page; no content changed.
- 1.0.0 — Prose enriched from Key files by the gdwiki skill.
- 0.1.0 — Initial generation by `keryx wiki collect`; prose enriched from public API, key files, and dependency graph.
