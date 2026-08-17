# Slate Phase 2: Anchors, Course, Seeds & the unattended checkpoint

Status: frozen
Source: approved roadmap — `docs/requirements/slate/phase-execution-prompts.md` §2,
`docs/requirements/slate/specification.md` (SLATE-2, SLATE-3 feature half,
SLATE-4, SLATE-5, SLATE-8), `docs/requirements/slate/agent-protocol.md`.

## Problem

Slate Phase 1 (flow 157, merged) shipped only the storage skeleton in
`src/session/slate.ts` (`readSlate`/`writeSlate`/`archiveSlate` under
`withFileLock`) plus three bundled SAC hardening fixes. Nothing in the real
agent loop calls into `slate.ts` yet — no session ever gets a populated
`slate.json`, Anchors are never computed, Course is never projected from a
live Flow, Seeds are never written, and no session ever opens or closes a
slate. Separately, the existing SAC accept path
(`authorizeSacUse`/`ProposalLifecycleService.review()`) has no awareness of
whether a human is actually present to approve — every `keryx serve` session
and every future unattended `keryx harness run` invocation can, today, walk
straight through to `accept` with no interactive human in the loop, because
the `interactive: boolean` context field that already exists elsewhere in the
harness (`checkApproval` rule (h),
`src/harness/mutation/approval.ts`) is never consulted by the SAC review
path.

## Expected Outcome

- **Anchors** (SLATE-2): harness-owned, populated from `resolveProjectRoot()`
  plus worktree-resolve at slate-open/tool-exec time; always a fresh
  computation on restart/resume/fork — never a value restored from a prior
  slate file.
- **Course** (SLATE-3 feature half): `slate.course.flowRef` is a pointer
  only; any code path that reads Course re-derives it live via the existing
  `FwkWork` projection (`src/sac/fwk-service.ts`); no slate-owned code path
  ever calls `flow complete`.
- **Seeds** (SLATE-4): append-only; each Seed may carry an optional `kind`
  tag; dedup before wrap-up uses exact-text match only (trimmed), no
  similarity/embedding model in v1.
- **Open/close** (SLATE-5): `isActionRequest` (`src/commands/agent.ts`) token
  set extended to also open a slate; a slate closes on flow-done, an
  explicit close phrase, `/new`, or shell exit. A second action-intent open
  in an unclosed session dir always archives the prior slate first via
  Phase 1's `archiveSlate`.
- **Unattended checkpoint** (SLATE-8, done in this same Flow, not deferred):
  `authorizeSacUse` / `ProposalLifecycleService.review()` consult the
  existing `interactive: boolean` context field and deny `accept` whenever
  `interactive === false` — mirroring `checkApproval` rule (h) — regardless
  of role or `PolicyProfile`. `propose` is never blocked by this gate
  (deferred-queue model). A new boolean `--unattended` flag on
  `src/commands/harness.ts` forces `interactive: false` for that invocation;
  it is a separate axis from `PolicyProfile`, never a `--profile <name>`
  selector. `keryx serve` sessions already resolve `interactive: false`
  unconditionally (`src/lib/serve-turn.ts`) and need no new flag.
- `keryx sessions fork` opens with a completely empty slate: no `slate.json`
  copied or inherited from the source session.

## Out of Scope

- Anchors auto-inject (`renderAnchorsBlock`, `assembleContext` budget-bound
  injection), `slate_read`/`slate_write_seed` harness tools, `/goal` shell
  command, structured `TerminalState` emission — all Phase 3 (SLATE-2a,
  SLATE-3a, SLATE-11, SLATE-15).
- Full subagent ephemeral slate / `childDispatches`, wrap-up composer
  (`resolveMachineWrapUp`), `workspace propose` integration — Phase 4
  (SLATE-6, SLATE-7, SLATE-9).
- `keryx workspace catch-up`, `list-proposals`, `isLockHeld`,
  `runMode`/`courseStatus` `SessionSummary` fields — Phase 5 (SLATE-10,
  SLATE-13), which is additionally blocked on `sac-workspace-lifecycle`
  WSL-1/WSL-2 merging to `main` (already merged per this worktree's base
  commit, but Phase 5's own scope is still not this Flow's work).
- Any change to `security.gate` computation beyond what Phase 1 already
  shipped (SLATE-12 is done).
