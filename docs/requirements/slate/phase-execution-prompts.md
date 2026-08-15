# Keryx Slate — Phase Execution Prompts
Version: 1.0.0

This file preserves the approved prompts for executing the slate
implementation roadmap. Each phase is a separate managed Flow. Phases 1–5
run in a worktree created from `main`. `sac-workspace-lifecycle`'s Flow (not
listed here — see its own `phase-execution-prompts.md`) may run in parallel
starting immediately; Phase 5 below may not start until it merges.

## 1. Slate skeleton & bundled SAC hardening

Create a worktree from `main`. Run `flow-orchestrator` for
Slate — Phase 1: Skeleton and bundled SAC hardening.

### Scope

- Implement `src/session/slate.ts`: `readSlate`/`writeSlate` under
  `withFileLock`, `slate.json` sibling file in the existing `sessionDir()`,
  archive-on-close to `slate-archive/<attemptId>.json`.
- Wire `detectSecrets`/`detectPii` (`src/security/detect/*`) into
  `src/sac/proposal-lifecycle.ts`'s evidence path before persistence,
  replacing the hardcoded `security.gate: "pass"` literal.
- Fix the misleading "Local CLI/stdin MCP composition ... can never
  self-accept" comment on `createLocalProposalLifecycleService` — it
  describes a composition the real CLI/MCP handlers never use.
- Wrap the flow-read in `createLocalFwkReadService` (`src/sac/fwk-service.ts`)
  in try/catch, yielding deterministic `unbound` on any failure instead of
  an uncaught throw.

### Acceptance criteria

- `slate.json` writes are lock-protected; a second writer in the same turn
  never loses data to a read-modify-write race.
- A re-open in the same session dir archives the prior slate under an
  attempt-specific name before the first new write — never a silent
  overwrite.
- Every SAC proposal's `security.gate` reflects a real scan result, never
  the literal `"pass"` with no scan behind it.
- No comment in `proposal-lifecycle.ts` claims a self-accept protection the
  real code path doesn't provide.
- A flow-read failure (deleted/archived/malformed/permission) in
  `createLocalFwkReadService` always yields `unbound`, never an uncaught
  exception.

### Required reading

`docs/requirements/slate/{specification.md,agent-protocol.md}`, sections for
SLATE-1, SLATE-3 (bundled fix only), SLATE-12, SLATE-14.

## 2. Anchors, Course, Seeds & the unattended checkpoint

Create a worktree from `main`. Run `flow-orchestrator` for
Slate — Phase 2: Anchors, Course, Seeds and the unattended checkpoint.

### Scope

- Anchors: harness-owned, populated from `resolveProjectRoot()` +
  worktree-resolve; always rebuilt on crash/resume/fork, never restored.
- Course: `flowRef`-pointer only; live `FwkWork` projection; no code path
  calls `flow complete`.
- Seeds: append-only; optional `kind` tag; exact-text dedup only (no
  similarity/embedding model in v1).
- Open/close: extend `isActionRequest` (`src/commands/agent.ts`) token set;
  close on flow-done/explicit phrase/`/new`/shell exit.
- **In the same Flow, not a follow-up:** wire the existing `interactive:
  boolean` context field into `authorizeSacUse`/`ProposalLifecycleService.review()`
  (mirroring `checkApproval` rule (h)); deny `accept` whenever `interactive
  === false`; add a boolean `--unattended` flag to `src/commands/harness.ts`
  (not a `--profile <name>` selector — deliberately a separate axis from
  `PolicyProfile`).

### Acceptance criteria

- After any restart/resume/fork, Anchors/fence equal a fresh computation
  from live repo state — never a carried-over value.
- A `keryx sessions fork` opens with a completely empty slate — no
  `slate.json` inherited from the source session.
- A second action-intent open in an unclosed session dir always archives
  the prior slate first (see Phase 1's archive mechanism).
- `workspace review --decision accepted` is denied for any session whose
  `interactive` context field is `false`, including every `keryx serve`
  session unconditionally, regardless of role or `PolicyProfile`.
- A session cannot flip its own `interactive` field from `false` to `true`
  at runtime; only a value fixed at the harness boundary is honored.
- `propose` still succeeds for a denied-`accept` session (deferred-queue
  model, not a full block).

### Required reading

`docs/requirements/slate/{specification.md,agent-protocol.md}`, sections for
SLATE-2, SLATE-3 (feature half), SLATE-4, SLATE-5, SLATE-8.

### Delivery protocol

Create a draft PR, perform full review and remediate findings until
reviewers return without problems. Merge into the feature branch, close the
Flow, then delete the worktree.

## 3. Consult surface & deterministic entry

Create a worktree from `main`. Run `flow-orchestrator` for
Slate — Phase 3: Consult surface and deterministic entry.

### Scope

- Anchors auto-inject: `renderAnchorsBlock`, bounded via the existing
  `assembleContext` (`src/ctx/assembly.ts`), delivered as a harness-injected
  `role:"user", provenance:"project"` history message on harness effects
  (tool call done, worktree resolved, `/model` switch, subagent
  spawn/return) — never baked into the static `orient` block.
- `slate_read`/`slate_write_seed` explicit harness tools, mirrored on
  `workspace-context-tool.ts`'s shape.
- `/goal <text> [--workspace <id>]` shell command; `keryx harness run --goal
  "<text>" --workspace <id> [--unattended]` CLI flags. `--workspace <id>`
  validated via existing `WorkspaceService` role-check; omission never
  auto-creates a workspace.
- Structured `TerminalState` emission (`status`, `reason`,
  `courseSnapshot`, `anchorsSnapshot`, `occurredAt`) on `ask_user`/budget
  exhaustion, replacing `finishWithBudgetSummary`'s free-text history push.

### Acceptance criteria

- `/goal --workspace <id>` rejects an invalid/actor-invisible id explicitly
  (fail closed) rather than opening a slate that only discovers the problem
  at wrap-up.
- `/goal` without `--workspace` never creates a workspace.
- An unattended session hitting `ask_user`/budget exhaustion emits a
  `TerminalState` record and stops cleanly; no `Do NOT call tools.`-style
  instruction persists into any later turn of the same session.
- Anchors visibly update mid-session (e.g. after a tool call) without any
  explicit tool call from the model.
- Course/Seeds content is reachable only through `slate_read`/
  `slate_write_seed`, never silently injected every round.

### Required reading

`docs/requirements/slate/{specification.md,agent-protocol.md}`, sections for
SLATE-2a, SLATE-3a, SLATE-11, SLATE-15.

### Delivery protocol

Create a draft PR, perform full review and remediate findings until
reviewers return without problems. Merge into the feature branch, close the
Flow, then delete the worktree.

## 4. Ephemeral subagent slate & wrap-up composer

Create a worktree from `main`. Run `flow-orchestrator` for
Slate — Phase 4: Ephemeral subagent slate and wrap-up composer.

### Scope

- Full child slate (Anchors+Course+Seeds) scoped to dispatch, assembled in
  `spawn-subagent-tool.ts` (not `harness/child/*`, kept pure). Two
  independent handoff channels on return: work-result unchanged
  (`foldChildSummary`/`quarantineChildSummary`), slate-state as a tagged,
  non-merged `parent.slate.childDispatches[dispatchId]` entry
  (`status: completed | incomplete`), never re-authored by the parent as
  its own Seed.
- `resolveMachineWrapUp` under the currently-throwing `WrapUpSource ===
  "flow"` branch (`src/sac/proposal-lifecycle.ts`, `src/sac/trusted-wrap-up.ts`).
  Model summary via `runModelTurn`; fail-closed on missing credential;
  bounded-timeout mechanical fallback on a slow-but-present credential.
  Evidence written attempt-scoped. Requires `slate.workspaceId` (from Phase
  3's `/goal`/consult) — never guesses one; if unset, preserves evidence as
  a local `unbound-candidate` artifact instead of discarding the work.
  Seeds grouped by `kind`, one `propose` call per non-empty group. Triggers:
  Flow-complete, explicit human command, or one-shot `keryx harness
  run`/`--goal` process termination (never for a `keryx shell` REPL
  session).

### Acceptance criteria

- No slate-owned code path calls `flow complete`, `workspace propose`, or
  `workspace review` on behalf of a subagent.
- A subagent's Seeds/Anchors/Course never appear in the parent's own
  `slate.anchors`/`slate.course`/`slate.seeds` fields — only inside
  `parent.slate.childDispatches[dispatchId]`, a structural invariant, not a
  behavioral one.
- A subagent's slate is unreachable by any code path after the dispatch
  returns, except via its immutable `childDispatches` snapshot.
- Two wrap-up triggers firing close together for the same flow transition
  produce at most one accepted evidence set.
- Zero proposals created via this path ever reference `session-evidence/*.md`
  full-archive dumps.
- Wrap-up never attempts `propose` without a captured `workspaceId`;
  without one, it writes an `unbound-candidate` artifact instead.
- Wrap-up never invents/guesses a `kind` — untagged Seeds go to `follow-up`.
- A one-shot `keryx harness run`/`--goal` invocation with no Flow and no
  human "done" command still reaches wrap-up on process termination; a
  `keryx shell` REPL session never triggers wrap-up this way.

### Required reading

`docs/requirements/slate/{specification.md,agent-protocol.md}`, sections for
SLATE-6, SLATE-7, SLATE-9.

### Delivery protocol

Create a draft PR, perform full review and remediate findings until
reviewers return without problems. Merge into the feature branch, close the
Flow, then delete the worktree.

## 5. Catch-up review & general-purpose listing

**Do not start until `sac-workspace-lifecycle`'s Flow (WSL-1/WSL-2) has
merged into `main`.** Create a worktree from `main` (post-merge). Run
`flow-orchestrator` for Slate — Phase 5: Catch-up review and general-purpose
listing.

### Scope

- `listProposedProposals(workspaceId)` in `proposal-lifecycle.ts` (readdir
  `proposals/`, subtract terminal ids found in `activity.jsonl`) +
  ACL-wrapped `listVisibleProposedProposals(actor)`, built on
  `sac-workspace-lifecycle`'s archived-bypass `list()` variant (WSL-2) —
  never the plain, archived-filtering `list()`.
- New `isLockHeld` read-only helper next to `withFileLock` (`src/lib/fs.ts`).
- Two new optional `SessionSummary` fields: `runMode`, `courseStatus`.
- `keryx workspace catch-up [--workspace <id>]`: four hard-separated
  categories (proposals / blocked / unbound-candidate / unknown), never
  interleaved; re-checks evidence freshness before display, not only at
  accept; per-item structured question+options+recommendation format.
- `keryx workspace list-proposals [<workspace-id>]` standalone command.

### Acceptance criteria

- Pending proposals from archived workspaces surface in catch-up and
  list-proposals exactly as from active workspaces — archival never
  silently removes discoverability.
- Catch-up output is always four hard-separated sections, never an
  interleaved feed.
- A proposal whose evidence has drifted since creation is marked stale
  before display, not only discovered as `stale` after an attempted accept.
- `keryx workspace catch-up`/`list-proposals` v1 operate strictly on the
  invoking `cwd` — no cross-project aggregation, stated as a scope boundary.
- A session still mid-run (live lock, age under the shared `withFileLock`
  stale threshold) never appears in catch-up as `unknown`.

### Required reading

`docs/requirements/slate/{specification.md,agent-protocol.md}`, sections for
SLATE-10, SLATE-13; `docs/requirements/sac-workspace-lifecycle/specification.md`
WSL-2.

### Delivery protocol

Create a draft PR, perform full review and remediate findings until
reviewers return without problems. Merge into the feature branch, close the
Flow, then delete the worktree.
