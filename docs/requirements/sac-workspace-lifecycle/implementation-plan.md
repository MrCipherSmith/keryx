# SAC Workspace Lifecycle Completion — Implementation Plan
Version: 1.0.0

## Delivery status

Design-only as of 2026-08-16. No phase below has landed.

## Delivery rules

Single managed Flow — WSL-1 through WSL-4 are small (S effort each per
Pragmatist's independent estimate), mirror the existing `addResource`
skeleton one-to-one, and touch the same file (`src/sac/workspace-service.ts`)
plus its CLI surface (`src/commands/workspace.ts`). Splitting them into
separate Flows would add coordination overhead without a real independence
benefit — WSL-2 in particular is not meaningfully separable from WSL-1 (its
own PRD states they "must land together, not separately").

This package has **no dependency on `slate`**. It may start immediately, in
parallel with `docs/requirements/slate/implementation-plan.md` Phase 1, and
must merge before [`slate`'s Phase 5](../slate/implementation-plan.md)
starts.

## Phase 1 — Archive, resource removal, rename

- `WorkspaceService.archive(workspaceId)`: owner-only local gate,
  `status: "archived"`, no schema change. `list()` gains a default
  `status !== "archived"` filter; CLI gains `--include-archived`.
  `addResource`/`propose` reject archived workspaces with `guard_denied`.
  `review()` of existing proposals is untouched.
- A `list()` variant (or parameter) that never applies the archived filter,
  used specifically by pending-proposal discovery — the safety property
  `slate`'s SLATE-10/SLATE-13 depend on.
- `WorkspaceService.removeResource(workspaceId, uri)`: mirrors
  `addResource`'s write mechanics, owner-only (not editor+, unlike
  `addResource`).
- `WorkspaceService.rename(workspaceId, title)`: same skeleton, owner-only.
- Explicitly **not** built: `addMember`/`removeMember`/`updateRole` (any
  form, including a "minimal" owner-only one), `delete`, any
  checksum/signature integrity layer over `workspace.json`.

**Exit:** AC-1 through AC-10 in
`docs/requirements/sac-workspace-lifecycle/specification.md` all pass; the
existing `authorizeSacUse` rank system is untouched (verified via its own
test suite still green); no new CLI/MCP surface exists for member
management or deletion.

## Definition of done

Done only when AC-1–10 pass and `slate`'s Phase 5 can build on this
package's `list()` archived-bypass variant without further changes to this
package.
