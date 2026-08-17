# SAC Workspace Lifecycle Completion — Specification
Version: 1.0.0

## Identity and ownership

| Concern | Owner | This package's responsibility |
|---|---|---|
| Workspace manifest write path | `src/sac/workspace-service.ts` (`WorkspaceService`) | Extend with 3 new mutation methods, same skeleton as existing `addResource` |
| General authorization ranking (`read`/`write`/`review`/`egress`) | `src/sac/index.ts` (`authorizeSacUse`) | Not modified — owner-only checks are a local gate inside `execute(manifest)`, not a new rank |
| Proposal enumeration/discovery | `docs/requirements/slate/` (SLATE-10/SLATE-13) | This package fixes an interaction (WSL-2), doesn't own the enumeration itself |
| Multi-person identity | [SAC RP-06](../shared-agent-context-identity-capabilities/README.md) (future) | Explicitly not built here — member management is out of scope |
| Append-only proposal audit trail | `docs/requirements/shared-agent-context/specification.md` (AC-9) | Constrains this package — delete is out of scope because it would conflict |

## Functional surface

| ID | Function | Implementation proposal |
|---|---|---|
| WSL-1 | Archive | `WorkspaceService.archive(workspaceId)`: `withAuthorizedActor({action:"write", execute: manifest => { requireOwner(manifest, actor); return {...manifest, status: "archived", updatedAt: this.timestamp()} }})`, then `validateManifest`+`writeFileAtomic` under the existing lock. `list()` gains a default `status !== "archived"` filter; CLI gains `--include-archived`. `addResource`/`propose` reject with `guard_denied` when `manifest.status === "archived"`. `review()` of already-existing proposals is untouched — not gated on archived status. |
| WSL-2 | Pending-review discovery bypasses archived filter | SLATE-13's `listVisibleProposedProposals(actor)` must enumerate workspaces via a variant of `list()` that never applies the archived filter — pending-proposal discovery is a safety property, not a declutter convenience. Cross-reference: `docs/requirements/slate/specification.md` SLATE-10/SLATE-13 rows must note this explicitly. |
| WSL-3 | Resource removal | `WorkspaceService.removeResource(workspaceId, uri)`: mirrors `addResource` (`workspace-service.ts:205-223`) in write mechanics only (filter `resources[]`, `not_found` if absent, `validateManifest`, `writeFileAtomic`), **not** in authorization level — `addResource` stays editor+, `removeResource` is owner-only like the other three WSL operations (see Permission model). No cascading effect on `proposal-lifecycle.ts`'s evidence resolution (verified: `targetWriteOrStale` resolves evidence via `resolveWorkspaceReference` directly, never via `resources[]` membership). |
| WSL-4 | Rename/title edit | `WorkspaceService.rename(workspaceId, title)`: same skeleton, `next = {...manifest, title, updatedAt}`, owner-only. |

## Permission model and security invariants

Owner-only for the three new operations this package adds — `archive`,
`removeResource`, `rename` — while the existing `addResource` stays editor+
exactly as it behaves today, unchanged by this package. The owner check is a
**local gate inside `execute(manifest)`**, not a change
to `authorizeSacUse`'s rank system — `authorizeSacUse` is a security-critical
boundary also relied on by `proposal-lifecycle.ts` and `fwk-service.ts`;
widening it for three new owner-only operations is not worth that blast
radius. A manifest with the workspace's sole owner removed already fails
schema validation (`role_topology`/`duplicate_subject_role` in `src/sac/
index.ts:284-307`) — this package relies on that existing check, adds no new
topology logic.

**Member management is explicitly out of scope, not deferred as "too hard."**
`localWorkspaceAuthorizationServer` derives `subject` solely from the OS
user id (`user:local-${uid}`) — no transport today ever emits a
`TrustedActorContext` carrying any other subject. Adding a member with an
arbitrary subject string would create an ACL entry no live actor could ever
present — not multi-person sharing, an unauthenticatable declaration. Shipping
this now would legitimize a non-functional illusion of sharing and would need
migration once [RP-06](../shared-agent-context-identity-capabilities/README.md)
lands with a real multi-agent/remote identity model. This applies even to a
"minimal, owner-only" `addMember` — the risk is not the write-authorization
path, it's the false expectation the API's mere existence creates.

**Delete is explicitly out of scope.** `AC-9` in `docs/requirements/
shared-agent-context/specification.md` requires rejected/dismissed/stale
proposals to retain audit-only metadata; `artifact-lifecycle.md`'s documented
lifecycle is `active → archived` only, with no delete state. A workspace with
any historical `accepted` proposal has audit-relevant history that physical
deletion would destroy. Archive is the only destructive-adjacent operation
in this package.

## Integrations and dependencies

- `src/sac/workspace-service.ts`: `addResource` (`205-223`) is the literal
  template for all three new methods — same lock, same validation, same
  write path.
- `src/sac/index.ts`: `validateWorkspace` (`284-307`) already enforces
  single-owner topology for free; not modified.
- `docs/requirements/slate/specification.md`: SLATE-10/SLATE-13 must be
  amended per WSL-2 — cross-reference required, not a one-way dependency.
- `docs/requirements/shared-agent-context/artifact-lifecycle.md`: normative
  source for archive semantics (`active → archived`, "archiving revokes
  normal discovery but preserves ... audit metadata", "deletion must not
  delete referenced targets") — this package implements what that doc already
  promised, doesn't invent new policy.
- `src/sac/proposal-lifecycle.ts`: `targetWriteOrStale` (`113-130`) — verified
  read-only dependency for WSL-3's safety claim (evidence resolution never
  goes through `resources[]` membership).

## Acceptance criteria

- **AC-1:** `archive()` requires the calling actor to hold `owner` role on
  the target workspace; `editor`/`viewer` are denied `access_denied`.
- **AC-2:** An archived workspace is absent from `workspace list` output
  unless `--include-archived` is passed; `workspace show <id>` on an
  archived workspace still succeeds for a role-visible actor (archive
  changes discovery, not direct read).
- **AC-3:** `addResource`/`propose` against an archived workspace are
  rejected with a typed `guard_denied` error, never silently accepted.
- **AC-4:** `review()` of a proposal that predates its workspace's archival
  completes normally — archive never blocks in-flight review.
- **AC-5:** `listVisibleProposedProposals` (SLATE-13) and `workspace
  catch-up` (SLATE-10) surface pending proposals from archived workspaces
  exactly as from active ones — archival status never silently removes a
  pending proposal from any discovery path a reviewer would use.
- **AC-6:** `removeResource` never causes a pending or accepted proposal's
  evidence resolution to fail — verified against `resolveWorkspaceReference`,
  not assumed.
- **AC-7:** No code path in this package accepts a client-supplied `subject`
  string as a new workspace member; there is no `addMember`/`removeMember`/
  `updateRole` method or CLI command shipped by this package.
- **AC-8:** No code path in this package physically removes a
  `workspace.json` or its directory; only `archive` (status mutation) exists.
- **AC-9:** `removeResource()` and `rename()` both require the calling actor
  to hold `owner` role on the target workspace, exactly like `archive()`
  (AC-1) — `editor`/`viewer` are denied `access_denied` on both, not only on
  `archive`. `addResource` remains editor+, unchanged by this package.
- **AC-10:** `rename()` updates `title` and `updatedAt` and nothing else in
  the manifest; a subsequent `show`/`list` reflects the new title
  immediately, and the workspace's `id`/`resources`/`members` are unaffected.
