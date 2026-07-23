# Flow ids are allocated per clone, not per checkout

Version: 1.0.0
Type: constraint
Status: accepted
Confidence: high

## Summary

`flow init` reserves its number in the git common directory, so every linked
worktree of one clone shares the id space. A number, once handed out, is never
reused — not even after the flow directory is deleted or renumbered.

## Details

Until flow 116, `nextFlowId` was `max(local .metaproject/flows listing) + 1` and
the init lock lived in that same directory. Both are per working copy, so two
worktrees each saw the same high-water mark and minted the same number; the
collision only became visible when the branches merged. That is how flows 002,
084 and 103 each ended up naming two different packages on `main`.

Consequences to respect:

- Parallel flow work belongs in a **worktree of the same clone**. A second
  independent clone is outside the shared scope and can still collide; the
  `duplicate-id` rule in `keryx flow check` is the net that catches it.
- Test fixtures must not create `.metaproject/flows` **inside the repository** —
  they would consume real ids from this clone's ledger and leak state between
  runs. Use an OS temp dir (see `src/flow/security-gate.test.ts`).
- Deleting a flow package does not free its number, so a fixture that expects
  "the first flow is always 001" is only valid outside a git checkout.
- Repair a collision only with
  `keryx flow renumber <dir> --to <free id> --reason "<why>"`; it records the
  move in `.metaproject/flows/id-map.json` so references in merged PRs and
  journals stay traceable. Never rename a flow directory by hand.
- While a collision exists, `resolveFlowDir` refuses the bare number instead of
  taking the first lexicographic match — commands and the harness
  `ManagedFlowPort` fail closed rather than writing evidence into a guessed
  package.

## Provenance

- Source: flow 116 (fix duplicate flow ids)
- Link: .metaproject/flows/116-2026-07-22-fix-duplicate-flow-ids-nextflowid-races-
- Created: 2026-07-22
- Updated: 2026-07-22

## Related Scopes

- Module: tasks
- Entity: flow
- Files: src/flow/allocation.ts, src/flow/store.ts, src/flow/service.ts, .metaproject/flows/id-map.json
- Skills: flow, flow-orchestrator

## Tags

flow, task-manager, worktree, ids, allocation

## Changelog

- 1.0.0 - Recorded from flow 116 (repo-wide allocation, ambiguity-safe
  resolution, renumber repair of 002/084/103).
