# Context

Collected deterministically by `keryx flow init` at 2026-08-15T21:42:48.802Z.
The flow-init skill enriches this with formalization, brainstorm results, and
interview answers.

## Related Memory

- [accepted/constraint] Flow ids are allocated per clone, not per checkout - `.metaproject/memory/constraints/flow-ids-allocated-per-clone.md`

## Code Graph

- `.metaproject/data/gdgraph/artifacts/summary.md`
- `.metaproject/data/gdgraph/artifacts/module-map.json`

Use `keryx gdgraph affected <file>` for blast radius.

## Code Health

- gate: pass (as of 2026-08-13T11:45:42.811Z)
- refresh: `keryx health run`

## Enabled Metaproject Modules

- gdgraph
- gdctx
- gdskills
- memory
- tasks
- health
- testing
- gdwiki
- security
- mcp

## Agent Findings

Full docpack read in full: `docs/requirements/sac-workspace-lifecycle/prd.md`,
`specification.md`, `phase-execution-prompts.md`.

Key code already read directly (no gdgraph/gdwiki narrowing needed — the
docpack already named exact files/line ranges):

- `src/sac/workspace-service.ts` — `WorkspaceManifest.status: "active" |
  "archived"` already exists; `addResource` (205-223) is the literal write
  skeleton to mirror; `withAuthorizedActor` (129-139) runs `execute` inside
  the per-workspace file lock after `authorizeSacUse` write-rank check + a
  TOCTOU re-check — owner-only gates belong inside `execute`.
- `src/sac/collaboration-service.ts:15` — existing precedent for an
  owner-only local gate inside `withAuthorizedActor`'s `execute` (`record()`
  throws `access_denied` when `role !== "owner"`) — same pattern to reuse for
  archive/removeResource/rename.
- `src/sac/index.ts` — `validateWorkspace` (284-307) already enforces
  single-owner topology and `status` enum `["active","archived"]` (line 290);
  `authorizeSacUse` (582-590) requires rank>=2 (editor+) for `write`/`review`
  actions — untouched by this package. Normative schema
  `docs/requirements/shared-agent-context/schemas/workspace-manifest.schema.json:12`
  also already allows `"archived"`.
- `src/sac/proposal-lifecycle.ts` — `create()` (propose, 53-79) and
  `review()` (81-111) both call `workspaces.withAuthorizedActor`. `create`'s
  `execute` currently ignores the `manifest` argument — needs to read it for
  the archived-guard. `targetWriteOrStale` (113-130) and `validateEvidence`
  (179) resolve evidence via `resolveWorkspaceReference` on
  `proposal.evidence[].uri` directly, never via `manifest.resources[]`
  membership — grounds AC-6.
- `src/sac/fwk-service.ts` (~584-590) — `overview`/`read` read
  `manifest.resources` directly; a removed resource disappearing from FWK
  output immediately is the intended in-scope effect, not a regression.
- `src/commands/workspace.ts` — CLI composition pattern (`service()`
  factory, `rejectUnknownOptions`, per-subcommand usage strings, JSON stdout)
  to extend for `archive`/`remove-resource`/`rename`/`--include-archived`.
- `src/sac/workspace-service.test.ts` — existing test conventions (temp-dir
  root, `server(subject)`, `service(root, subject, guard)`, TOCTOU test
  pattern with `withFileLock`) to extend.
- `docs/requirements/slate/specification.md` — already cross-references this
  package (SLATE-13 row, AC-13) confirming WSL-2's primitive is the correct,
  minimal, already-agreed scope boundary with the slate package.

No open questions — requirements are unambiguous and fully specified;
brainstorm/interviewer steps skipped per flow-init workflow step 5 (dispatch
interviewer only if hard requirements are ambiguous).
