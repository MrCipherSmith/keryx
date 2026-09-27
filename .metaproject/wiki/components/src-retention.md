---
Title: Module src/retention
Version: 0.1.0
Type: component
Status: draft
Summary: "`src/retention` groups 7 file(s). Depends on `src/lib`. Exposes 15 public symbol(s)."
---
```markdown
---
Title: Module src/retention
Version: 0.1.0
Type: component
Status: accepted
Summary: "`src/retention` groups 7 file(s). Depends on `src/lib`. Exposes 15 public symbol(s)."
---

# Module src/retention

## Summary

`src/retention` owns the core abstractions for identifying, describing, and cleaning retention-relevant artifacts. It provides types, constants, and filesystem-facing helpers used to define retention units, entry statistics, and target metadata.

The module is consumed by higher-level orchestration such as [src/commands](src-commands.md) and [src/forgetting](src-forgetting.md). Those consumers discover cleanup targets, apply policy bounds, and perform retention operations without depending directly on lower-level filesystem details.

## Overview

The module organizes around four cooperating layers:

- **Filesystem abstraction** (`src/retention/fs-deps.ts`): defines `RetentionFsDeps`, a contract for filesystem operations needed by retention logic. `defaultFsDeps` provides the production implementation, and `describeError` normalizes failures for user-facing or test-facing use.
- **Policy and target model** (`src/retention/policy.ts`): exposes core domain types and constants including `RetentionUnit`, `RetentionEntryStat`, `RetentionTarget`, target discovery result types, and budget/age limits.
- **Sweep and auto-sweep logic** (`src/retention/sweep.ts`, `src/retention/auto-sweep.ts`): builds on policy types and the filesystem contract to coordinate retention execution.
- **Test coverage** (`src/retention/auto-sweep.test.ts`, `src/retention/sweep.test.ts`): exercises sweep and auto-sweep paths through the module's public and internal seams.

## Key Concepts

### Domain Types

- **`RetentionUnit`**: core unit for modeling a retention-managed object or grouping of related entries.
- **`RetentionEntryStat`**: stats-oriented interface for individual retention entries, including information used to determine cleanup or sweep eligibility.
- **`RetentionTarget`**: a discovered target that retention logic can act upon.
- **`TargetDiscoveryResult`**: result type for discovery flows that identify one or more retention targets.

### Filesystem Abstraction

- **`RetentionFsDeps`** (interface): contract defining filesystem operations needed by retention logic.
- **`defaultFsDeps`**: production implementation of `RetentionFsDeps`.
- **`describeError`**: helper for consistent failure descriptions during retention operations.

### Policy Constants

| Constant | Purpose |
|----------|---------|
| `DEFAULT_MAX_AGE_DAYS` | Default age limit for retention entries |
| `GDCTX_RAW_MAX_BYTES` | Size budget for raw gdctx artifacts |
| `GDCTX_ARTIFACTS_MAX_BYTES` | Size budget for processed gdctx artifacts |
| `OWNER_CONFLICT_MAX_AGE_DAYS` | Age limit for owner-conflict entries |
| `OWNER_CONFLICT_MAX_BYTES` | Size budget for owner-conflict cleanup |

### Discovery Functions

- **`discoverTargets`**: general entry point for finding retention targets.
- **`discoverOwnerConflictTargets`**: specialized discovery for owner-conflict cleanup cases.
- **`gdctxTargets`**: selects or constructs gdctx-specific retention targets.

## Main Flows

### 1. Discover Retention Targets

Higher-level code uses the discovery surface to identify cleanup candidates:

1. Call `discoverTargets` for general discovery, `gdctxTargets` for gdctx-specific targets, or `discoverOwnerConflictTargets` for owner-conflict cases.
2. Receive a `TargetDiscoveryResult` containing typed `RetentionTarget` values.

### 2. Apply Retention Policy Bounds

Retention behavior is guided by named constants rather than scattered literals:

- **Age limits**: `DEFAULT_MAX_AGE_DAYS`, `OWNER_CONFLICT_MAX_AGE_DAYS`
- **Size budgets**: `GDCTX_RAW_MAX_BYTES`, `GDCTX_ARTIFACTS_MAX_BYTES`, `OWNER_CONFLICT_MAX_BYTES`

This approach makes policy easier to compare, test, and evolve.

### 3. Execute Filesystem-Backed Retention Operations

After targets are identified, retention execution uses the filesystem abstraction:

1. Operations rely on `RetentionFsDeps` to inspect or mutate filesystem state.
2. `defaultFsDeps` supplies the production implementation.
3. `describeError` provides consistent failure interpretation.

This keeps core retention logic testable while supporting real filesystem behavior.

## Reference

### Public API

**Types**
- `RetentionUnit`
- `RetentionEntryStat` (interface)
- `RetentionFsDeps` (interface)
- `RetentionTarget` (interface)
- `TargetDiscoveryResult` (interface)

**Functions**
- `describeError`
- `gdctxTargets`
- `discoverOwnerConflictTargets`
- `discoverTargets`

**Values**
- `defaultFsDeps`
- `DEFAULT_MAX_AGE_DAYS`
- `GDCTX_RAW_MAX_BYTES`
- `GDCTX_ARTIFACTS_MAX_BYTES`
- `OWNER_CONFLICT_MAX_AGE_DAYS`
- `OWNER_CONFLICT_MAX_BYTES`

### Key Files

| File | Imports | Imported By |
|------|---------|-------------|
| `src/retention/fs-deps.ts` | 0 | 8 |
| `src/retention/policy.ts` | 2 | 5 |
| `src/retention/auto-sweep.ts` | 3 | 3 |
| `src/retention/sweep.ts` | 3 | 3 |
| `src/retention/auto-sweep.test.ts` | 3 | 0 |
| `src/retention/sweep.test.ts` | 3 | 0 |

### Dependencies

- **Depends on**: [src/lib](src-lib.md) (3 imports)
- **Depended on by**: [src/commands](src-commands.md) (4 imports), [src/forgetting](src-forgetting.md) (2 imports)

## Related

- [Wiki Index](../index.md)
- [Module src/lib](src-lib.md)
- [Module src/commands](src-commands.md)
- [Module src/forgetting](src-forgetting.md)

## Changelog

- 0.1.0 — Initial generation by `keryx wiki collect`; prose enriched from public API, key files, and dependency graph.
```
