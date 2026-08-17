# Plan

Requirements are fully specified in the approved docpack
(`docs/requirements/sac-workspace-lifecycle/{prd.md,specification.md}`); no
brainstorm/interview step is needed. Chosen approach below is the docpack's
own Functional surface table, made concrete against the real code already
read (`src/sac/workspace-service.ts`, `src/sac/index.ts`,
`src/sac/proposal-lifecycle.ts`, `src/commands/workspace.ts`,
`src/sac/collaboration-service.ts`, `src/sac/fwk-service.ts`).

## WSL-1 — archive()

`WorkspaceService.archive(input)` uses `withAuthorizedActor({ action: "write",
execute: (manifest) => {...} })` — the same pattern
`collaboration-service.ts`'s `record()` already uses for its owner-only local
gate (`manifest.members.find(m => m.subject === actor.subject)?.role !==
"owner"` → `WorkspaceServiceError("access_denied", ...)`). Inside `execute`
(which already runs under the per-workspace file lock and after
`authorizeSacUse`'s write-rank check + TOCTOU re-check), after the owner gate:
`next = {...manifest, status: "archived", updatedAt: this.timestamp()}`,
`await this.validateManifest(next)`, `await writeFileAtomic(...)`. No schema
change — `"archived"` is already a valid `status` enum value in both the
TypeScript validator (`src/sac/index.ts:290`) and the normative JSON Schema
(`docs/requirements/shared-agent-context/schemas/workspace-manifest.schema.json:12`).

## WSL-2 — pending-discovery primitive

`WorkspaceService.list()` gains an `includeArchived?: boolean` input field
(default `false`, filters `status !== "archived"` same as today's implicit
behavior). This same parameter IS the primitive SLATE-10/SLATE-13's future
`listVisibleProposedProposals(actor)` will call with `includeArchived: true`
— this package does not build that function, only exposes the parameter it
needs (confirmed already cross-referenced in
`docs/requirements/slate/specification.md` SLATE-13 row and AC-13). CLI
(`src/commands/workspace.ts` `list` subcommand) gains `--include-archived`
wired to the same field.

## WSL-3 — removeResource()

Mirrors `addResource` (`workspace-service.ts:205-223`) literally in write
mechanics: `requireActor` → `requireStrict("write")` → `readManifest` →
`requireAuthorization(actor, id, "write")` → `withFileLock` → re-read →
`atUse` TOCTOU check → **new: owner-only local gate** → find resource by
`uri`, `not_found` if absent → filter it out of `resources[]` →
`validateManifest` → `writeFileAtomic`. Verified against
`proposal-lifecycle.ts`'s `targetWriteOrStale`/`validateEvidence`
(`proposal-lifecycle.ts:113-130,179`): evidence resolution always calls
`resolveWorkspaceReference` directly on the proposal's stored `evidence[].uri`
— it never looks the URI up in `manifest.resources[]` — so removing a
resource cannot break a pending or accepted proposal's evidence resolution
(AC-6). `fwk-service.ts` (`overview`/`read`, lines ~584-590) reads
`manifest.resources` directly, so a removed resource correctly disappears
from FWK output immediately — that is the intended, in-scope effect.

## WSL-4 — rename()

Same skeleton as `archive()` (`withAuthorizedActor`, owner-only local gate),
`next = {...manifest, title: input.title, updatedAt: this.timestamp()}`. No
other field touched.

## Archived-write guards (AC-3)

- `addResource`: add a `manifest.status === "archived"` check inside the
  `withFileLock` callback (after the `atUse` TOCTOU check, before the
  `resources.some(...)` duplicate check) → `throw new
  WorkspaceServiceError("guard_denied", "workspace is archived")`.
- `propose` (`proposal-lifecycle.ts` `create()`): its `withAuthorizedActor`
  call currently has `execute: async () => {...}` ignoring `manifest`; change
  to `execute: async (manifest) => { if (manifest.status === "archived")
  throw new ProposalLifecycleError("guard_denied", "workspace is
  archived"); ...same body... }`.
- `review()` (`proposal-lifecycle.ts` `review()`): explicitly NOT touched —
  no status check added, per AC-4/WSL-1.

## CLI (`src/commands/workspace.ts`)

- `list`: accept `--include-archived` (boolean flag, no value), thread to
  `service().list({ ..., includeArchived: args.includes("--include-archived")
  })`.
- New subcommands `archive <workspace-id>`, `remove-resource <workspace-id>
  --uri <uri>`, `rename <workspace-id> --title <title>`, following the exact
  `rejectUnknownOptions`/usage-string/JSON-stdout conventions already used by
  `add-resource`/`show`.
- `printHelp()` updated with the three new lines.
- No `add-member`/`remove-member`/`update-role` subcommand anywhere in the
  diff (AC-7).

## Testing

`tests-creator` writes failing tests first in
`src/sac/workspace-service.test.ts` (owner-only gates for all three new
methods against editor/viewer; archive → list filtering; archive →
addResource/propose guard_denied; archive → review still succeeds; rename
field-scoping; removeResource not_found + evidence-safety against a live
`ProposalLifecycleService`) and `src/commands/workspace.test.ts` if it
exists (CLI wiring), then `task-implementer` makes them pass.

## Verification

Focused `bun test src/sac/ src/commands/workspace.test.ts` (or equivalent),
`code-verifier`, `keryx health run`, `review-orchestrator` (security +
backend focus given SAC's security-critical authorization code), fix findings,
repeat until clean.
