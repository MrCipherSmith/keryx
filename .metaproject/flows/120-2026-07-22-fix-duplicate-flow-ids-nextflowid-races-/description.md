# Fix duplicate flow ids: nextFlowId allocates per working copy and resolveFlowDir silently picks one of the colliding flows

Status: formalized
Source: user description ("оформи отдельным flow дубликаты номеров")

## Problem

`.metaproject/flows` currently contains three colliding flow ids — each number
belongs to two unrelated flows:

| id | flow A | flow B |
|----|--------|--------|
| 002 | `002-2026-07-10-gdgraph-java-python-import-resolution` | `002-2026-07-10-implement-keryx-execution-observability-` |
| 084 | `084-2026-07-20-fix-ci-externalize-opentui-core-in-build` | `084-2026-07-20-provider-picker-showed-only-1-of-n-provi` |
| 103 | `103-2026-07-21-p0-sandbox-credential-auto-mask-resolver` | `103-2026-07-21-sandbox-net-audit-runbook` |

Cause — id allocation is scoped to one working copy:

- `nextFlowId` (`src/flow/store.ts:23`) = `max(existing dir prefix) + 1`, read
  from the local `.metaproject/flows` listing only.
- The `withFileLock(".flow-init.lock")` guard in `src/flow/service.ts:133`
  serializes concurrent inits **within one checkout**, so it cannot see a
  sibling git worktree or another branch. Two worktrees both observe max=102 and
  both mint `103`; the collision only materializes when the branches merge.
  Confirmed for 103: `258fa8e` (P0 credential auto-mask) and `75eafea` (network
  audit runbook) each added a `103-*` directory on a separate branch.

Consequence — id lookup is ambiguous and silent:

- `resolveFlowDir` (`src/flow/store.ts:33`) returns the **first** directory
  matching `<id>-`, sorted lexicographically. `keryx flow status 103`,
  `flow task done 103 T2`, `flow ac confirm 103 AC1`, `flow complete 103` and
  `keryx review --flow 103` therefore all act on
  `103-…-p0-sandbox-credential-auto-mask-resolver` with no warning, and the
  other 103 is unreachable by id.
- The same ambiguity reaches the harness: `ManagedFlowPort.completeFromGate`
  (`src/harness/flow/managed-flow-port.ts:71`) resolves a run's `flowId` the
  same way, so harness evidence can be written into the wrong flow package.
- `keryx flow list` prints both entries under the same number, which is how the
  problem was noticed.

Consumers of `resolveFlowDir`: `src/flow/service.ts:55,87`,
`src/commands/flow.ts:133`, `src/review/managed.ts:34`.

## Expected Outcome

1. New flows cannot collide even when initialized from parallel git worktrees or
   parallel branches of the same repository.
2. An ambiguous id reference never resolves silently: it either fails with a
   listing of the candidates, or resolves deterministically by a rule the user
   can see.
3. The three existing collisions (002, 084, 103) are resolved without breaking
   references to them (git history, PR bodies, docs, runLink/evidence refs).
4. A repository check detects duplicate ids so the condition cannot silently
   return.

## Out of Scope

- Renaming/renumbering flows for cosmetic reasons (gaps such as the missing 058
  stay as they are).
- Changing the `NNN-YYYY-MM-DD-slug` directory naming convention itself.
- Retroactively rewriting git history of the six affected flow directories.
- Any change to flow status/gate semantics.
