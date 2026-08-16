# Slate Phase 5: Catch-up review and general-purpose listing

Status: frozen
Source: phase-execution-prompts.md section 5 (docs/requirements/slate/), verbatim scope from launch brief
Base branch: main (worktree branched from origin/main; PR targets main, matching Phases 1-4)

## Problem

Slate Phases 1-4 (flows 157/160/161/163, PRs #297/#301/#304/#306, all merged
into `main`) built the storage primitive, the Anchors/Course/Seeds lifecycle,
`/goal`'s deterministic entry point, and the wrap-up composer
(`resolveMachineWrapUp`/`runWrapUp` in `src/sac/machine-wrap-up.ts`) that
turns a session's Seeds into real `workspace propose` calls — or, when no
`workspaceId` was ever captured, into a local `unbound-candidate` artifact
under `<sessionDir>/slate-archive/<ts>-unbound-candidate.json` (confirmed by
direct read of `machine-wrap-up.ts:353-374`).

Two gaps remain unbuilt (SLATE-10, SLATE-13), and this is the final phase of
the whole slate feature:

1. **No pull-based catch-up surface.** A human returning to a project after
   one or more unattended/one-shot runs has no single command that shows
   what happened while they were away: pending proposals (including ones in
   archived workspaces — `WorkspaceService.list()` already supports the
   archived-bypass `{ includeArchived: true }` variant, confirmed by direct
   read of `workspace-service.ts:84-99`, this is WSL-2, already shipped on
   `main`), sessions that hit `ask_user`/budget exhaustion unattended,
   unbound-candidate artifacts nobody has triaged yet, and sessions whose
   fate is genuinely unknown (crashed, no evidence either way).
2. **No general-purpose proposal listing.** `keryx workspace propose`/
   `review` both require the caller to already know a `proposalId` (typed by
   a human who read a prior `propose` command's JSON output, or guessed).
   There is no `keryx workspace list-proposals` to discover what is pending
   without already knowing an id.

### A real, previously-undocumented gap found while grounding this flow

`TerminalState` (SLATE-11, spec's structured stop record) is built by
`emitTerminalState` (`src/commands/agent.ts:699-721`) and passed to
`io.onTerminalState?.(state)` plus rendered as a text block for
`io.onSystem`/`io.write` — **but it is never persisted to disk.**
`slate-terminal-state.ts`'s own doc comment (line 65) says the raw
`anchorsSnapshot` value is passed to `io.onTerminalState`, "e.g. for a future
SLATE-10 catch-up that needs the true on-disk shape" — but no code writes
`TerminalState` to any on-disk shape today; it only exists for the lifetime
of the callback invocation. Without a durable record, catch-up's "blocked"
category (spec's `CatchUpItem` union, `AC-11`) can never surface a single
real item after the process that hit `ask_user`/budget exhaustion has
exited — exactly the class of "implemented correctly but not wired into
every real call site" bug flagged as the recurring failure across Phases
2-4. **This flow's scope therefore includes persisting `TerminalState`** to
a durable, catch-up-discoverable location (a sibling file in the session
dir, mirroring `slate.json`/`slate-archive/`'s existing convention), wired
at `emitTerminalState`'s existing call site — not a new trigger, no new
call site beyond the one that already exists.

## Expected Outcome

- `listProposedProposals(workspaceId)` on `ProposalLifecycleService`
  (`src/sac/proposal-lifecycle.ts`): readdir the workspace's `proposals/`
  dir, keep only files whose parsed content has `recordType:
  "proposal-created"` (the dir also holds `.decision.json`/`.approval.json`/
  `.write-result.json`/`.write-intent.json` sidecars per proposal — see
  `proposalPath`/`decisionPath`/etc., `proposal-lifecycle.ts:359-366`),
  subtract ids that have a terminal `proposal-transition` (`toStatus` in
  `accepted | rejected | dismissed | stale`) recorded in that workspace's
  `activity.jsonl` ledger.
- `listVisibleProposedProposals(actor)` on the same service: calls a new
  `WorkspaceService.listForActor({ actorContext, includeArchived: true })`
  (mirroring the existing `showForActor` actor-based pattern,
  `workspace-service.ts:111-122`, since today's `list()` only accepts
  `request`/`requestCorrelationId`, not a pre-resolved actor) — **always**
  `includeArchived: true`, never the plain archived-filtering default, per
  WSL-2/AC1 — then calls `listProposedProposals` for each visible workspace.
- `isLockHeld(lockPath, staleMs?)` in `src/lib/fs.ts`, next to
  `withFileLock`, read-only: `stat(lockPath)`, and if age exceeds the SAME
  stale threshold `withFileLock`'s own `removeStaleLock` uses (extracted to
  a shared exported constant rather than a second hardcoded `30000`), still
  counts as held when the recorded owner pid is alive (mirroring
  `removeStaleLock`'s own aliveness-wins-over-age rule); a missing lock dir
  or any read failure is "not held".
- Two new optional `SessionSummary` fields (`src/session/store.ts`):
  `runMode?: "interactive" | "unattended"`, `courseStatus?: "unbound" |
  "active" | "blocked" | "done"` — backward-compatible, following the exact
  optional-field pattern `readSummaryFile` already uses for every other
  optional field.
- `TerminalState` persistence: a new `writeTerminalState(dir, state)` in
  `slate-terminal-state.ts` (`writeFileAtomic`, mirroring `slate.ts`'s own
  storage primitives), called from `emitTerminalState` in `agent.ts`
  alongside the existing `io.onTerminalState?.(state)` call — same call
  site, no new trigger.
- `keryx workspace catch-up [--workspace <id>]`: four hard-separated
  sections (proposal / blocked / unbound-candidate / unknown per the spec's
  `CatchUpItem` union), never interleaved; each pending proposal's evidence
  freshness re-checked before display (a read-only variant of
  `targetWriteOrStale`'s evidence-hash comparison,
  `proposal-lifecycle.ts:192-209`/`258`) and marked `stale` explicitly, not
  only discovered at accept time; each item rendered as a structured
  question + options + recommendation, never a raw diff/JSON dump; `cwd`-
  scoped only (matches every existing `workspace` subcommand's `service()`
  factory bound to `process.cwd()`, `commands/workspace.ts:17-23`).
- `keryx workspace list-proposals [<workspace-id>]`: standalone command
  exposing the same two helpers, independent of catch-up, usable without
  already knowing a proposal id.

## Out of Scope

- Cross-project aggregation (`--all-projects`) — explicitly deferred by the
  spec (SLATE-10 row, AC-14) to a future, separately-scoped follow-up over
  `src/lib/project-registry.ts`.
- A new `keryx workspace propose --source machine` CLI surface — already out
  of Phase 4's scope and still not this flow's; `resolveMachineWrapUp`/
  `runWrapUp` already exist and are unchanged here except where they need to
  call the new `writeTerminalState` wiring.
- Any change to `workspace review`'s decision path, the SLATE-8 unattended
  checkpoint, or `authorizeSacUse` — catch-up is read-only discovery; the
  human's actual decision still flows through the existing, unmodified
  `workspace review` command (agent-protocol.md's "Catch-up protocol"
  section).
- A push/webhook notification mechanism — pull-based only, per spec
  ("Future CLI and MCP surface").
- SAC RP-03/RP-05/RP-06/RP-08 — slate uses existing smaller primitives, not
  a competing architecture in any of their scopes (unchanged from every
  earlier phase's own Out of Scope section).
