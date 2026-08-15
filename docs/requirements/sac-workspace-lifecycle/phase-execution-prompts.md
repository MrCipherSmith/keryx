# SAC Workspace Lifecycle Completion — Phase Execution Prompts
Version: 1.0.0

This file preserves the approved prompt for executing this package's single
implementation phase. May run in a worktree parallel to
`docs/requirements/slate/phase-execution-prompts.md` Phase 1, from `main`,
starting immediately — no dependency on slate in either direction.

## 1. Archive, resource removal, rename

Create a worktree from `main`. Run `flow-orchestrator` for
SAC Workspace Lifecycle Completion — Phase 1: Archive, resource removal,
rename.

### Scope

- `WorkspaceService.archive(workspaceId)` (`src/sac/workspace-service.ts`):
  owner-only local gate inside `execute(manifest)` — do **not** widen
  `authorizeSacUse`'s rank system for this. `status: "archived"` (schema
  already allows it, no schema change needed). `list()` gains a default
  `status !== "archived"` filter; CLI (`src/commands/workspace.ts`) gains
  `--include-archived`. `addResource`/`propose` reject with `guard_denied`
  against an archived workspace. `review()` of proposals that predate
  archival is untouched — never gated on workspace status.
- A `list()` variant/parameter that always bypasses the archived filter,
  used exclusively by pending-proposal discovery paths (consumed later by
  `slate`'s SLATE-10/SLATE-13 — this package doesn't build those, only the
  primitive they need).
- `WorkspaceService.removeResource(workspaceId, uri)`: mirror
  `addResource`'s write mechanics (`workspace-service.ts:205-223`) exactly
  in form — `not_found` if the uri is absent, `validateManifest`,
  `writeFileAtomic` under the existing lock — but owner-only in
  authorization, unlike `addResource` which stays editor+.
- `WorkspaceService.rename(workspaceId, title)`: same skeleton, owner-only,
  updates `title` and `updatedAt` only.
- Do **not** build, even in a minimal/temporary form: `addMember`/
  `removeMember`/`updateRole` (any shape — see specification.md's Permission
  model for why this was explicitly rejected, not deferred by oversight),
  `delete` (conflicts with SAC's own `AC-9` append-only audit guarantee),
  or any manifest checksum/signature layer.

### Acceptance criteria

- `archive()`/`removeResource()`/`rename()` all deny `editor`/`viewer` with
  `access_denied`; only `owner` succeeds.
- An archived workspace is absent from `workspace list` unless
  `--include-archived` is passed; `workspace show <id>` still succeeds for a
  role-visible actor regardless of archive status.
- `addResource`/`propose` against an archived workspace fail with
  `guard_denied`, never silently succeed.
- `review()` of a pre-archival proposal completes normally.
- `removeResource` never causes a pending or accepted proposal's evidence
  resolution to fail (verify directly against `resolveWorkspaceReference`,
  don't assume).
- `rename()` changes only `title`/`updatedAt` — `id`/`resources`/`members`
  unaffected.
- No `addMember`/`removeMember`/`updateRole` method or CLI command exists
  anywhere in the diff.
- No code path physically deletes a `workspace.json` or its directory.

### Required reading

`docs/requirements/sac-workspace-lifecycle/{prd.md,specification.md}` in
full — the package is small enough that partial reading risks missing the
Permission model section's reasoning for the two rejected operations.

### Delivery protocol

Create a draft PR, perform full review and remediate findings until
reviewers return without problems. Merge into `main` (or the shared feature
branch, whichever `slate`'s Phase 5 will branch from), close the Flow, then
delete the worktree.
