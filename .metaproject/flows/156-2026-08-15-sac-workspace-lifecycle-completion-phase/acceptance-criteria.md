# Acceptance Criteria

Verbatim from `docs/requirements/sac-workspace-lifecycle/specification.md`
AC-1..AC-10 (renumbered AC1..AC10 for the flow), scoped to Phase 1
(archive/removeResource/rename — SLATE-10/SLATE-13 themselves are out of
scope, only their required primitive is in scope per WSL-2).

- AC1: `archive()` requires the calling actor to hold `owner` role on the
  target workspace; `editor`/`viewer` are denied `access_denied`.
- AC2: An archived workspace is absent from `workspace list` output unless
  `--include-archived` is passed; `workspace show <id>` on an archived
  workspace still succeeds for a role-visible actor (archive changes
  discovery, not direct read).
- AC3: `addResource`/`propose` against an archived workspace are rejected
  with a typed `guard_denied` error, never silently accepted.
- AC4: `review()` of a proposal that predates its workspace's archival
  completes normally — archive never blocks in-flight review.
- AC5: The `list()` primitive that always bypasses the archived filter
  (`includeArchived: true`) surfaces archived workspaces exactly as active
  ones for a role-visible actor — this is the primitive SLATE-10/SLATE-13
  will consume; this package verifies the primitive itself, not
  SLATE's own discovery functions (not built here).
- AC6: `removeResource` never causes a pending or accepted proposal's
  evidence resolution to fail — verified directly against
  `resolveWorkspaceReference`/`targetWriteOrStale`, not assumed.
- AC7: No code path in this package accepts a client-supplied `subject`
  string as a new workspace member; there is no `addMember`/`removeMember`/
  `updateRole` method or CLI command shipped by this package.
- AC8: No code path in this package physically removes a `workspace.json`
  or its directory; only `archive` (status mutation) exists.
- AC9: `removeResource()` and `rename()` both require the calling actor to
  hold `owner` role on the target workspace, exactly like `archive()` (AC1)
  — `editor`/`viewer` are denied `access_denied` on both, not only on
  `archive`. `addResource` remains editor+, unchanged by this package.
- AC10: `rename()` updates `title` and `updatedAt` and nothing else in the
  manifest; a subsequent `show`/`list` reflects the new title immediately,
  and the workspace's `id`/`resources`/`members` are unaffected.
