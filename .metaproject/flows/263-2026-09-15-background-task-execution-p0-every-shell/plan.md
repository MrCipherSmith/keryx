# Implementation Plan

Status: accepted

## Approach

Evolve the flow-173 `JobRegistry` in place (`src/harness/tool/builtin/background-job-registry.ts`)
into the task supervisor instead of creating the `shell-task-*.ts` files named in
specification §2. Its process-group spawn, sandbox reuse, bounded ring, LRU
eviction, cursor rebasing and `killRequested` status derivation are exactly what
the spec reuses; moving them to new files in the same PR would bury the
behavioural diff under a rename. The file split is deferred to P3 (journal).

Idle timeout (spec P1, AC3) is pulled into P0. Without it a task that outlives
its yield has no timeout at all, and keeping the wall-clock deadline for it
would need a `killReason` the schema does not have.

### Registry (supervisor) changes

- Task ids `task-<n>-<pid>`.
- `phase: "foreground" | "background"`; `start(command, { phase, description, idleTimeoutMs })`.
  The concurrency cap applies only to `phase: "background"` starts and counts
  only background-phase running tasks (D-12).
- `waitForExit(id, ms)` → `"exited" | "timeout"`, driven by injectable timers.
- `promote(id)` → background phase; emits a `phase` event once; reports whether
  the background cap is now exceeded and which tasks run (never kills).
- Status `completed` (exit 0) / `failed` (non-zero) / `killed` with `killReason`
  `model` | `operator` | `idle` | `output-cap` | `session-exit` (D-14).
  `kill(id, reason = "model")`; `sweepAll()` uses `session-exit`.
- Idle timer per task, reset on every output chunk; on expiry the task is killed
  with `killReason: "idle"`.
- Event union gains `phase`; `exit` carries `killReason`.
- Config resolvers: `KERYX_SHELL_YIELD_MS` (10 000), `KERYX_SHELL_IDLE_MS`
  (120 000; falls back to deprecated `KERYX_SHELL_TIMEOUT_MS` when unset; `0`
  disables only when set deliberately), per-call clamp [1 000, 1 800 000].

### `shell_exec` changes

- No registry → today's synchronous `makeCommandRunner` path, unchanged (D-17).
- Otherwise start a foreground task, `waitForExit(yieldMs)`:
  - exited → synchronous-shaped result from the task's output (trim, 20 000-byte
    head cap + `…(truncated)`, `(no output; exit N)`, `isError` on non-zero exit
    or kill, idle-kill notice naming `KERYX_SHELL_IDLE_MS`);
  - still running → `promote`, return JSON `{ task_id, job_id, pid, status: "running", output, notice }`
    (+ `over_cap` text when the background cap is exceeded).
- `background: true` → background-phase start (cap refusal as today), wait the
  existing 500 ms initial buffer, return the handle JSON (`job_id` kept as an
  alias of `task_id` for one release).
- Input schema adds `description?: string`, `idle_timeout_ms?: integer`;
  description text rewritten (no more "set background:true for long commands").

### TUI

`BackgroundJobStore` holds a task hidden from `start` until its `phase:
background` event (buffering its output), drops it if it exits first, and knows
the new statuses (glyphs for `completed` / `failed` / `killed`).

## Steps

1. RED tests for every AC (tests-creator).
2. Registry changes (task-implementer).
3. `shell_exec` yield path, schema and description (task-implementer).
4. TUI store phase gating and statuses (task-implementer).
5. Verification: regression suites, typecheck, real-process smoke of the incident.
6. Review, PR, merge, complete.

## Risks

- Existing registry/shell tests assert `job-` ids, `exited` status and the
  500 ms start buffer — they are updated deliberately, never deleted.
- Interleaved stdout/stderr order in a yielded result differs from the old
  "stdout then stderr" concatenation; accepted (it is the real order), covered by
  the AC2 test on content, not byte order across streams.
- Any prompt/system-instruction text that tells the model to use
  `background:true` for long commands must be updated or it contradicts the tool.
- Load-induced 5 s test timeouts: run the full suite with `--timeout 30000`.
