# Implementation Plan

Status: frozen for execution (revise via journal.md if reality diverges; AC
wording itself only changes via `keryx flow ac update`)

## Approach

Two mostly-independent subsystems share one existing data type
(`SlateChildDispatch` in `src/session/slate.ts`, already shipped in Phase 2)
and converge at wrap-up time (a wrap-up call groups Seeds including any
`childDispatches` entries). Built as two parallel implementation tracks after
one shared test-writing pass, then integrated.

### Track A — SLATE-6 child slate (spawn-subagent-tool.ts)

`spawn-subagent-tool.ts`'s `invoke()` (around line 146-428) already computes
`ctx`/`spawned`/`childDeps` before calling `runAgentTurn`. Add, at that same
call site:

1. **Assemble child Anchors fresh** — call `computeAnchors({ cwd, runtime })`
   (`src/session/slate-lifecycle.ts`) once per dispatch. This is a pure,
   fs/git-reading call with no dependency on the parent's own slate file, so
   it satisfies "assembled fresh at this exact call site, not adapted from an
   existing child-context mechanism" (spec SLATE-6).
2. **Inject it into the child's context** — render via
   `renderAnchorsBlock(anchors)` (`src/session/slate.ts`) and prepend/append
   it into the child's `history` (or fold into `childDeps.systemInstruction`
   — prefer `history` to match the parent-side pattern in `agent.ts`'s own
   fresh-open injection, so child Anchors visibly updates the same way a
   parent's does, not baked statically into the system string). The
   hardcoded child system prompt (`spawn-subagent-tool.ts:257-260`) stays as
   the *task* instruction; Anchors is a separate `history` message, exactly
   mirroring how `runAgentTurnCore`'s own fresh-open trigger does it
   (`agent.ts` ~846-852).
3. **Give the child a real (ephemeral) slate to write Seeds into.** The
   child needs somewhere for `slate_write_seed`-equivalent behavior to land
   during its turn — but per SLATE-6/AC3, that slate must be *unreachable by
   any code path after the dispatch returns except via
   `childDispatches[dispatchId]`*. Concretely: mint a throwaway session-like
   dir under the OS temp dir (NOT under `sessionDir()`/the project's real
   session store — never a real, listable session), open a slate there via
   `openSlate`, register a `slate_write_seed`-equivalent tool bound to *that*
   dir in the child's tool list (mirroring `workspace-context-tool.ts`'s
   shape per SLATE-3a, but scoped to the child's own ephemeral dir, never the
   parent's), let the child's `runAgentTurn` run against it, then on return:
   read the child's slate back, build a `SlateChildDispatch` (`{ anchors,
   course, seeds, status }`), and delete the ephemeral dir entirely (`rm -rf`
   the temp dir tree) — "child's own `slate.json` destroyed immediately after
   handoff" (spec). `status: "incomplete"` on timeout/abort/error (the
   existing `deadlineMs`/`catch` branches), `"completed"` on a normal return.
4. **Fold into the parent, never merge.** After building the
   `SlateChildDispatch`, if a parent `slateSession`/dir is available to this
   tool instance (new `SpawnSubagentToolDeps` field, e.g. `slateSession?:
   SlateSessionRef`, threaded from wherever `createSpawnSubagentTool` is
   constructed — the same shell/TUI call sites that already build
   `slateSession` for `runAgentTurn`), call `writeSlate(parentDir, prev => ({
   ...prev, childDispatches: { ...prev.childDispatches, [dispatchId]:
   childDispatch } }))`. This NEVER touches `prev.seeds`/`.anchors`/`.course`
   — the type system alone doesn't prevent a future edit from doing that, so
   this call site gets an explicit comment plus a dedicated structural test
   (AC2) asserting the write touches only `childDispatches`.
5. Existing work-result channel (`foldChildSummary`/`quarantineChildSummary`,
   the `output` string returned to the parent's tool result) is completely
   unchanged — this is the second, independent channel the spec requires,
   already correct.
6. **AC1 for this track**: `spawn-subagent-tool.ts` must never itself call
   `flow complete`/`workspace propose`/`workspace review` — it doesn't today,
   and this task must not introduce such a call while wiring the child's
   ephemeral tools; a grep-level test asserting the absence of those literal
   call patterns in this file is cheap insurance.

`dispatchId` — reuse an id already computed in `invoke()` (e.g. `attemptId`
or a new `idSeq()` call), just make sure it's stable per dispatch and unique
within the parent's `childDispatches` map (the map key IS the identity, so a
collision would silently overwrite a previous dispatch's snapshot — use
`idSeq()`, already deterministic-injectable per this file's existing
`deps.idSeq` seam).

### Track B — SLATE-7 wrap-up composer

New module, e.g. `src/sac/machine-wrap-up.ts` (mirrors `session-wrap-up.ts`'s
placement/shape), exporting:

- `resolveMachineWrapUp(input: { cwd, workspaceId, slate: Slate, kind:
  ProposalKind }): Promise<TrustedWrapUpResolution>` — the function that
  `createHarnessProposalLifecycleService`'s (or a new sibling factory's)
  `resolveExplicitWrapUp` calls when `request.source === "flow"`, mirroring
  exactly how `resolveSessionWrapUp` is called for `"session"`
  (`proposal-lifecycle.ts:437-439`). Builds:
  - `evidence`: git diff (`git diff` against the branch's merge-base or
    working tree — reuse whatever helper this repo already has for a
    workspace-relative evidence write, e.g. the pattern
    `session-wrap-up.ts`/`proposal-evidence.ts` use to write an evidence file
    under the workspace and return a `{ kind, uri, revision, observedAt }`
    pointer with a real sha256 `revision` — never a `session-evidence/*.md`
    full-archive reference (AC5, spec's "SAC's own evidence dumps" that must
    never appear here), plus the flow snapshot (`readCourse`/Course
    projection) and the deduped/kind-filtered Seed texts for this group
    (including any `childDispatches[*].seeds` tagged appropriately —
    attributed, not laundered as the parent's own).
  - `summary`: from `runModelTurn` (`src/harness/provider/single-turn.ts`) —
    system instruction constrains the model to summarize ONLY the machine
    evidence just built (never invent facts). Fail-closed
    (`credentialAvailable: false` → the whole wrap-up for this group returns
    a typed "no credential" error, no proposal attempted) per AC from spec's
    "Failure protocol". Bounded timeout (`Promise.race` against a timer, same
    pattern `spawn-subagent-tool.ts` already uses for its own child deadline)
    → mechanical template summary (git diff stat + flow status line) on
    timeout with a valid credential, never a hang.
- A composer entry point, e.g. `runWrapUp(input: { cwd, slate: Slate,
  trigger: "flow-complete" | "explicit" | "process-termination" }):
  Promise<WrapUpOutcome>` that:
  1. Dedupes `slate.seeds` via the existing `dedupeSeeds` (`slate.ts`).
  2. Groups by `kind` (untagged → `"follow-up"`, AC7) — **never** invents a
     kind for a group that has zero Seeds; only non-empty groups get a
     `propose` call (spec: "one `propose` call per non-empty kind-group").
  3. If `slate.workspaceId` is unset: skip all `propose` attempts entirely
     and write the machine-collected evidence/summary to a local artifact
     under the session dir's `slate-archive/` (e.g.
     `slate-archive/<attemptId>-unbound-candidate.json`) instead — AC6. This
     is the ONLY outcome when `workspaceId` is unset; never a guessed/default
     workspace id.
  4. If `workspaceId` IS set: for each non-empty kind group, call
     `resolveMachineWrapUp` → `wrapUpAuthority.issue({ source: "flow", ... })`
     → `service.create(...)`, exactly mirroring `workspace.ts`'s existing
     `propose` subcommand wiring (`createHarnessProposalLifecycleService`,
     `wrapUpAuthority.issue`, `service.create`).
  5. **AC4 (dedup/idempotency)**: derive the proposal `id` passed to
     `service.create()` deterministically from
     `hash(workspaceId + ":" + flowRef + ":" + sourceRevision + ":" + kind)`
     rather than `proposal-${randomUUID()}` — `ProposalLifecycleService
     .create()` already rejects a second write to the same proposal path as
     `conflict` (`proposal-lifecycle.ts:108`, inside the same file lock the
     write itself uses), so two near-simultaneous composer runs for the SAME
     flow transition naturally converge: the second writer's lock-wait
     resolves after the first's commit, sees the file already exists, and
     throws `conflict` — "at most one accepted evidence set", not two
     reviewable proposals, with NO new lock/dedup mechanism invented. Verify
     this with a real concurrency test (two `Promise.all`-raced composer runs
     against the same in-memory/temp-dir slate+flow state), not just a
     sequential-call assertion — sequential calls trivially "work" even with
     a buggy random-id approach.
  6. **AC1 for this track**: only `runWrapUp`/`resolveMachineWrapUp` (this
     new module) may call `service.create()`/`wrapUpAuthority.issue` for the
     `"flow"` source — no other new code in this flow reaches those calls
     directly, and no slate-owned path calls `workspace review` at all
     (unchanged — nothing in this flow adds a review call).

### AC8 — one-shot process-termination trigger

`keryx harness run --goal ...`'s current `runOffline` path
(`src/commands/harness.ts` ~369-540) has zero slate wiring (confirmed by
reading it — Phase 3 only parsed/stored `--goal`/`--unattended`/`--workspace`
flags, deferring the "harness run → workspace review pipe" per its own doc
comment). Making that runner fully tool-capable (real `slate_write_seed`
inside `runOffline`'s empty `ToolRegistry`) is out of scope (see
description.md). What AC8 actually requires: the trigger call site exists
ONLY in the one-shot path and NEVER in the REPL path.

Concretely: at the end of `harnessCommand`'s `run` branch (after `structured`
is computed, before the function returns — one call site, unconditional on
whether a slate happens to have content), call the Track B composer
(`runWrapUp({ trigger: "process-termination", ... })`) against whatever slate
exists for that invocation's session dir (open one if `--goal` opened one via
the same `ensureSlateOpened`/`--workspace` validation `goal-command.ts`
already demonstrates — reuse, don't reinvent). A run with no seeds and no
`workspaceId` still reaches the composer, which degrades to the
unbound-candidate/no-op path harmlessly (AC6 already covers "nothing to
propose").

`src/commands/shell.ts`'s REPL loop (`runAgentRepl`) must **never** call this
trigger — it is a long-lived process serving many turns; the flow-done close
trigger (`closeSlateOnFlowDone`, already shipped) is the REPL's own closure
mechanism, unrelated to process-termination wrap-up. Prove this with a
source-level "audit" test on `shell.ts` (grep-style, matching the existing
convention `goal-command.ts`'s doc comment describes for
`shell.test.ts`/`tui-shell.test.ts`) asserting the wrap-up-composer import/
call literally does not appear in `shell.ts`/`tui-shell.ts`.

## Steps

1. tests-creator: write failing tests for AC1-AC8 (see tasks.md T-test) —
   including the AC4 real-concurrency test and the AC2/AC3 "reach through the
   parent after dispatch returns" negative test.
2. task-implementer (Sonnet): Track A — spawn-subagent-tool.ts child slate.
3. task-implementer (Sonnet): Track B — machine-wrap-up.ts + AC8 harness.ts
   wiring (kept together: AC8's trigger literally calls Track B's composer,
   splitting them risks an integration seam neither task owns).
4. code-verifier (scoped: touched files + typecheck + `health run --changed`
   per the speed instruction) + review-orchestrator internal pass; fix loop.
5. One full-suite `bun test` sanity check immediately before PR.
6. PR, `/code-review` high effort, fix findings, CI green, merge, AC confirm,
   flow complete, bookkeeping PR.

## Risks

- **Ephemeral child session dir under OS temp, not the real session store.**
  If instead reused a subdirectory of the parent's own `sessionDir()`, a
  crash mid-dispatch could leave a stray `slate.json` where `listSessions()`
  or SLATE-10's future catch-up might stumble on it as if it were a real
  session. Using a dedicated temp dir with an unambiguous prefix (e.g.
  `keryx-subagent-slate-<dispatchId>`) and best-effort cleanup even on the
  timeout/error branches avoids this; the fold-into-parent step must run
  before the temp dir is removed, and removal must be `try/finally` so a
  read failure mid-fold doesn't leak the temp dir either.
- **AC4's deterministic id approach only converges "same flow transition"
  attempts that also share `sourceRevision`.** If Course's projection can
  give two racing calls a different `sourceRevision` (e.g. the flow snapshot
  changes between the two triggers), they would legitimately diverge — this
  is correct behavior (a genuinely different flow snapshot IS a different
  evidence set) but the test must control for it (fix the flow snapshot,
  race only the two `propose` attempts) to actually exercise the intended
  invariant rather than accidentally proving a weaker property.
- **`runModelTurn`'s timeout fallback.** `runModelTurn` itself has no
  built-in timeout — the bounded-timeout race must be built at the composer
  call site (same `Promise.race`/`setTimeout` pattern
  `spawn-subagent-tool.ts` already uses), and the abandoned promise's
  eventual resolution must be safely ignored (mirror the existing `void
  turn.catch(() => {})` pattern), not left as an unhandled rejection.
- **Speed tradeoff (explicit, per launch brief):** internal iteration skips
  the full-repo double-suite stash/baseline/restore ceremony; only one full
  `bun test` runs, right before PR. If it surfaces unrelated failures, the
  known pre-existing flaky set (`serve-server.test.ts`,
  `project-registry.test.ts`, `sessions.fork.test.ts` — macOS path-symlink
  and port-binding races) is treated as a quick sanity match, not
  re-investigated from scratch.
