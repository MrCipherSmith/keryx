# Implementation Plan

Status: formalized

## Approach

Two additive layers, built bottom-up, each mirroring an existing keryx
pattern instead of inventing a new one (see `context.md` for the exact files
read to ground this):

1. **Harness/model layer** — extend `shell-exec-tool.ts` with a background
   path sharing its existing `CommandRunner`/`Bun.spawn`/sandbox/
   incremental-pipe-read machinery, backed by a new session-scoped
   `JobRegistry`. Two new `risk:"read"` tools (`shell_job_output`,
   `shell_job_kill`) expose it to the model. This is the part Claude Code,
   Codex, Gemini CLI all have some version of — closest analog is Claude
   Code's `run_in_background`/`BashOutput`/`KillShell` shape, adapted to
   keryx's existing risk/approval/budget model rather than copied wholesale.

2. **TUI/human layer** — a job-bridge + reactive store + sidebar/inspector
   trio that is a structural clone of the existing Subagent Inspector (flow
   162: `subagent-bridge.ts`/`subagent-session.ts`/`subagent-inspector.ts`).
   This is the layer that resolves the "how does the human/model stay aware
   of a running job without Claude Code's reminder-spam bug" question: the
   human gets a live, always-visible sidebar instead of the model needing
   repeated text nudges.

Considered and rejected during discussion (see `context.md` prior-art notes):
fire-and-forget with no poll/kill tools (Gemini CLI's shape — too little
control); a recurring per-turn injected "job still running" reminder (Claude
Code's shape — its own most-reported bug, #11190/#11716/#13249); a stricter,
separate approval gate for `background:true` (no surveyed tool does this,
and it would fight the existing `trust`/`auto` mode contract for no
demonstrated benefit — revisit only if real misuse shows up later).

## Steps

1. **T2/T3 — Harness layer**
   - `JobRegistry` (new, colocated with `shell-exec-tool.ts` or a sibling
     `background-job-registry.ts` in the same directory): id generation,
     `start`/`get`/`list`/`kill`/`sweepAll` (session-exit hook), bounded
     output ring buffer per job (separate cap from the sync 20KB cap — jobs
     run longer and produce more; needs its own constant), incremental-read
     cursor per `shell_job_output` caller.
   - Process-group ownership: verify Bun's actual primitive for
     detach-into-own-group + group-kill (spike inside T3, not assumed) —
     this is the one piece of the design not yet confirmed against Bun's
     API surface. Fall back plan if Bun has no direct group-kill: track
     every descendant PID the registry observes and kill each individually,
     documented as a known gap vs. true process-group semantics.
   - `shell_exec`: add `background?: boolean` to `inputSchema`; when true,
     `invoke` does not await exit, registers with `JobRegistry`, returns
     `{ job_id, pid }` + first ~500ms of buffered output. The
     `DEFAULT_SHELL_TIMEOUT_MS` deadline path is skipped entirely for this
     branch (background jobs get the registry's own longer absolute ceiling
     + output-size auto-kill instead — mirrors Claude Code's 5GB rail,
     scaled down to keryx's byte budgets).
   - `shell_job_output(job_id)`, `shell_job_kill(job_id)`: new
     `InteractiveTool`s, `risk: "read"`, registered alongside `shell_exec`
     wherever the tool list is assembled for `keryx shell`/TUI.
   - `MAX_CONCURRENT_BACKGROUND_JOBS` (default 3, env override) enforced in
     `shell_exec`'s background branch before spawning.
   - Session-exit hook: wherever `commands/shell.ts`/`tui/tui-shell.ts`
     already tears down on exit, call `JobRegistry.sweepAll()`.

2. **T4/T5 — TUI layer**
   - `src/tui/job-bridge.ts`: `emitBackgroundJob`/`setBackgroundJobListener`,
     event shape mirrors `SubagentFleetEvent` (`upsert` for lifecycle,
     `log` for each stdout/stderr chunk) but adds `command`/`pid`/`exitCode`
     fields subagents don't have.
   - Wire the harness's background runner (from step 1) to call
     `emitBackgroundJob` on start/output-chunk/exit/kill — the SAME chunks
     `shell_job_output` would return on poll, pushed live instead of only
     on demand.
   - `src/tui/background-job-session.ts`: `BackgroundJobStore` (mirrors
     `SubagentSessionStore`'s `apply`/`get`/`list`/`subscribe` shape) —
     WITHOUT a `clear()`-on-new-turn call site anywhere (the deliberate
     divergence from the subagent store, see `description.md`). Add
     `formatJobRow`/`formatJobMeta`/`formatJobOutput` mirroring
     `formatSubagentRow`/`formatSubagentMeta`/`formatSubagentWork`.
   - `src/tui/background-job-inspector.ts`: `paintBackgroundJobSidebar`
     (mirrors `paintSubagentSidebar` exactly — `onMouseDown` per row) +
     `presentJobInspector`/`openJobInspector` (mirrors
     `presentSubagentInspector`/`openSubagentInspector`, tabs
     `Output`/`Meta`, `k: kill` in the footer alongside the existing
     `←/→ tabs` / `esc close`, calling `shell_job_kill` through the tool
     layer — NOT a private TUI-side kill path, so the model and the human
     are killing through the exact same mechanism).
   - `tui-shell.ts`: mount a "Background Jobs N" sidebar section next to
     Directory/Activity/Subagents (same area referenced at line ~490's
     Directory-panel doc comment), wire `onOpen` to `openJobInspector`.

3. **T6 — Review**: `review-orchestrator` with `--backend`/`--vantage-core`-
   equivalent domains for this repo (architecture + logic + testing-practices
   at minimum, given this touches approval/budget-gated tool surface); fix
   findings through `task-implementer` per the standard loop.

4. **T7 — Docs**: a new `wiki/architecture/background-jobs.md` page, same
   shape as `wiki/architecture/permission-modes.md` (Summary/Details/
   Explicitly-out-of-scope/Related) — this is exactly the kind of
   cross-cutting architecture decision that page pattern exists for, and the
   next person's `wiki_ask` query about backgrounding should find it instead
   of re-deriving this flow from source.

## Risks

- **Process-group kill is the one unverified technical assumption.** If
  Bun's `Bun.spawn` has no clean detach-and-group-kill primitive, T3 must
  fall back to descendant-PID tracking (weaker but bounded — see Step 1) and
  this plan's AC3 gets re-scoped accordingly; flag in `journal.md`
  immediately if that happens, do not silently downgrade the guarantee.
- **Output buffering memory growth**: a chatty background job (e.g. a build
  watcher) could accumulate a large ring buffer across a long session. Needs
  an explicit per-job byte cap distinct from the sync path's 20KB (bigger,
  but still bounded) plus the auto-kill-on-oversize rail from Step 1 — do
  not ship an unbounded buffer.
- **OpenTUI layout trap**: `tui-alignself-height-collapse` memory entry is a
  real, previously-hit bug in this exact area (ScrollBox + `alignSelf`) —
  T5 must reuse `subagent-inspector.ts`'s already-working `ScrollBoxRenderable`
  usage verbatim rather than re-deriving the layout.
- **Scope creep risk**: the readline REPL (`commands/shell.ts`) has no
  sidebar — resist the temptation to bolt on an ad hoc text-based job list
  there; it is explicitly out of scope (see `description.md`).
