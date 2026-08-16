# Description

## Problem

`WorkspaceService` (SAC-1 workspace registry) supports only
`create`/`list`/`show`/`addResource`. `status` is written once at `create()`
as `"active"` and never read or rewritten anywhere, even though
`artifact-lifecycle.md` documents an `active → archived` lifecycle. There is
no `removeResource`, so `resources[]` grows monotonically forever. There is
no rename. Member management is intentionally absent (see Out of scope).

## Expected outcome

`WorkspaceService` gains three new owner-only mutation methods —
`archive(workspaceId)`, `removeResource(workspaceId, uri)`,
`rename(workspaceId, title)` — that reuse the existing `addResource` write
skeleton (auth → mutate → `validateManifest` → `writeFileAtomic` under the
existing per-workspace lock), plus a `list()` archived-filter default with a
`--include-archived` CLI escape hatch, plus a primitive that lets future
pending-proposal discovery paths (SLATE-10/SLATE-13) always see archived
workspaces. `addResource`/`propose` reject writes against an archived
workspace with `guard_denied`; `review()` of an existing proposal is never
gated on workspace status.

## Out of scope (explicit non-goals, not deferred oversights)

- `addMember`/`removeMember`/`updateRole` in any form, even a minimal
  owner-only stub. `localWorkspaceAuthorizationServer` derives `subject`
  solely from the OS user id — no transport emits any other subject today.
  An added member could never authenticate as itself; this would legitimize
  an illusion of multi-person sharing. Explicitly deferred to SAC RP-06.
- `delete` (any physical removal of `workspace.json` or its directory).
  Conflicts with SAC `AC-9` (append-only audit metadata for
  rejected/dismissed/stale proposals); `artifact-lifecycle.md`'s only
  documented lifecycle is `active → archived`.
- Any checksum/signature layer over `workspace.json` integrity.
- Widening `authorizeSacUse`'s rank system. The three new owner-only checks
  are local gates inside each operation's `execute(manifest)`, following the
  precedent already established by `collaboration-service.ts`'s
  `record()` (`role !== "owner"` check inside `withAuthorizedActor`'s
  `execute`).

Full source of truth: `docs/requirements/sac-workspace-lifecycle/{prd.md,specification.md,phase-execution-prompts.md}`.
