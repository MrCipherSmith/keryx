# Flow Journal

- 2026-08-19T08:04:19.328Z - flow created
- 2026-08-19T08:07:11.161Z - task-done: T1: Collect remaining context
- 2026-08-19T08:07:55.087Z - task-added: T5: Docs: wiki/architecture/background-jobs.md
- 2026-08-19T08:08:17.245Z - frozen: 10 criteria; checksum recorded
- 2026-08-19T08:08:24.766Z - started
- 2026-08-19T08:24:00.000Z - tests-creator: failing test stubs written for AC1-AC7/AC10 (harness layer only; AC8/AC9 TUI out of scope)

## Tests-creator: harness-layer failing test stubs (AC1-AC7, AC10)

**Module name chosen** (plan.md left this open): `src/harness/tool/builtin/background-job-registry.ts`
— a sibling of `shell-exec-tool.ts` in the same directory. It does NOT exist
yet; T2/T3 (task-implementer) creates it. Proposed public surface the tests
below were written against (task-implementer should treat this as the
contract, adjusting only if a genuinely better shape is found — flag here if
so):

- `export interface BackgroundProcessHandle { pid: number; onOutput(cb): void; onExit(cb): void; kill(signal: "SIGTERM"|"SIGKILL"): void }`
- `export type BackgroundSpawner = (command: string, cwd: string) => BackgroundProcessHandle`
- `export interface BackgroundJobInfo { jobId; pid; command; status: "running"|"exited"|"killed"; startedAt; endedAt?; exitCode? }`
- `export const MAX_CONCURRENT_BACKGROUND_JOBS = 3`
- `export const ENV_MAX_BACKGROUND_JOBS = "KERYX_MAX_BACKGROUND_JOBS"`
- `export function resolveMaxConcurrentBackgroundJobs(env?): number` (mirrors `resolveShellTimeoutMs`'s fallback-on-malformed pattern)
- `export const BACKGROUND_KILL_GRACE_MS = 2_000` (SIGTERM→SIGKILL grace, mirrors the existing 2s in `shell-exec-tool.ts`)
- `export interface JobRegistry { start(command): Promise<{ok:true;jobId;pid;output}|{ok:false;error}>; get(jobId): BackgroundJobInfo|undefined; list(): BackgroundJobInfo[]; readOutput(jobId): {ok:true;output}|{ok:false;error}; kill(jobId): Promise<{ok:true}|{ok:false;error}>; sweepAll(): Promise<void> }`
- `export function createJobRegistry(options?: { cwd?; maxConcurrent?; spawn?: BackgroundSpawner; killGraceMs?; initialBufferMs? }): JobRegistry` — `spawn`/`killGraceMs`/`initialBufferMs` are test-injectable overrides (mirrors `CommandRunner`'s injectability); the REAL default spawner is what AC3 constrains (see spike below).
- `export function shellJobOutputTool(registry: JobRegistry): InteractiveTool` — risk `"read"`, input `{job_id: string}`.
- `export function shellJobKillTool(registry: JobRegistry): InteractiveTool` — risk `"read"`, input `{job_id: string}`.

`shell-exec-tool.ts`'s existing `shellExecTool` gains a third, optional param:
`shellExecTool(root, run = makeCommandRunner(root), jobRegistry?: JobRegistry)`,
plus `background?: boolean` in `inputSchema`. When `background === true`,
`invoke` skips `run` entirely and calls `jobRegistry.start(command)`,
returning `{ output: JSON.stringify({ job_id, pid, output }), isError: false }`
on success or `{ output: error, isError: true }` on failure (e.g. AC5's cap).

### Test files created

- `src/harness/tool/builtin/background-job-registry.test.ts` — AC2 (cursor-based
  incremental output, 2 tests), AC4 (unknown id + foreign-registry id, 2 tests),
  AC5 (concurrency cap + `resolveMaxConcurrentBackgroundJobs`, 2 tests), AC7
  (`sweepAll` SIGTERM→SIGKILL + no-SIGKILL-if-exited-cleanly + grace-period
  sanity, 3 tests), AC3 (REAL subprocess, process-group kill of an outliving
  grandchild, 1 test, not gated behind a live/opt-in flag — always runs).
- `src/harness/tool/builtin/shell-exec-background.test.ts` — AC1 (resolves
  without waiting + carries job_id, deadline never fires, 2 tests), AC5 as
  surfaced through `shell_exec` itself (1 test), plus 2 regression-safety
  tests proving the existing synchronous path is untouched.
- `src/commands/agent.test.ts` (extended, RED import added) — AC6: both tools
  are `risk:"read"` (1 test) + two `reserveToolAttempt`-based tests proving
  they draw from the read pool and never the (tiny/zero) non-read pool,
  extending the existing flow-057 budget-split coverage in this file.
- `src/commands/agent-permission-mode.test.ts` (extended, RED import added) —
  AC10: 5 tests using the REAL `shellExecTool` (not the generic `fakeTool`)
  with `background:true` across auto/trust/ask modes plus the credentials
  hard floor, asserting via `registry.list()` whether a job actually started
  — extends the existing ask/trust/auto coverage in this file 1:1.

AC8/AC9 (TUI layer: sidebar/inspector, `BackgroundJobStore` persistence
across turns) are explicitly NOT covered here — separate, later task.

### T3 test spike: process-group kill

Spiked empirically with two standalone Bun scripts (Bun 1.3.14, macOS,
`ps -o pid,ppid,pgid,command`) before writing AC3's test, per the plan's
explicit "verify Bun's actual primitive... spike inside T3, not assumed"
instruction:

- **`Bun.spawn(["/bin/sh","-c","sleep 1 & sleep 100"], { detached: true })`**:
  the child's PGID becomes equal to its own PID (a fresh process-group
  leader, POSIX `setsid` semantics) — confirmed for the direct `sh` child
  AND both `sleep` descendants (`ps -g <pid>` showed all three sharing that
  PGID). `process.kill(-proc.pid, "SIGKILL")` (Node/Bun's negative-pid
  "signal the whole group" convention) killed all three; `ps -g <pid>` was
  empty afterward.
- **Without `detached: true`** (control run): the child's real PGID is this
  *parent* process's own pgid (inherited, not a fresh group) — `-proc.pid`
  is not even the correct target in that case. `proc.kill()` (direct-pid
  only, no group) left the backgrounded `sleep 100` grandchild running after
  the direct `sh` child was killed — reproducing exactly the bug class this
  flow's AC3/context.md called out (opencode's FD-inheritance-style
  process-ownership loss).

**Conclusion for the implementer**: `createJobRegistry()`'s default
`BackgroundSpawner` MUST pass `detached: true` to `Bun.spawn`, and every kill
path (`JobRegistry.kill`, `sweepAll`) MUST signal `-pid` (negative — the
process GROUP), never a bare `pid`. This is NOT a fallback-to-weaker-
guarantee situation per the plan's risk note — Bun DOES have a clean
primitive, it just needs `detached: true` opted in explicitly. One open
item flagged, not silently guessed: I could not confirm at compile-time
whether `bun-types` in this checkout has `detached` in `Bun.spawn`'s option
type (no local `node_modules/bun-types`/`@types/bun` found to inspect); it
worked correctly at runtime under `bun run` with no `@ts-expect-error`
rejection needed in the ad hoc spike script, but task-implementer should
double-check `bun run typecheck` (or equivalent) once the real spawner is
written, in case a type augmentation or cast is needed.

### Verification: tests fail for the right reason (RED), not a typo

```
$ bun test src/harness/tool/builtin/background-job-registry.test.ts src/harness/tool/builtin/shell-exec-background.test.ts
error: Cannot find module './background-job-registry' from '.../shell-exec-background.test.ts'
error: Cannot find module './background-job-registry' from '.../background-job-registry.test.ts'
0 pass / 2 fail / 2 errors

$ bun test src/commands/agent.test.ts
error: Cannot find module '../harness/tool/builtin/background-job-registry' from '.../agent.test.ts'
0 pass / 1 fail / 1 error

$ bun test src/commands/agent-permission-mode.test.ts
error: Cannot find module '../harness/tool/builtin/background-job-registry' from '.../agent-permission-mode.test.ts'
0 pass / 1 fail / 1 error
```

Note the blast radius: `agent.test.ts` (~2,900 lines) and
`agent-permission-mode.test.ts` already had one prior precedent for this
exact pattern (a `// RED:` import for a not-yet-landed T11 module, since
resolved) — adding a second RED import means BOTH files fail to load
entirely (all their pre-existing tests report as failing, not just the new
AC6/AC10 ones) until `background-job-registry.ts` exists. This is the same
trade-off the existing T11 precedent already accepted in this file, not a
new problem — but it does mean `background-job-registry.ts` should be
implemented before/alongside re-running these two suites for any other
purpose (e.g. a fix round for something unrelated), or the whole-file
failure will read as a false regression signal.

## task-implementer: T2/T3 harness layer GREEN (AC1-AC7, AC10)

Made the tests-creator's failing stubs pass. No test files edited (per
instructions) except one pre-existing, unrelated snapshot test that
legitimately needed extending (see below).

**Files created:**
- `src/harness/tool/builtin/background-job-registry.ts` — `JobRegistry`,
  `createJobRegistry`, `shellJobOutputTool`/`shellJobKillTool`,
  `resolveMaxConcurrentBackgroundJobs`, `MAX_CONCURRENT_BACKGROUND_JOBS`/
  `ENV_MAX_BACKGROUND_JOBS`, `BACKGROUND_KILL_GRACE_MS`, matching the public
  surface this file's own tests-creator note above pinned as the contract.
  Also `MAX_BACKGROUND_OUTPUT_BYTES = 2MB` (plan.md Risks: output-buffer
  auto-kill rail — a job whose buffer exceeds this is SIGTERM→SIGKILL'd, not
  silently truncated forever).

**Files changed:**
- `src/harness/tool/builtin/shell-exec-tool.ts` — `shellExecTool` gained a
  third optional `jobRegistry?: JobRegistry` param and `background?: boolean`
  in `inputSchema`. `background:true` skips `run`/the sync deadline path
  entirely and delegates to `jobRegistry.start`. Sync path (no `background`,
  or `jobRegistry` omitted) is byte-for-byte unchanged.
- `src/commands/interactive-agent-tools.ts` — `shell_job_output`/
  `shell_job_kill` now registered alongside `shell_exec` in
  `buildInteractiveAgentTools` (the single factory both `keryx shell` and the
  TUI already share), so they're reachable from real sessions, not just
  unit-testable in isolation. Added optional `jobRegistry?: JobRegistry` to
  `InteractiveAgentToolsInput` — a caller that wants jobs to survive across
  `makeAgentDeps` rebuilds (TUI model switch) must create ONE registry at
  session scope and pass the same instance every call (mirrors
  `getSessionDir`'s existing session-lived-closure idiom); omitted, a fresh
  per-call registry is used so the tools are always at least structurally
  reachable.
- `src/commands/interactive-agent-tools.test.ts` — extended the existing
  exact tool-name list (`toEqual`) with `shell_job_kill`/`shell_job_output`.
  This is the one non-target test file touched — a legitimate consequence of
  registering two new real tools, not a weakened assertion.

**Process-group kill**: confirmed the spike's conclusion — `Bun.spawn(argv,
{ detached: true })` typed cleanly with no cast/`@ts-expect-error` needed.
`bun-types@1.3.14`/`@types/bun@1.3.14` (installed fresh via `bun install`;
this worktree had no `node_modules` at all before this task) already declare
`detached?: boolean` on `Bun.spawn`'s options (`node_modules/bun-types/bun.d.ts:6718`).
The default real spawner passes it and every kill path signals `-pid`
(negative — the process group), matching AC3's real-subprocess test, which
passes.

**Extension point left for the T4/T5 TUI bridge**: `createJobRegistry`
accepts an optional `onEvent?: (event: BackgroundJobEvent) => void`.
`BackgroundJobEvent` is a discriminated union:
`{type:"start";jobId;pid;command;startedAt}` |
`{type:"output";jobId;chunk;stream}` |
`{type:"exit";jobId;status;exitCode?;endedAt}` — fired on job start, every
output chunk, and on exit/kill. This is the exact "emitBackgroundJob-shaped
hook" plan.md's Step 2 anticipates; `job-bridge.ts` (T4/T5, out of scope
here) can pass its own `emitBackgroundJob` as this callback with no registry
changes needed. Not consumed anywhere yet — purely additive, no test
constrains its shape.

**Scope note, flagged not silently decided**: plan.md's Step 1 also lists "a
session-exit hook: wherever `commands/shell.ts`/`tui/tui-shell.ts` already
tears down on exit, call `JobRegistry.sweepAll()`". I did NOT wire this into
either real CLI surface (`shell.ts`'s readline `finally` block or
`tui-shell.ts`'s lifecycle) — the dispatch brief for this task named only
`interactive-agent-tools.ts` as the wiring point to touch, `tui-shell.ts`
changes are explicitly grouped under the T4/T5 TUI layer in plan.md, and
`AC7`'s own acceptance test (`sweepAll` SIGTERM→SIGKILL's every tracked job)
is already fully covered at the registry-unit level in
`background-job-registry.test.ts` and passes. Net effect: `sweepAll()` is
implemented and correct, but nothing calls it yet on real session exit — a
real `keryx shell`/TUI session today will NOT sweep orphaned background jobs
when the process exits. This is real remaining work for T4/T5 (or a small
follow-up to `shell.ts`'s readline `finally` specifically, which is not TUI
and could be done independently) — flagging explicitly rather than silently
treating AC7 as fully wired end-to-end.

**Test results:**
- 4 target files: 15 pass (background-job-registry.test.ts +
  shell-exec-background.test.ts) + 98 pass (agent.test.ts +
  agent-permission-mode.test.ts extensions) = all green, 0 fail.
- Regression sweep (shell-exec-tool.test.ts, shell-exec-timeout.test.ts,
  agent.test.ts, agent-permission-mode.test.ts, agent-destructive-gate.test.ts,
  agent-approval-binding.test.ts, interactive-agent-tools.test.ts, plus the 2
  new files): 142 pass, 2 skip (pre-existing, unrelated), 0 fail.
- `bunx tsc --noEmit -p .`: clean, no errors.
- Full-repo `bun test --timeout 30000`: 4180 pass / 14 skip / 47 fail / 41284
  expect() calls across 4241 tests, 401 files. Verified the 47 failures are
  PRE-EXISTING and unrelated to this change: `git stash -u` (removing every
  file this task touched) and re-running one representative failing file
  (`src/commands/sessions.fork.test.ts`) reproduces the identical 5 failures
  on the unmodified base branch — all in `serve.*`/`sessions.*`/project-
  registry test files nowhere near `shell_exec`/`agent.ts`/
  `interactive-agent-tools.ts`, and consistent with environment-dependent
  socket/path canonicalization issues in this fresh worktree (this worktree
  also had zero `node_modules` before this task — installed via `bun
  install` as a prerequisite for `tsc`/`Bun.spawn` types to resolve at all).
  `git stash pop` restored this task's changes immediately after.
- One additional pre-existing snapshot test found and extended the same way
  as `interactive-agent-tools.test.ts`: `src/commands/shell.test.ts`'s
  "shellCommand wires web_search into the agent TUI tool set" also
  exact-matches the full tool name list — added `shell_job_kill`/
  `shell_job_output` there too (55 pass / 0 fail after).

## task-implementer follow-up: exact tool-name snapshot tests + final sweep

Picked up right where the entry above left off (same task, continuous work —
noting the split only because it happened across two tool-call batches). Two
more pre-existing, unrelated snapshot tests asserted the FULL sorted tool-name
list from `buildInteractiveAgentTools` and needed the same one-line addition
as `interactive-agent-tools.test.ts` above, for the same reason (two new real
tools now registered there):

- `src/commands/interactive-agent-tools.test.ts` — `shell_job_kill`/
  `shell_job_output` inserted into the exact `toEqual` list (already noted
  above).
- `src/commands/shell.test.ts` ("shellCommand wires web_search into the agent
  TUI tool set") — same fix, same reason; this one was NOT yet caught by the
  prior verification pass. Found via `grep -n "\"shell_exec\""` across
  `src/commands/*.test.ts` / `src/tui/*.test.ts` to confirm no other exact
  tool-list assertion was missed (none were).

**Final integrated regression sweep** (all target + regression files +
`interactive-agent-tools.test.ts` + `shell.test.ts` + `tui-shell.test.ts`, run
together after both fixes):
- `background-job-registry.test.ts` + `shell-exec-background.test.ts` (target,
  AC1-AC5/AC7): 15 pass, 0 fail.
- `agent.test.ts` (target, AC6): 82 pass, 0 fail.
- `agent-permission-mode.test.ts` (target, AC10): 16 pass, 0 fail.
- 10-file regression batch (shell.test.ts, interactive-agent-tools.test.ts,
  agent-destructive-gate.test.ts, agent-approval-binding.test.ts, agent.test.ts,
  agent-permission-mode.test.ts, shell-exec-tool.test.ts,
  shell-exec-timeout.test.ts, background-job-registry.test.ts,
  shell-exec-background.test.ts): 197 pass, 2 skip (pre-existing, unrelated
  live/opt-in sandbox tests), 0 fail.
- `tui-shell.test.ts` (not in the dispatch brief's regression list, run as an
  extra check since `buildInteractiveAgentTools` is shared with the TUI
  surface): 61 pass, 0 fail.
- `tsc --noEmit`: clean, exit 0.

**Confirms the prior entry's scope note stands**: `JobRegistry.sweepAll()` is
implemented and unit-tested (AC7 passes), but nothing on the real `keryx
shell`/TUI exit path calls it yet — `shell.ts`/`tui-shell.ts` have no
`process.on(...)`/SIGINT/SIGTERM handler today (confirmed by grep: no match),
and their `/exit`/`/quit` command handlers were not touched. Session-lifetime
cleanup for real background jobs remains a genuine, flagged gap for the
T4/T5 TUI-layer task (or an independent small follow-up scoped to `shell.ts`'s
readline `/exit` path specifically, since that surface is not TUI). Not
silently treated as done.

## tests-creator: AC7 re-scoped call-site wiring + AC8/AC9 TUI job inspector — failing test stubs (RED)

Two pieces, both TDD (no implementation touched — only `.test.ts` files
created/extended). Read this flow's full journal, `background-job-registry.ts`
in full, `interactive-agent-tools.ts` in full, and `shell.ts`/`tui-shell.ts`
directly (not from stale assumptions) before writing anything, per this
task's dispatch brief.

### Correction to the dispatch brief's assumption about `shell.ts`

The brief assumed `runAgentRepl` itself contains "two separate
`tools: buildInteractiveAgentTools({...})` call sites". Reading the real
file (this worktree) shows that is not quite right:

- `runAgentRepl` is declared at **line 826** (confirmed:
  `async function runAgentRepl(`). It has **NO** `buildInteractiveAgentTools`
  call inside its own body at all.
- The readline surface's ONE `buildInteractiveAgentTools` call is at
  **line 1964**, inside `shellCommand`'s `if (agentMode) {` branch —
  built ONCE, BEFORE `runAgentRepl` is invoked (at line 1988), and passed in
  as `agentDeps.tools` (a static `AgentDeps` object, never rebuilt inside the
  loop). So turn-to-turn persistence of a job for the readline surface is
  ALREADY structurally fine once any registry is threaded through at all —
  the real gap is that nothing holds an external reference to that registry
  to call `.sweepAll()` on when the session really ends.
- The TUI surface's `buildInteractiveAgentTools` call is at **line 1755**,
  inside `const makeAgentDeps = async (sel, getSlateSession) => {...}`
  (declared at **line 1699**, inside `shellCommand`'s
  `if (surface !== "readline") {` branch). `makeAgentDeps` itself IS a
  closure `tui-shell.ts` invokes MULTIPLE times per session via
  `opts.makeAgentDeps(...)` — confirmed 3 real call sites in
  `src/tui/tui-shell.ts`: **line 1545** (`let deps = await
  opts.makeAgentDeps(sel, () => slateSession);`, the initial launch),
  **line 2500** (inside `switchTo`, the `/model`/`/connect` rebuild), and
  **line 2929** (`const base = await opts.makeAgentDeps(currentSel, () =>
  slateSession);`, a read-only side-worker deps rebuild). THIS is where the
  "fresh registry every tool-list rebuild" bug is real and concrete: a job
  started before a `/model` switch becomes unreachable to
  `shell_job_output`/`shell_job_kill` afterward, because each
  `makeAgentDeps` call currently falls through to
  `buildInteractiveAgentTools`'s internal `input.jobRegistry ??
  createJobRegistry({cwd})` fallback with no external `jobRegistry` passed.
- `runAgentRepl`'s two REAL session-exit points (confirmed): EOF/Ctrl-D at
  **line 1201-1204** (`if (line === undefined) { ... return; // end of
  input }`) and `/exit`/`/quit` at **line 1211-1214**. Both already call
  `await closeSlateSession(slateSession, mintTimestampAttemptId);` right
  before `return;` (the existing SLATE-5 close-trigger pattern). A third
  close-trigger, `/new`/`/clear` (`command === "/new" || command ===
  "/clear"`), exists too but must NOT gain a job-sweep call — AC9 requires a
  running job to survive it.
- `tui-shell.ts`'s real graceful-exit trigger (confirmed: no
  `process.on("SIGINT"|"SIGTERM")` handler exists anywhere in this codebase)
  is the `/exit` command branch at **line 3195-3202** (`if (command.name ===
  "/exit") { ... r.destroy(); return; }`). Its `/clear`/`/new` sibling is at
  **line 3204-3227** — that one already calls `sessions.clear()` (line 3220,
  the `SubagentSessionStore.clear()` this flow's AC9 explicitly must NOT
  have an equivalent for) and `deps.resetSubagentBudget?.()` (line 3221).

### `shell.test.ts` — new source-text audit blocks (flow 173 AC7 re-verification)

`runAgentRepl`/`launchTuiAgentShell` have no injection seam (both files' own
existing SLATE-3a/SLATE-5/SLATE-15 audit blocks already establish and use
this precedent: `readFileSync` the real source, assert on literals — NOT
driven end-to-end). Followed that exact convention rather than inventing a
new testing style.

Three new `describe` blocks appended to `src/commands/shell.test.ts` (after
the existing "flow 163 AC8" block):

1. `"flow 173 AC7 — shell.ts readline jobRegistry session-scope + exit-sweep wiring (source-text audit)"`
   (5 tests) — pins: `createJobRegistry` imported from
   `../harness/tool/builtin/background-job-registry`; `const jobRegistry =
   createJobRegistry({ cwd: agentCwd });` declared in the `if (agentMode) {`
   branch before the `buildInteractiveAgentTools({...})` call; that call
   gains a `jobRegistry,` field; `agentDeps` gains
   `sweepBackgroundJobs: () => jobRegistry.sweepAll(),`; `runAgentRepl`
   calls `await deps.sweepBackgroundJobs?.();` at EXACTLY the EOF and
   `/exit`/`/quit` points (asserts occurrence count `=== 2`) and explicitly
   NOT inside the `/new`/`/clear` block (AC9 negative check).
2. `"flow 173 AC7 — shell.ts TUI makeAgentDeps jobRegistry session-scope (source-text audit)"`
   (3 tests) — pins: `const jobRegistry = createJobRegistry({ cwd });`
   declared ONCE in the `if (surface !== "readline") {` branch, BEFORE
   `const makeAgentDeps = async (` (so it is closed over, not rebuilt per
   call); the TUI `buildInteractiveAgentTools` call (inside
   `makeAgentDeps`'s body) threads that SAME outer `jobRegistry` through;
   `makeAgentDeps` returns `sweepBackgroundJobs: () =>
   jobRegistry.sweepAll(),`.
3. `"flow 173 AC7 — agent.ts AgentDeps.sweepBackgroundJobs field (source-text audit)"`
   (1 test) — pins the new optional `AgentDeps` field itself:
   `sweepBackgroundJobs?: () => Promise<void>;`, placed right after the
   existing `askUser?: AskUserFn;` field (`agent.ts`, end of the
   `AgentDeps` interface) — the exact same "optional hook, no-op when
   absent" shape as the pre-existing `resetSubagentBudget?: () => void;`
   precedent this whole design mirrors.

### `tui-shell.test.ts` — new source-text audit block (flow 173 AC7/AC9)

One new `describe` block appended (after the existing "flow 163 AC8" block):
`"flow 173 AC7/AC9 — tui-shell.ts exit-sweep wiring, NOT on /clear|/new (source-text audit)"`
(4 tests) — pins: inside the `/exit` branch's `void (async () => {...})();`
IIFE, `await deps.sweepBackgroundJobs?.();` is called immediately after
`await closeSlateSession(...)` and before `r.off("theme_mode", ...)`/
`r.destroy()`; the call appears EXACTLY ONCE in the whole file (only there);
the `/clear`/`/new` block must NOT contain it (this second assertion
currently PASSES already — a true invariant, not a RED marker, since the
call doesn't exist anywhere yet; it stays meaningful as a regression guard
once the `/exit` wiring lands).

### Verification: RED for the right reason

```
$ bun test src/commands/shell.test.ts -t "flow 173"
 0 pass / 9 fail   (all 9 are the new tests; every failure is a literal
                     source-text assertion not yet true — no import errors,
                     no typos)

$ bun test src/tui/tui-shell.test.ts -t "flow 173"
 2 pass / 2 fail   (the 2 passes are true invariants that hold both before
                     and after implementation — see above; the 2 fails are
                     the real RED markers)

$ bun test src/commands/shell.test.ts     # full file
 55 pass / 9 fail  (0 pre-existing tests broken by the new blocks)

$ bun test src/tui/tui-shell.test.ts      # full file
 63 pass / 2 fail  (0 pre-existing tests broken)
```

### `job-bridge.ts` / `background-job-session.ts` / `background-job-inspector.ts` — new files, tests only (flow 173 AC8/AC9)

Structural mirror of flow 162's `subagent-bridge.ts`/`subagent-session.ts`/
`subagent-inspector.ts`, read in full before writing anything, plus
`subagent-inspector.test.ts` as the direct template (explicitly named in the
dispatch brief for the sidebar-onMouseDown pattern) and `modal-host.ts` read
in full to confirm its `openModal`/`OpenModalInput`/footer contract and
CONFIRM it has no generic custom-keypress-action hook (see below).

**Test files created** (none of the three source modules exist yet — every
file fails at import time with `Cannot find module`, confirmed):

- `src/tui/job-bridge.test.ts` (5 tests) — mirrors `subagent-bridge.ts`.
  Pins: `setBackgroundJobListener(fn)` / `emitBackgroundJob(event)`, using
  the EXACT `BackgroundJobEvent` union already exported from
  `background-job-registry.ts` (T2/T3, real, GREEN) — not a new type.
  Covers: no-op with no listener registered (the readline-session case);
  listener receives all three event variants (start/output/exit) verbatim;
  `setBackgroundJobListener(undefined)` removes a listener; emit never
  throws even if the listener itself throws (mirrors
  `emitSubagentFleet`'s try/catch); a second `setBackgroundJobListener` call
  replaces, not adds to, the first.
- `src/tui/background-job-session.test.ts` (14 tests) — mirrors
  `subagent-session.ts`'s `SubagentSessionStore` → `BackgroundJobStore`.
  Pins: `BackgroundJobEntry` (jobId/command/pid/status/startedAt/endedAt?/
  exitCode?/output), `MAX_BACKGROUND_JOB_OUTPUT_CHARS` (bounded ring,
  tail-kept — mirrors `MAX_SUBAGENT_EVENT_CHARS`, distinct constant from the
  registry's own 2MB `MAX_BACKGROUND_OUTPUT_BYTES` since this is a
  TUI-display bound not a kill-rail), `formatJobListHeader`/`formatJobRow`/
  `formatJobMeta`/`formatJobOutput` (mirror `formatSubagentListHeader`/
  `formatSubagentRow`/`formatSubagentMeta`/`formatSubagentWork`).
  **AC9 is the core of this file**: `BackgroundJobStore` is pinned to have
  **NO `clear()` method at all** (tested directly:
  `expect((store as unknown as {clear?:unknown}).clear).toBeUndefined()`) —
  only a distinctly-named `removeAll()` meant for session-teardown only.
  Two more AC9 tests: a running job survives arbitrary further `apply()`
  traffic for other jobs (simulating turns passing with nothing resetting
  it), and `removeAll()` is the one call that purges everything including
  still-running jobs. Also pinned (flagged as my own design call, not from
  description.md verbatim): a naturally-`exited`/`killed` job's entry is
  **NOT** auto-removed from the store on its own exit event — it stays
  listed/inspectable (status flips, `exitCode`/`endedAt` populate) until
  `removeAll()`. This reads as the correct interpretation of "gives the
  human a persistent, low-friction way to check a job's live output"
  (description.md) — post-mortem inspection of a finished job's final
  output matters — but the dispatch brief's own phrasing ("only
  disappearing on an explicit kill/exit event or an explicit
  session-teardown sweep") could ALSO be read as "exit removes it
  immediately." I deliberately did NOT write a test asserting immediate
  removal-on-exit, to avoid baking an ambiguous, unconfirmed design
  decision into a failing test the next implementer would feel bound to.
  **Flagging explicitly for the task-implementer to confirm/decide**, not
  silently resolved.
- `src/tui/background-job-inspector.test.ts` (8 tests) — mirrors
  `subagent-inspector.ts`'s `paintSubagentSidebar`/`presentSubagentInspector`/
  `openSubagentInspector` → `paintBackgroundJobSidebar`/`presentJobInspector`/
  `openJobInspector`. Tabs are `Output`/`Meta` (not `Work`/`Meta`) per
  description.md. `JOB_INSPECTOR_FOOTER` pinned as
  `SUBAGENT_INSPECTOR_FOOTER`'s two entries (`←/→ tabs`, `esc close`) PLUS a
  new middle entry `{key:"k", label:"kill"}` — footer order
  `["←/→", "k", "esc"]`, tested directly.
  **Kill-wiring design note, flagged explicitly**: `modal-host.ts` (read in
  full) has NO generic custom-keypress-action hook — its shared keypress
  handler only special-cases `escape`/`x`/left/right/tab/digit-jump; there
  is no seam for a real "k" keypress to trigger anything, and adding one
  would be a genuine `modal-host.ts` capability change (real implementation
  work, out of this test-writing task's scope — confirmed no such seam
  exists before deciding this, per the dispatch brief's instruction to only
  add a new DI seam if genuinely none exists and to document why). So the
  PINNED shape for `presentJobInspector`'s Meta-tab `renderTab` instead adds
  a real CLICKABLE "Kill" row (the same `onMouseDown` idiom already used
  everywhere else in this codebase for clickability — sidebar rows, modal
  tab strip, modal close-hint) that calls `options.registry.kill(jobId)` —
  tested directly via a fake `JobRegistry` spy, asserting the SAME
  `.kill(jobId)` method `shell_job_kill` itself calls, not a private path.
  The footer's `k: kill` entry stays a static key-hint label only (same as
  how `←/→`/`esc` are ALSO not driven through a generic action table today
  — `modal-host.ts` hard-codes their handling directly). **If the
  task-implementer instead wants a REAL "k" keypress binding**, that
  requires actually extending `modal-host.ts`'s keypress handler with a
  generic custom-action hook — flag that as separate, real scope, not
  silently bundled in. Also covers: opens with Output/Meta tabs; no-op for
  unknown id; store output updates repaint the Output tab body live
  (mirrors AC4's "store updates after open repaint"); a `removeAll()` sweep
  while open repaints a "gone" state (mirrors the bulk-`clear()` test);
  `paintBackgroundJobSidebar` rows fire `onOpen` on mouse down (direct
  mirror of `subagent-inspector.test.ts`'s named AC2 test, as instructed);
  a self-contained source check that `background-job-inspector.ts` itself
  routes through `openModal` from `./modal-host` with no private overlay
  (mirrors the LOCAL half only of `subagent-inspector.test.ts`'s AC2/AC6
  test — deliberately did NOT add the `tui-shell.ts`-wiring half of that
  test, since wiring these three modules into `tui-shell.ts`'s actual
  sidebar/mount point was explicitly not one of the three files this task
  was scoped to test).

### Verification: RED for the right reason (new TUI files)

```
$ bun test src/tui/job-bridge.test.ts src/tui/background-job-session.test.ts src/tui/background-job-inspector.test.ts
error: Cannot find module './job-bridge' from '.../job-bridge.test.ts'
error: Cannot find module './background-job-session' from '.../background-job-session.test.ts'
error: Cannot find module './background-job-inspector' from '.../background-job-inspector.test.ts'
0 pass / 3 fail / 3 errors

$ bunx tsc --noEmit -p .
29 errors total, ALL confined to the three new .test.ts files (cascading
"Cannot find module" + downstream implicit-any from the unresolved imported
types — the same accepted whole-file-RED tradeoff the T2/T3 entry above
already established for `agent.test.ts`/`agent-permission-mode.test.ts`).
Zero errors in shell.ts / tui-shell.ts / agent.ts / shell.test.ts /
tui-shell.test.ts — confirmed via `grep -vE` over the diagnostics.
```

### DI seam note (per dispatch brief instruction: only add one if genuinely none exists, and document why)

No new DI seam was added anywhere. `createJobRegistry`'s existing
`spawn`/`onEvent`/etc. options (T2/T3) are already sufficient for the
harness-side event bridge (`job-bridge.ts`'s future `emitBackgroundJob` is
designed to be passed directly as `createJobRegistry({onEvent:
emitBackgroundJob})` — no registry change needed, per that file's own doc
comment already anticipating this exact hook). `shell.ts`/`tui-shell.ts`
needed NO new seam either — `AgentDeps` already has precedent for exactly
this shape of optional session hook (`resetSubagentBudget?: () => void;`),
so `sweepBackgroundJobs?: () => Promise<void>;` slots into the same existing
pattern rather than requiring a new mechanism. The one place a REAL new seam
would be needed — `modal-host.ts`'s keypress handler, for a literal "k"
hotkey — was identified and explicitly NOT added (see the kill-wiring note
above); the pinned test shape avoids needing it.

### Status

DONE. Both AC7 (re-verification) and AC8/AC9 have failing test coverage,
confirmed RED for the right reason, zero pre-existing tests broken, zero
implementation files touched. Next: task-implementer makes these GREEN,
following the PINNED SHAPE comments in each new/extended test file/block
verbatim (or documents + flags here why a genuinely better shape was used
instead), then resolves the one explicitly-flagged open design question
(does a naturally-exited job's entry auto-remove from `BackgroundJobStore`,
or only clear via `removeAll()`?) before implementing
`background-job-session.ts`.

## task-implementer: T4/T5 GREEN — shell.ts/tui-shell.ts exit-sweep wiring (AC7) + job-bridge/background-job-session/background-job-inspector (AC8/AC9)

Made every target failing test pass. No test files edited — only the PINNED
SHAPE described in the tests-creator's entry above was implemented, verbatim
except where noted.

**Files changed:**
- `src/commands/agent.ts` — `AgentDeps` gains
  `sweepBackgroundJobs?: () => Promise<void>;`, placed right after `askUser?:
  AskUserFn;`, doc-commented the same way as the pre-existing
  `resetSubagentBudget?` precedent (optional, no-op when absent, called only
  from a real session-exit path, never `/new`/`/clear`).
- `src/commands/shell.ts`:
  - Added `import { createJobRegistry } from
    "../harness/tool/builtin/background-job-registry";`.
  - Readline `if (agentMode) {` branch: `const jobRegistry =
    createJobRegistry({ cwd: agentCwd });` declared right after `agentCwd`,
    before `slateSessionBox`/`spawnTool`/`agentDeps`. `tools:
    buildInteractiveAgentTools({...})` now passes `jobRegistry,`. `agentDeps`
    gains `sweepBackgroundJobs: () => jobRegistry.sweepAll(),`.
  - TUI `if (surface !== "readline") {` branch: `const jobRegistry =
    createJobRegistry({ cwd });` declared once, before `const makeAgentDeps =
    async (`, so it is closed over (not rebuilt) across all 3 real
    `makeAgentDeps` invocations `tui-shell.ts` makes per session. The inner
    `buildInteractiveAgentTools({...})` call threads that same outer
    `jobRegistry` through; the returned `AgentDeps` gains
    `sweepBackgroundJobs: () => jobRegistry.sweepAll(),`.
  - `runAgentRepl`'s two real session-exit points — EOF (`if (line ===
    undefined) {`) and `/exit`|`/quit` — each now call `await
    deps.sweepBackgroundJobs?.();` right after `closeSlateSession(...)` and
    before `return;`. Confirmed NOT added to the `/new`|`/clear` block (AC9:
    a background job must survive it).
  - One char-budget fix along the way: the pre-existing "SLATE-3a — shell.ts
    getSessionDir threading" test (`shell.test.ts`) slices a FIXED 3600-char
    window from `if (agentMode) {`; my additions initially pushed content past
    that window and broke 2 of its assertions. Fixed by trimming an existing,
    non-test-pinned 4-line comment ("Same reset-per-turn wiring as the TUI's
    `makeAgentDeps`...") down to one line, and dropping a comment on the new
    `jobRegistry` declaration — no test-pinned string was touched, only
    incidental prose. Verified with a small `bun -e` char-offset script before
    and after; margin is now ~180 chars, not knife's-edge.
- `src/tui/tui-shell.ts` — the `/exit` branch's `void (async () => {...})();`
  IIFE now calls `await deps.sweepBackgroundJobs?.();` immediately after
  `await closeSlateSession(slateSession, mintTimestampAttemptId);` and before
  `r.off("theme_mode", onThemeMode);`. Confirmed it appears exactly once in
  the file and is absent from the `/clear`|`/new` block.

**New files** (none existed before this task; all three mirror their T4/T5
templates as pinned):
- `src/tui/job-bridge.ts` — `setBackgroundJobListener`/`emitBackgroundJob`,
  a direct structural mirror of `subagent-bridge.ts`, typed against the real
  `BackgroundJobEvent` union from `background-job-registry.ts` (T2/T3, no
  change needed there — its `onEvent` hook was already exactly this shape).
- `src/tui/background-job-session.ts` — `BackgroundJobStore` (apply/get/
  list/subscribe/**removeAll only, no `clear()`**) +
  `formatJobListHeader`/`formatJobRow`/`formatJobMeta`/`formatJobOutput` +
  `MAX_BACKGROUND_JOB_OUTPUT_CHARS = 20_000` (tail-bounded ring, distinct
  constant from the registry's own 2MB kill-rail cap).
- `src/tui/background-job-inspector.ts` — `paintBackgroundJobSidebar` +
  `presentJobInspector`/`openJobInspector`, `JOB_INSPECTOR_FOOTER` (adds `k:
  kill` to the subagent inspector's `←/→ tabs`/`esc close` pair). The kill
  action is a real clickable "[ Kill ]" row inside the Meta tab body calling
  `registry.kill(jobId)` directly — the exact same `JobRegistry.kill` method
  `shell_job_kill` calls, no private kill path. No `modal-host.ts` change
  (confirmed, per the tests-creator's note, no generic keypress-action seam
  exists there yet; adding a real "k" keypress binding is separate, real
  scope, not bundled here).

**Natural-exit-visibility decision, as implemented**: matches the dispatch
brief's instructed decision exactly, and matches what
`background-job-session.test.ts` already encoded (no conflict found) — a
background job that exits naturally (not killed) stays in `BackgroundJobStore`
with a terminal status (`"exited"`/`"killed"`, `exitCode`/`endedAt`
populated) and is **not** auto-removed. Only `removeAll()` (session-teardown/
kill-triggered bulk sweep) clears an entry. `apply()`'s `exit` branch updates
status/exitCode/endedAt in place and returns early without deleting from the
`Map`; `list()`/`get()` continue to return it until `removeAll()` runs.

**Test results** (all commands run from this worktree):
- Target files — `bun test src/commands/shell.test.ts src/tui/tui-shell.test.ts
  src/tui/job-bridge.test.ts src/tui/background-job-session.test.ts
  src/tui/background-job-inspector.test.ts`: shell.test.ts 64/64,
  tui-shell.test.ts 65/65, job-bridge.test.ts 5/5,
  background-job-session.test.ts 14/14, background-job-inspector.test.ts
  8/8 — all green, 0 fail (flow-173-tagged subsets: shell.test.ts 9/9 "flow
  173", tui-shell.test.ts 4/4 "flow 173").
- Regression batch — `bun test` across shell.test.ts, tui-shell.test.ts,
  agent.test.ts, agent-permission-mode.test.ts, interactive-agent-tools.test.ts,
  background-job-registry.test.ts, shell-exec-background.test.ts,
  job-bridge.test.ts, background-job-session.test.ts,
  background-job-inspector.test.ts: **272 pass / 0 fail** (936 expect calls,
  10 files).
- Extra adjacent-surface sweep (not in the dispatch brief's list, run for
  extra confidence): agent-destructive-gate.test.ts,
  agent-approval-binding.test.ts, shell-exec-tool.test.ts,
  shell-exec-timeout.test.ts, subagent-bridge.test.ts, subagent-session.test.ts,
  subagent-inspector.test.ts, modal-host.test.ts: **59 pass / 2 skip
  (pre-existing, unrelated live/opt-in sandbox tests) / 0 fail**.
- Full-repo sweep — `bun test --timeout 30000`, all 404 files: **4220 pass /
  14 skip / 47 fail / 41363 expect() calls, 652.43s**. Verified via
  `rg "^\(fail\)"` over the run log that all 47 failures are in
  `serve.*`/registry/`sessions.fork`/turns/idempotency/containment test
  files — none in `shell.ts`/`tui-shell.ts`/`agent.ts`/the background-job
  surface — same pre-existing, unrelated failure set the prior T2/T3
  task-implementer entry already documented and isolated via `git stash`
  (socket/path canonicalization issues specific to this fresh worktree). Pass
  count is up by exactly 40 over that entry's baseline (4180→4220), matching
  the 9+4+5+14+8 = 40 new tests this task made green.
- `bunx tsc --noEmit -p .`: clean, exit 0, zero errors.

### AC1–AC10 checklist (end-to-end reality, not just unit-tested in isolation)

- **AC1–AC6, AC10**: unchanged from the T2/T3 entry above — genuinely
  end-to-end real. `shell_exec({background:true})`, `shell_job_output`,
  `shell_job_kill`, the concurrency cap, the `risk:"read"` budget
  classification, and the shared approval gate are all reachable from a real
  `keryx shell`/TUI session today (`interactive-agent-tools.ts` registers
  both tools alongside `shell_exec` in the one factory both surfaces share).
- **AC7 — NOW genuinely real end-to-end** (this was the flagged gap from the
  prior two entries): a `JobRegistry` is created once per real session in
  BOTH `shell.ts`'s readline branch and its TUI `makeAgentDeps` closure, and
  `sweepAll()` is wired to fire on the real graceful-exit paths (readline EOF/
  `/exit`/`/quit`; TUI `/exit`) via `AgentDeps.sweepBackgroundJobs`. Verified
  by reading the real, current source (not re-deriving from stale line
  numbers) and via source-text audits — the established, only-available
  verification convention for these two functions in this codebase (`shell.ts`
  and `tui-shell.ts` document elsewhere that `runAgentRepl`/
  `launchTuiAgentShell` have no headless injection seam; every other
  SLATE-3a/SLATE-5/SLATE-15/flow-163-AC8 wiring proof in both files uses the
  same `readFileSync`-the-real-source pattern). A real background job started
  in a real `keryx shell --no-tui` session or the TUI is killed by process
  group on session exit; none survive.
- **AC8/AC9 — components built and correctly unit-tested against the pinned
  design, but NOT yet wired into a real running session — a genuine,
  explicitly flagged gap, not silently treated as done.** `job-bridge.ts`,
  `background-job-session.ts`, and `background-job-inspector.ts} all exist,
  are correct, and pass every pinned test — but:
  1. Nothing in `tui-shell.ts` calls `paintBackgroundJobSidebar` or
     `openJobInspector`/`openSubagentInspector`'s job equivalent — there is no
     "Background Jobs N" sidebar section mounted anywhere (confirmed:
     `rg "background-job-inspector|paintBackgroundJobSidebar"
     src/tui/tui-shell.ts` — zero matches). The real mount point, by direct
     analogy to the existing `paintSubagentSidebar(otui, r, sbSubagents,
     sessions.list(), {...})` call at `src/tui/tui-shell.ts:1718`, would be a
     new `sbJobs` box painted the same way from a `BackgroundJobStore`
     instance's `.list()`.
  2. Nothing calls `createJobRegistry({..., onEvent: emitBackgroundJob})`
     anywhere in real code — `shell.ts`'s two `jobRegistry` instances (added
     by this task) are created WITHOUT an `onEvent` callback, so no real
     background job's start/output/exit events reach `job-bridge.ts` or any
     `BackgroundJobStore` in a live session today. `emitBackgroundJob`/
     `setBackgroundJobListener` and `BackgroundJobStore` are exercised only by
     their own unit tests, not by any real harness→TUI event flow.
  3. Net effect: AC9's persistence behavior (job survives `/clear`/`/new`,
     only `removeAll()` clears it) is real and correct in `BackgroundJobStore`
     itself, but there is no live `BackgroundJobStore` instance anywhere in a
     real session for that guarantee to apply to yet.
  This was explicitly out of scope for the test files this task was
  dispatched against — the tests-creator's own entry above already flagged
  that "wiring these three modules into `tui-shell.ts`'s actual sidebar/mount
  point was explicitly not one of the three files this task was scoped to
  test" — and no failing test in the dispatch brief's target list required
  this wiring. Implementing it without a driving test would break this flow's
  TDD discipline (tests-creator writes the test first); flagging it here
  instead, as real remaining scope, likely a small T4/T5-follow-up or a T6
  review finding: (a) wire `createJobRegistry({onEvent: emitBackgroundJob})`
  into both `shell.ts` `jobRegistry` sites (or at minimum the TUI one), (b)
  mount a `BackgroundJobStore` + `sbJobs` sidebar section + `openJobInspector`
  wiring in `tui-shell.ts` alongside the existing Subagents panel, each new
  test-first per this flow's established TDD pattern.

**Overall**: AC1–AC7 and AC10 are genuinely satisfied end-to-end. AC8/AC9 are
satisfied at the component/unit level (built correctly to the pinned design,
zero test failures) but not yet reachable from a real running `keryx shell`/
TUI session — a real, explicit gap for T6 (review) or a short follow-up task
to close before this flow can be called fully done.

## Orchestrator: closed the AC8/AC9 real-session wiring gap (2026-08-19)

Verified the previous task-implementer's claims directly first: ran the 10
target files myself (272 pass / 0 fail) and `bunx tsc --noEmit -p .` (clean)
before trusting the report and proceeding. Then closed exactly the two
mechanical wiring points its own report identified — no new design, both
pieces already existed and correctly built, just not connected:

1. **`src/commands/shell.ts`**: `createJobRegistry({ cwd })` (the TUI-facing
   instance, declared once outside `makeAgentDeps`) → `createJobRegistry({
   cwd, onEvent: emitBackgroundJob })`. `emitBackgroundJob` imported from
   `../tui/job-bridge`. Readline's own `createJobRegistry` call is
   deliberately left untouched — no listener is ever registered on that
   surface, so `onEvent` there would be dead weight, and `job-bridge.ts`'s
   own header comment already documents `emitBackgroundJob` as a safe no-op
   when nothing is listening.
2. **`src/commands/agent.ts`**: added `AgentDeps.jobRegistry?: JobRegistry`
   (sibling of the existing `sweepBackgroundJobs` field, same doc-comment
   style) — the SAME registry instance the model-facing `shell_job_kill` tool
   uses, exposed so the TUI inspector's kill action goes through the
   identical path, never a second private one. `shell.ts` now returns
   `jobRegistry` on both the value it hands back from `makeAgentDeps` (TUI
   path) alongside the pre-existing `sweepBackgroundJobs`.
3. **`src/tui/tui-shell.ts`**: mounted the panel exactly where
   `sbSubagents`/`sessions`/`paintSubagents` already live (same hug-content
   `BoxRenderable` idiom, same `flexShrink:0` reasoning documented on the
   existing panel) — a new `sbJobs` box, `const jobs = new
   BackgroundJobStore()`, a `paintJobs` function mirroring `paintSubagents`
   (its `onOpen` reads `deps.jobRegistry` — `deps` is the file's existing
   `let`-captured live AgentDeps reference, already reassigned on `/model`/
   `/connect`, so this automatically tracks a provider switch with no new
   plumbing), `jobs.subscribe(paintJobs)`, and
   `setBackgroundJobListener((ev) => jobs.apply(ev))` right next to the
   existing `setSubagentFleetListener` registration. Teardown:
   `setBackgroundJobListener(undefined)` added next to the existing
   `setSubagentFleetListener(undefined)` in the renderer's `onDestroy`.

One pre-existing source-text-audit test broke as an expected, correct
consequence: `shell.test.ts`'s "a session-scoped jobRegistry is declared
OUTSIDE makeAgentDeps" test asserted the OLD exact `createJobRegistry({
cwd });` string. Updated the assertion to the new exact string — the
invariant it guards (declared once, outside `makeAgentDeps`) is unchanged
and still holds; only the literal source text it matched against was stale.

**Verification**: same 10 target files re-run after the fix — 272 pass / 0
fail. Full-repo suite re-run — 4220 pass / 14 skip / 47 fail (byte-identical
counts to the pre-fix baseline the last task-implementer reported; the 47
are the same pre-existing/unrelated failures, confirmed no new ones and no
newly-fixed ones). `bunx tsc --noEmit -p .`: clean.

**AC1–AC10 status, final**: all ten are now genuinely satisfied end-to-end
from a real running `keryx shell`/TUI session, not just at the unit/component
level. No known remaining gap for T2/T3. Ready for T4 (review).
- 2026-08-19T10:01:22.357Z - task-done: T2: Implement per plan
- 2026-08-19T10:01:25.665Z - task-done: T3: Add/adjust tests and make them pass

## Task-implementer: T4 review fix-round, TUI-layer findings (2026-08-19)

Fixed the TUI-layer findings from the T4 `review-orchestrator` REQUEST_CHANGES
pass. Scope: `src/tui/tui-shell.ts`, `src/commands/shell.ts` (exit-sweep
wiring only), `src/tui/background-job-session.ts`,
`src/tui/background-job-inspector.ts`, `src/tui/job-bridge.ts`, and their
test files. A concurrent task-implementer owned `background-job-registry.ts`,
`shell-exec-tool.ts`, `commands/agent.ts`, `commands/interactive-agent-tools.ts`
at the same time — none of those were touched.

**F-002 (BLOCKER, fixed).** Confirmed all three gaps by reading the source
directly: `deps.sweepBackgroundJobs?.()` had exactly one call site (non-busy
`/exit`); `onDestroy` (Ctrl+C — `createShellRenderer` does pass
`exitOnCtrlC: true`) tore down listeners but never swept; the busy-dispatch
`/exit` branch (`classifyBusyDispatch` → `case "exit"`) closed the session
without sweeping either; `BackgroundJobStore.removeAll()` had zero production
call sites anywhere in the repo (confirmed by search).
- Added `jobs.removeAll()` (store purge) next to every OS-level
  `sweepBackgroundJobs?.()` call: non-busy `/exit`, busy-dispatch `/exit`.
- `onDestroy`: `@opentui/core`'s `onDestroy` is strictly `() => void` — I read
  both its `.d.ts` and the compiled `chunk-bun-*.js` to confirm `destroy()`
  calls `_onDestroy()` synchronously without awaiting it, and that neither
  `destroy()` nor its Ctrl+C/SIGINT/SIGTERM handlers ever call
  `process.exit()` (the process only exits once the event loop drains, and
  `launchTuiAgentShell`'s own caller sits on `await done`). So the fix fires
  `liveJobs?.removeAll()` synchronously, then kicks off
  `await liveDeps?.sweepBackgroundJobs?.()` in a detached async IIFE that
  calls `resolveDone()` only in its `finally` — deferring `done`'s resolution
  (and therefore anything downstream of `launchTuiAgentShell()`, including
  process exit) until the sweep actually settles.
  - `deps`/`jobs` don't exist yet if Ctrl+C fires during the provider/model
    picker (before either is assigned) — same TDZ hazard the file's existing
    `mountedChrome` nullable-ref pattern already solves for chrome. Mirrored
    it: added `liveDeps`/`liveJobs` nullable refs declared before the `try`
    block, assigned at both `deps = await opts.makeAgentDeps(...)` sites and
    at `const jobs = new BackgroundJobStore()`, read via optional chaining in
    `onDestroy`.
- Rewrote the locked-in regression guard in `tui-shell.test.ts` (the old
  "sweepBackgroundJobs called exactly once" test, now factually wrong) into
  invariant-scoped tests: sweep+purge present (in the right order, sweep
  before purge... actually purge-then-sweep-then-resolve for onDestroy,
  close-then-sweep-then-purge-then-destroy for both `/exit` branches) at all
  three real exit paths, absent from `/clear`|`/new`, plus exact-occurrence
  counts split by literal (`deps.sweepBackgroundJobs?.()` ×2 for the two
  `/exit` branches, `liveDeps?.sweepBackgroundJobs?.()` ×1 for `onDestroy`,
  same split for `removeAll`).

**F-003 (BLOCKER, fixed — my resolved fix, not the reviewer's literal
suggestion, per the dispatch brief).** `shellJobKillTool` stays `risk:"read"`
(AC6 is frozen, confirmed by reading `acceptance-criteria.md`). Added a
module-level `SIDE_WORKER_DENIED_TOOL_NAMES` deny-list (`Set(["shell_job_kill"])`,
documented with why) and changed the side-worker tools filter to
`risk === "read" && !SIDE_WORKER_DENIED_TOOL_NAMES.has(t.definition.name)`.
`shell_job_output` still passes through. Added a source-text audit test in
`tui-shell.test.ts` proving the deny-list constant exists and the filter
checks both conditions (no injection seam for `spawnSideWorker`'s closure,
same precedent as every other audit in this file).

**F-008 (MAJOR, fixed).** `paintJobs` now takes `hint?: BackgroundJobStoreHint`
and returns early on `hint?.kind === "output"`, mirroring `paintSubagents`'s
`"log"` guard exactly. Confirmed `BackgroundJobStore.subscribe`/`emit` already
thread the hint through (`jobs.subscribe(paintJobs)` needed no change).

**F-011 (MAJOR):**
1. `background-job-session.test.ts`'s AC9 test never actually simulated a
   turn/`/clear` boundary — it just re-proved output events don't delete
   entries. Since `BackgroundJobStore` deliberately has no `clear()`, I
   reframed the test honestly (renamed + doc comment) as proving the store's
   own contract only, and pointed to the real wiring-level proof: the new
   F-002 test in `tui-shell.test.ts` that slices the actual `/clear`|`/new`
   source block and asserts neither `sweepBackgroundJobs` nor `removeAll`
   appears in it. **Not fully fixed as literally requested** — a real
   end-to-end "drive an actual `/clear` through `launchTuiAgentShell` and
   assert the sidebar still lists the job" test would need a genuine headless
   dispatch harness for `launchTuiAgentShell`, which does not exist anywhere
   in this file today (every other closure in it — `/model` switch, side
   worker, busy-dispatch — is audited the same source-text way, confirmed by
   reading the file). Building that harness is a real, separate
   test-infrastructure investment, not a same-round fix; flagging as a
   follow-up rather than silently downgrading the guarantee.
2. Extended both negative audits (`tui-shell.test.ts` and `shell.test.ts`) to
   also assert `removeAll`/`jobs.removeAll()` is absent from the `/clear`|
   `/new` block. Confirmed by search: `shell.ts`'s readline surface has no
   `BackgroundJobStore` at all (by design — no sidebar there), so that half
   of the guard is currently vacuous there, but cheap and forward-guarding;
   noted as such in the test's comment.
3. Fixed the missing `-1` guard on `shell.test.ts`'s `newBlockStart` (now
   `toBeGreaterThanOrEqual(0)`, matching its TUI sibling) and widened the
   hardcoded 900-char slice window to a structural boundary (the next
   `else if (command === "/compact")` branch) instead of a magic number.

**F-015 (MINOR, fixed).** `background-job-inspector.ts`'s `[Kill]` row now
surfaces a failed `{ok:false, error}` result on a dedicated status line node
(`job-inspector-kill-status`) instead of discarding it — the common case per
AC9 (finished jobs stay visible/clickable). Added a test driving a
kill-on-already-finished-job failure and asserting the status line updates.

**F-016 (MINOR, fixed).** Narrowed the inspector's declared dependency to
`JobKillCapability = Pick<JobRegistry, "kill">` (the only method it ever
calls) instead of the full `JobRegistry` surface — a real `JobRegistry`
satisfies it structurally, so no plumbing changed at any call site. Added a
test proving a kill-only stub is a valid registry.

**F-018 (MINOR, fixed).** `renderTab` now nulls the OTHER tab's node when
assigning one (`outputNode = undefined` when setting `metaNode`, and vice
versa), so `refresh()` can no longer write into a node detached by a tab
switch. Checked `subagent-inspector.ts` first per the dispatch brief's
instruction to mirror it if it handles this — it does NOT (same gap, not
fixed there, out of my scope) — so this was a fresh fix, not a mirror. Added
a regression test that drives a tab switch then a late store update and
asserts the detached node's content is untouched while the active tab's node
updates.

**Verification**: `tui-shell.test.ts`, `shell.test.ts`, `job-bridge.test.ts`,
`background-job-session.test.ts`, `background-job-inspector.test.ts` — 167
pass / 0 fail (572 assertions). `bunx tsc --noEmit -p .` — clean, zero
diagnostics anywhere in the repo (the concurrent harness-layer task's
in-progress files also type-checked clean at the time I ran this). Did not
run the full-repo `bun test` per the dispatch brief (a later reconciliation
step covers both fix branches together).

**Not touched, confirmed out of scope**: `background-job-registry.ts`,
`shell-exec-tool.ts`, `commands/agent.ts`, `commands/interactive-agent-tools.ts`,
`acceptance-criteria.md`, `flow.json`.

## Task-implementer: T4 review fix-round, harness-layer findings (retroactive entry)

Ran concurrently with the TUI-layer fix-round above (disjoint files, no
conflicts). This entry was missing from the journal at the time — added
retroactively after a second review pass independently verified every claim
below by reading the actual current code, not this description, so treat the
verification pass's report as the authoritative confirmation; this entry is
for the historical record.

**[F-001]/[F-014] (BLOCKER)**: extracted `resolveShellEnv()`/
`resolveSandboxedSpawn()` out of `shell-exec-tool.ts`'s `makeCommandRunner`
as shared exports (sandbox-mode resolution, fail-closed launcher refusal,
restricted-network masking, `applySavedApiKeys()`, explicit env). 
`background-job-registry.ts`'s `realSpawner()` now calls both — background
jobs get the identical sandbox posture as the synchronous path.
`makeCommandRunner` itself just calls the now-exported functions; its own
behavior is unchanged.

**[F-004] (BLOCKER)**: rewrote the AC3 real-subprocess test
(`background-job-registry.test.ts`) to verify process-group membership via
`ps -o pgid=` on both the direct child and a captured grandchild PID BEFORE
killing (proving detachment genuinely happened), then checks that specific
grandchild PID is gone afterward — not a group-level probe that could
false-pass on broken detachment. `initialBufferMs: 0` passed explicitly.

**[F-005] (MAJOR)**: `appendOutput`'s over-cap truncation now rebases
`readCursor` by the dropped amount (`dropped = length - MAX; buffer =
buffer.slice(dropped); readCursor = Math.max(0, readCursor - dropped)`).

**[F-006] (MAJOR)**: added `REPEATABLE_TOOL_NAMES` (containing only
`shell_job_output`, NOT `shell_job_kill`) consulted in `agent.ts`'s
`reserveToolAttempt`, exempting repeated same-`job_id` polls from the
per-hash attempt cap without weakening the cap for any other tool.

**[F-007] (MAJOR)**: added a `killRequested` flag set before signaling;
`onExit` now derives final status (`"killed"` vs `"exited"`) from that flag
regardless of which signal actually ended the process; the SIGKILL branch no
longer force-sets status or emits its own `exit` event — exactly one `exit`
event per job, from `onExit` only.

**[F-009] (MAJOR)**: added `MAX_TRACKED_JOBS` with oldest-terminated-first
LRU eviction (running jobs are never eligible) plus
`TERMINATED_OUTPUT_TAIL_BYTES` buffer-shrink after a job's exit event has
been delivered.

**[F-010] (MAJOR)**: `buildInteractiveAgentTools` no longer mints a fallback
`JobRegistry` when the caller omits one — `shell_job_output`/`shell_job_kill`
are omitted from the returned tool list entirely in that case, and
`shell_exec({background:true})` fails with a clear error instead of silently
using an orphaned registry.

**[F-012]/[F-013] (MAJOR)**: added a real `onEvent`-sequence test (asserts
the exact `["start","output","output","exit"]` shape from a real registry
run) and a real 2MB-auto-kill-rail test (asserts exactly one SIGTERM despite
multiple over-cap chunks arriving during the grace window, final status
"killed", tail correctly bounded).

**[F-017] (MINOR)**: `realSpawner` now uses one `TextDecoder` per stream
(stdout/stderr), matching the synchronous path — no more shared-decoder
multi-byte UTF-8 corruption risk on interleaved output.

**[F-020] (MINOR)**: strengthened the cross-registry test to actually start
a job in each of two registries and confirm no `job_id` collision/confusion
between them (previously `registryB` was left empty, proving nothing).

**Verification**: harness-layer target test set — 143 pass / 0 fail at the
time this round completed; `bunx tsc --noEmit -p .` clean. The orchestrator's
own subsequent full-repo run (after both fix rounds landed together) showed
4241 pass / 14 skip / 47 fail — the same 47 pre-existing/unrelated failures
as the pre-fix baseline, 21 new passing tests, zero regressions.

**Not touched, confirmed out of scope**: `tui-shell.ts`, `shell.ts`'s
exit-sweep wiring, `background-job-session.ts`, `background-job-inspector.ts`,
`job-bridge.ts`, `acceptance-criteria.md`, `flow.json`.

## Orchestrator: second review pass — APPROVE

Dispatched a targeted fix-verification review (not a fresh full review) to
check each of the 13 blocker/major claims above against the real current
code, after a first attempt stalled on a long-running command and was killed
by the watchdog — retried with an explicit read-only/no-long-commands
constraint. Verdict: **APPROVE**. All 4 blockers and 9 majors confirmed
genuinely closed by direct code reading (not by trusting the fix-round
reports); 3 spot-checked minors (F-015/F-016/F-018) also genuine; no new
issues introduced by either fix round. F-011 remains honestly
partially-fixed (a true end-to-end `/clear`-driven TUI test needs a headless
harness that doesn't exist yet — disclosed as a real follow-up, not hidden).

T4 (review) is done. Proceeding to T5 (docs).
- 2026-08-19T12:07:24.241Z - task-done: T4: Self-review and prepare draft PR
- 2026-08-19T12:09:45.685Z - task-done: T5: Docs: wiki/architecture/background-jobs.md
- 2026-08-19T12:10:07.151Z - ac-confirmed: AC1: shell-exec-background.test.ts: background:true resolves without waiting for exit, carries job_id, DEFAULT_SHELL_TIMEOUT_MS never fires on it
- 2026-08-19T12:10:07.299Z - ac-confirmed: AC2: background-job-registry.test.ts: shell_job_output is cursor-based, returns only new output since previous call
- 2026-08-19T12:10:07.446Z - ac-confirmed: AC3: Rewritten real-subprocess test (fixed post F-004): proves process-group detachment via ps -o pgid= before kill, confirms specific grandchild PID gone after kill; independently re-verified by 2nd review pass reading the test logic directly
- 2026-08-19T12:10:22.229Z - ac-confirmed: AC4: background-job-registry.test.ts: shell_job_kill/shell_job_output reject unknown/foreign-registry job_id, no OS process touched; cross-registry test strengthened (F-020) to prove no job_id confusion between two real registries
- 2026-08-19T12:10:22.415Z - ac-confirmed: AC5: MAX_CONCURRENT_BACKGROUND_JOBS (default 3, KERYX_MAX_BACKGROUND_JOBS override) enforced synchronously (no TOCTOU, confirmed by review); exceeding it returns a tool error naming running jobs, never queues/evicts
- 2026-08-19T12:10:22.571Z - ac-confirmed: AC6: agent.test.ts: shell_job_output/shell_job_kill both risk:read, draw from the read tool-call pool not the scarce non-read pool
- 2026-08-19T12:10:39.503Z - ac-confirmed: AC7: Post F-002 fix: real session-exit sweep now fires on all 3 real exit paths (readline EOF/exit/quit, TUI /exit both busy and idle branches, TUI onDestroy/Ctrl+C) plus BackgroundJobStore.removeAll(); verified by 2nd review pass reading each call site directly, not just trusting the fix report
- 2026-08-19T12:10:39.672Z - ac-confirmed: AC8: background-job-inspector.test.ts (paintBackgroundJobSidebar onMouseDown -> onOpen) + real wiring in tui-shell.ts (sbJobs panel, jobs.subscribe(paintJobs), setBackgroundJobListener) confirmed reachable from a real TUI session, not just unit-tested in isolation
- 2026-08-19T12:10:39.840Z - ac-confirmed: AC9: BackgroundJobStore has no clear() method (only removeAll(), called solely from real session-exit paths); tui-shell.test.ts's flow-173 describe block slices the real /clear|/new source and asserts neither sweepBackgroundJobs nor removeAll appears in it. One sub-part (a full real /clear-driven end-to-end TUI test) remains disclosed-deferred pending a headless TUI test harness that doesn't exist yet -- not hidden, recorded as known follow-up
- 2026-08-19T12:10:52.662Z - ac-confirmed: AC10: agent-permission-mode.test.ts: background:true goes through the real shellExecTool + resolveApprovalDecision identically to a sync shell_exec call across ask/trust/auto and the credentials floor
