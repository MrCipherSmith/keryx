// Session-scoped TASK supervisor (flow 173 T2/T3; flow 263 turned it into the
// supervisor for EVERY `shell_exec`, not just `background:true` ones). Sibling
// of `shell-exec-tool.ts`.
//
// Every shell command is a supervised task here. A task starts in one of two
// PHASES: `foreground` (the caller — `shell_exec` — is waiting on it via
// `waitForExit`) or `background` (nobody is waiting; the model polls it with
// `shell_job_output`). A foreground task that outlives its caller's bounded
// wait is `promote()`d to background rather than killed, which is what makes a
// slow command a backgrounded task instead of a dead one. Ids are
// `task-<n>-<pid>`; the internal field names stay `jobId` for compatibility
// with the existing tool surface.
// The default spawner (`realSpawner`) reuses `shell-exec-tool.ts`'s
// `resolveShellEnv`/`resolveSandboxedSpawn` — the SAME env-resolution +
// OS-sandbox posture the synchronous path applies, including its fail-closed
// refusal when the sandbox launcher is unavailable (flow 173 review findings
// F-001/F-014: this module previously spawned bare, bypassing the sandbox
// entirely and never applying saved API keys).
//
// Process-group ownership (see this flow's journal.md "T3 test spike"): the
// default spawner passes `detached: true` to `Bun.spawn`, making the direct
// child a fresh process-group LEADER (POSIX `setsid` semantics, PGID === PID).
// Every kill path here signals `-pid` (the negative PID convention for "the
// whole process GROUP"), never a bare PID — this is what reaches a grandchild
// a `sh -c 'cmd &'` backgrounds and forgets about, closing the exact
// process-ownership bug class hit live by opencode/Codex (see context.md).

import type { InteractiveTool, InteractiveToolResult } from "./interactive-tools";
import { resolveShellEnv, resolveShellSpawn } from "../../process/shell-spawn";

/** One background process, abstracted so tests can inject a fake (no real subprocess). */
export interface BackgroundProcessHandle {
  pid: number;
  onOutput(cb: (chunk: string, stream: "stdout" | "stderr") => void): void;
  onExit(cb: (info: { exitCode: number }) => void): void;
  kill(signal: "SIGTERM" | "SIGKILL"): void;
}

/**
 * Starts a detached background process for `command` in `cwd`. May return
 * synchronously (existing test fakes) or a `Promise` (the real spawner, which
 * must `await resolveShellEnv()`/`resolveSandboxedSpawn()` first — see this
 * module's header comment) — `JobRegistry.start()` awaits either.
 */
export type BackgroundSpawner = (
  command: string,
  cwd: string,
) => BackgroundProcessHandle | Promise<BackgroundProcessHandle>;

/**
 * Why a task was killed. Distinguishes a deliberate model/operator kill from
 * the registry's own safety rails (`idle`, `output-cap`) and from session
 * teardown (`session-exit`) — a plain "killed" status cannot tell an operator
 * whether their command failed or the supervisor gave up on it.
 */
export type KillReason = "model" | "operator" | "idle" | "output-cap" | "session-exit" | "hold-timeout";

/** Public, session-visible snapshot of a tracked task. */
export interface BackgroundJobInfo {
  jobId: string;
  pid: number;
  command: string;
  /**
   * `completed`/`failed` split what flow 173 reported as a single `exited`:
   * exit code 0 is `completed`, any non-zero code is `failed`. A task with a
   * kill requested reports `killed` regardless of the code it died with.
   */
  status: "running" | "completed" | "failed" | "killed";
  /** `foreground` while a caller awaits it; `background` once nobody does. */
  phase: "foreground" | "background";
  /** Short human label for the TUI task list (e.g. "watch CI"). */
  description?: string;
  /** Effective idle timeout for THIS task in ms; `0` disables the idle rail. */
  idleTimeoutMs: number;
  /** Set only when `status` is `killed`. */
  killReason?: KillReason;
  /**
   * The agent has seen this task's TERMINAL status (flow 265): a delivered
   * completion notification, a `shell_job_output` that returned it finished, or
   * a `shell_job_kill` that ended it. Polling a task that is still RUNNING does
   * not count — nothing about its outcome was reported.
   *
   * This is what keeps delivery exactly-once: `drainUndelivered` returns only
   * tasks that are terminal and unobserved, and marks them observed in the same
   * step.
   */
  observed: boolean;
  /**
   * First {@link TASK_OUTPUT_HEAD_BYTES} of the transcript, kept from the
   * START and never shrunk — what `shell_exec` builds the synchronous-shaped
   * result of a short command from (the ring buffer keeps the tail instead,
   * and is already drained/shrunk by the time the awaiting caller returns).
   * Absent until the task produces output.
   */
  outputHead?: string;
  startedAt: string;
  endedAt?: string;
  exitCode?: number;
}

/** Default hard cap on concurrently RUNNING background jobs per session. */
export const MAX_CONCURRENT_BACKGROUND_JOBS = 3;

/** Env override for {@link MAX_CONCURRENT_BACKGROUND_JOBS}. */
export const ENV_MAX_BACKGROUND_JOBS = "KERYX_MAX_BACKGROUND_JOBS";

/**
 * Resolve the concurrency cap. Unset / empty / non-numeric / non-positive all
 * fall back to the default — mirrors `resolveShellTimeoutMs`'s
 * fallback-on-malformed pattern (a malformed override must never silently
 * mean "unlimited").
 */
export function resolveMaxConcurrentBackgroundJobs(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = env[ENV_MAX_BACKGROUND_JOBS];
  if (raw === undefined || raw.trim().length === 0) {
    return MAX_CONCURRENT_BACKGROUND_JOBS;
  }
  const n = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(n) || n <= 0) {
    return MAX_CONCURRENT_BACKGROUND_JOBS;
  }
  return n;
}

/** SIGTERM→SIGKILL grace period for a background job kill (mirrors the sync path's 2s). */
export const BACKGROUND_KILL_GRACE_MS = 2_000;

/**
 * Output ring cap per job, separate from the sync path's 20KB `MAX_OUTPUT_BYTES`
 * (plan.md Risks: "Output buffering memory growth" — a chatty long-running job
 * like a build watcher must not accumulate an unbounded buffer). 2MB is large
 * enough for realistic long-session output while staying a bounded, documented
 * ceiling; a job that exceeds it is auto-killed rather than silently truncated
 * forever, mirroring Claude Code's own (much larger) output-cap auto-kill rail.
 */
export const MAX_BACKGROUND_OUTPUT_BYTES = 2 * 1024 * 1024;

/** How long `start()` buffers output before returning, so the caller sees early output immediately. */
const DEFAULT_INITIAL_BUFFER_MS = 500;

/**
 * Hard cap on total tracked jobs (running + terminated) per registry (flow
 * 173 review finding F-009). `MAX_CONCURRENT_BACKGROUND_JOBS` only bounds
 * RUNNING jobs — a finished job used to stay in the `jobs` Map (and its up-to
 * -2MB `outputBuffer`) forever, an unbounded memory leak over a long session.
 * Once tracked jobs exceed this, the OLDEST TERMINATED entries are evicted
 * (insertion order; a running job is never evicted — see
 * `evictOldestTerminatedIfOverCap`).
 */
export const MAX_TRACKED_JOBS = 50;

/**
 * Once a job's final `exit` event has been delivered (and therefore
 * presumably already read via `shell_job_output`), its `outputBuffer` is
 * shrunk to this many trailing characters rather than staying at its full,
 * possibly multi-megabyte size forever (flow 173 F-009, paired with the
 * MAX_TRACKED_JOBS eviction above).
 */
export const TERMINATED_OUTPUT_TAIL_BYTES = 4_000;

/**
 * How much of a task's transcript is kept from the START, separately from the
 * ring buffer and never shrunk (flow 263).
 *
 * `shell_exec` returns the synchronous-shaped result for a command that exits
 * within its yield, and that result is capped FROM THE START (the model must
 * see a compiler's first errors, not the last lines of a 30 KB dump). The ring
 * buffer cannot serve it: `shrinkTerminatedOutput` keeps the TAIL, and it runs
 * inside `onExit`, before the caller that was awaiting the task can read
 * anything. So the head is snapshotted as output arrives.
 *
 * Sized a little above the tool's own 20 KB cap so `shell_exec` can still tell
 * a truncated transcript from one that merely fills the cap exactly.
 */
export const TASK_OUTPUT_HEAD_BYTES = 24_000;

/**
 * Lifecycle/output events the TUI bridge subscribes to.
 *
 * The `phase` event is what makes a task VISIBLE in the TUI task list: the
 * store lists a task only once it is running in the background, so a
 * foreground task the caller is still awaiting never flickers into the list.
 * It fires at most ONCE per task — either right after `start` for a
 * background-phase start, or at `promote()` for a foreground one.
 */
export type BackgroundJobEvent =
  | { type: "start"; jobId: string; pid: number; command: string; startedAt: string; description?: string }
  | { type: "phase"; jobId: string; phase: "background" }
  | { type: "output"; jobId: string; chunk: string; stream: "stdout" | "stderr" }
  | {
      type: "exit";
      jobId: string;
      status: "completed" | "failed" | "killed";
      killReason?: KillReason;
      exitCode?: number;
      endedAt: string;
    };

/** Options for a single {@link JobRegistry.start}. */
export interface StartTaskOptions {
  /** Defaults to `"background"`, preserving flow-173 semantics for direct callers. */
  phase?: "foreground" | "background";
  description?: string;
  /**
   * Per-task idle timeout in ms, stored AS GIVEN (clamping is the caller's
   * job — `shell_exec` applies {@link clampTaskIdleTimeoutMs} so the model
   * cannot disable the rail, while an internal caller may legitimately pass
   * `0` to disable it). Falls back to the registry-wide `idleMs`.
   */
  idleTimeoutMs?: number;
}

/**
 * What `drainUndelivered` hands the agent loop for one finished task (flow 265).
 *
 * Self-contained on purpose: the notification is rendered from this record
 * alone, so the builder never has to reach back into the registry for a task
 * that may have been evicted by the time the message is written.
 */
export interface TaskCompletion {
  jobId: string;
  status: "completed" | "failed" | "killed";
  killReason?: KillReason;
  exitCode?: number;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  /** Retained output: the ring's tail, falling back to the head snapshot. */
  output: string;
}

export interface JobRegistry {
  start(
    command: string,
    opts?: StartTaskOptions,
  ): Promise<{ ok: true; jobId: string; pid: number; output: string } | { ok: false; error: string }>;
  get(jobId: string): BackgroundJobInfo | undefined;
  list(): BackgroundJobInfo[];
  readOutput(jobId: string): { ok: true; output: string } | { ok: false; error: string };
  /**
   * Wait up to `ms` for a task to finish. Never kills on timeout — the caller
   * decides what to do (`shell_exec` promotes the task to background).
   * `"unknown"` means this registry never tracked that id.
   */
  waitForExit(jobId: string, ms: number): Promise<"exited" | "timeout" | "unknown">;
  /**
   * Move a still-running foreground task to the background. Never kills and
   * never refuses on a full concurrency cap — a task that is already running
   * cannot be un-started, so the cap is reported via `overCap` (naming the
   * other running background commands) rather than enforced destructively.
   */
  promote(jobId: string): { ok: true; overCap?: string } | { ok: false; error: string };
  kill(jobId: string, reason?: KillReason): Promise<{ ok: true } | { ok: false; error: string }>;
  sweepAll(): Promise<void>;
  /**
   * Every task that is terminal, was handed back as a handle (`background`
   * phase) and has not been observed — marked observed IN THE SAME synchronous
   * step, so a concurrent or replayed drain returns nothing twice (N5).
   *
   * A foreground task that exited inside its caller's yield is never returned:
   * that caller already got the result, so a notification would be a second
   * copy of something the agent read.
   */
  drainUndelivered(): TaskCompletion[];
  /**
   * Fires once per task reaching a terminal status, so an idle shell can wake
   * without polling. Returns an unsubscribe. This is the wake signal only —
   * WHAT gets delivered is decided by `drainUndelivered`, which is what keeps
   * "woken" and "delivered" from drifting apart.
   */
  onCompletion(listener: (jobId: string) => void): () => void;
}

/** Env override for the per-task idle timeout. */
export const ENV_SHELL_IDLE_MS = "KERYX_SHELL_IDLE_MS";

/**
 * Deprecated predecessor of {@link ENV_SHELL_IDLE_MS}: flow 263 replaced
 * `shell_exec`'s hard deadline with an idle timeout, so an operator who had
 * already tuned the old knob keeps their setting.
 *
 * Spelled out rather than imported from `shell-exec-tool.ts`: that module
 * imports THIS one (it is the registry's consumer), so importing the constant
 * back would close an import cycle.
 */
const ENV_SHELL_TIMEOUT_MS_FALLBACK = "KERYX_SHELL_TIMEOUT_MS";

/**
 * Default idle timeout: a task silent for two minutes is presumed stuck.
 * Unlike flow 173's total-runtime deadline, this measures time since the LAST
 * OUTPUT, so a long-but-chatty build is never killed for being slow.
 */
export const DEFAULT_SHELL_IDLE_MS = 120_000;

/** Lower bound for a model-supplied per-task idle timeout. */
export const MIN_TASK_IDLE_TIMEOUT_MS = 1_000;

/** Upper bound (30 min) for a model-supplied per-task idle timeout. */
export const MAX_TASK_IDLE_TIMEOUT_MS = 1_800_000;

function parseEnvMs(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim().length === 0) return undefined;
  const n = Number.parseInt(raw.trim(), 10);
  // Malformed/negative is NOT "disabled" — the caller falls back to the
  // default, mirroring `resolveShellTimeoutMs`. An explicit `0` disables.
  if (!Number.isFinite(n) || n < 0) return Number.NaN;
  return n;
}

/**
 * Resolve the registry-wide idle timeout. Unset/empty {@link ENV_SHELL_IDLE_MS}
 * falls back to the deprecated `KERYX_SHELL_TIMEOUT_MS` under the same
 * fail-safe rules, then to {@link DEFAULT_SHELL_IDLE_MS}. A MALFORMED
 * `KERYX_SHELL_IDLE_MS` goes straight to the default — it does not fall
 * through to the deprecated variable, so a typo in the current knob can never
 * be silently answered by a stale one.
 */
export function resolveShellIdleMs(env: Record<string, string | undefined> = process.env): number {
  const idle = parseEnvMs(env[ENV_SHELL_IDLE_MS]);
  if (idle !== undefined) {
    return Number.isNaN(idle) ? DEFAULT_SHELL_IDLE_MS : idle;
  }
  const legacy = parseEnvMs(env[ENV_SHELL_TIMEOUT_MS_FALLBACK]);
  if (legacy !== undefined) {
    return Number.isNaN(legacy) ? DEFAULT_SHELL_IDLE_MS : legacy;
  }
  return DEFAULT_SHELL_IDLE_MS;
}

/**
 * Clamp a model-supplied per-task idle timeout into
 * [{@link MIN_TASK_IDLE_TIMEOUT_MS}, {@link MAX_TASK_IDLE_TIMEOUT_MS}].
 * Note the floor: the model cannot pass `0` to disable the idle rail on its
 * own task, only shorten or lengthen it within bounds.
 */
export function clampTaskIdleTimeoutMs(ms: number): number {
  if (!Number.isFinite(ms)) return MIN_TASK_IDLE_TIMEOUT_MS;
  return Math.min(MAX_TASK_IDLE_TIMEOUT_MS, Math.max(MIN_TASK_IDLE_TIMEOUT_MS, Math.trunc(ms)));
}

interface InternalJob {
  info: BackgroundJobInfo;
  handle: BackgroundProcessHandle;
  outputBuffer: string;
  readCursor: number;
  exited: boolean;
  /**
   * First {@link TASK_OUTPUT_HEAD_BYTES} of the transcript, mirrored into
   * `info.outputHead`. Append-only: never rebased by the ring's truncation and
   * never shrunk on exit, because it is what the synchronous-shaped result of
   * a short command is built from.
   */
  outputHead: string;
  /**
   * Set the moment a kill is requested for this task (flow 173 F-007). The
   * real `onExit` handler consults this to report status `"killed"` whenever
   * it is set, regardless of which signal (SIGTERM/SIGKILL) actually ended the
   * process and regardless of the exit CODE — the common case (SIGTERM alone
   * succeeds) previously fell through to a natural-exit status,
   * indistinguishable from a command that finished on its own.
   */
  killRequested: boolean;
  /**
   * Why the kill was requested, recorded at REQUEST time and applied to
   * `info.killReason` once the process actually dies — the reason is known by
   * the caller that asked, not by `onExit`, which only sees an exit code.
   */
  pendingKillReason?: KillReason;
  /**
   * At most one `phase` event is ever emitted per task (the TUI store uses it
   * as the "now list this task" signal, so a repeat would duplicate a row).
   */
  phaseEmitted: boolean;
  /**
   * Armed on start, reset on every output chunk, cleared on exit. Explicitly
   * `| undefined`: `clearIdleTimer` assigns `undefined` to disarm, which
   * `exactOptionalPropertyTypes` forbids for a bare optional property.
   */
  idleTimer?: ReturnType<typeof setTimeout> | undefined;
  resolveExited: () => void;
  exitedPromise: Promise<void>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * The real default spawner: a detached `sh -c <command>` subprocess, spawned
 * through the SAME `resolveShellEnv`/`resolveSandboxedSpawn` pipeline
 * `shell-exec-tool.ts`'s synchronous path uses (flow 173 F-001/F-014) — same
 * saved-API-key env, same OS-sandbox posture, same fail-closed refusal when a
 * requested sandbox launcher is unavailable (thrown here as an `Error`;
 * `JobRegistry.start()` catches it and turns it into a normal `{ok:false}`
 * tool result, never an unhandled rejection).
 *
 * `detached: true` makes the (possibly sandbox-wrapped) direct child its own
 * process-group leader (see this module's header comment) — required for
 * {@link JobRegistry.kill}/`sweepAll` to be able to reach a grandchild the
 * direct child backgrounded and forgot about.
 */
function realSpawner(): BackgroundSpawner {
  return async (command, cwd) => {
    const baseEnv = await resolveShellEnv();
    const resolved = await resolveShellSpawn(cwd, command, baseEnv);
    if (!resolved.ok) {
      throw new Error(resolved.error);
    }
    const { spawnArgs, env, netClose } = resolved.plan;

    const proc = Bun.spawn(spawnArgs, {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
      env,
      detached: true,
    });

    let dataCb: ((chunk: string, stream: "stdout" | "stderr") => void) | undefined;
    let exitCb: ((info: { exitCode: number }) => void) | undefined;

    let netClosed = false;
    const closeNetOnce = async (): Promise<void> => {
      if (netClosed) return;
      netClosed = true;
      await netClose();
    };

    // F-017: one decoder PER STREAM. A single shared decoder across both
    // stdout/stderr pump loops retains streaming multi-byte state per call —
    // interleaved stdout/stderr chunks can then corrupt multi-byte UTF-8
    // (mirrors `shell-exec-tool.ts`'s own `readInto`, which already gets this
    // right with one decoder per `readInto` call).
    const outDecoder = new TextDecoder();
    const errDecoder = new TextDecoder();

    const pump = async (
      stream: ReadableStream<Uint8Array> | undefined,
      kind: "stdout" | "stderr",
      decoder: TextDecoder,
    ): Promise<void> => {
      if (stream === undefined) return;
      const reader = stream.getReader();
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          if (chunk.value !== undefined) dataCb?.(decoder.decode(chunk.value, { stream: true }), kind);
        }
      } catch {
        // pipe torn down by a kill — nothing further to read
      } finally {
        reader.releaseLock();
      }
    };
    void Promise.all([pump(proc.stdout, "stdout", outDecoder), pump(proc.stderr, "stderr", errDecoder)]);
    void proc.exited.then(async (exitCode) => {
      exitCb?.({ exitCode });
      await closeNetOnce();
    });

    return {
      pid: proc.pid,
      onOutput: (cb) => {
        dataCb = cb;
      },
      onExit: (cb) => {
        exitCb = cb;
      },
      kill: (signal) => {
        try {
          // Negative PID: signal the whole process GROUP, not just this PID.
          process.kill(-proc.pid, signal);
        } catch {
          // already gone
        }
      },
    };
  };
}

export function createJobRegistry(options?: {
  cwd?: string;
  maxConcurrent?: number;
  spawn?: BackgroundSpawner;
  killGraceMs?: number;
  initialBufferMs?: number;
  onEvent?: (event: BackgroundJobEvent) => void;
  /** Override for {@link MAX_TRACKED_JOBS} (tests only; production uses the default). */
  maxTrackedJobs?: number;
  /** Registry-wide default idle timeout; `0` disables the idle rail. */
  idleMs?: number;
}): JobRegistry {
  const cwd = options?.cwd ?? process.cwd();
  const maxConcurrent = options?.maxConcurrent ?? resolveMaxConcurrentBackgroundJobs();
  const spawn = options?.spawn ?? realSpawner();
  const killGraceMs = options?.killGraceMs ?? BACKGROUND_KILL_GRACE_MS;
  const initialBufferMs = options?.initialBufferMs ?? DEFAULT_INITIAL_BUFFER_MS;
  const onEvent = options?.onEvent;
  const maxTrackedJobs = options?.maxTrackedJobs ?? MAX_TRACKED_JOBS;
  const idleMs = options?.idleMs ?? resolveShellIdleMs();

  /**
   * Flow 265: wake subscribers. Separate from `onEvent` (the TUI store feed) on
   * purpose — `onEvent` is a firehose of start/phase/output/exit, while this
   * fires exactly once per task reaching a terminal status, which is the only
   * thing a shell needs in order to decide whether to start a turn.
   */
  const completionListeners = new Set<(jobId: string) => void>();

  let nextId = 0;
  const jobs = new Map<string, InternalJob>();

  function runningJobs(): InternalJob[] {
    return [...jobs.values()].filter((j) => j.info.status === "running");
  }

  /**
   * The concurrency cap counts BACKGROUND-phase running tasks only. A
   * foreground task has a caller blocked on it, so it is bounded by that
   * caller's own wait — counting it would let a couple of ordinary
   * `shell_exec` calls refuse every long-running server the model tries to
   * start.
   */
  function backgroundRunningJobs(): InternalJob[] {
    return runningJobs().filter((j) => j.info.phase === "background");
  }

  function clearIdleTimer(job: InternalJob): void {
    if (job.idleTimer === undefined) return;
    clearTimeout(job.idleTimer);
    job.idleTimer = undefined;
  }

  /**
   * (Re)arm the per-task idle rail. Called on start and after every output
   * chunk, so the timeout measures SILENCE, not total runtime.
   */
  function armIdleTimer(job: InternalJob): void {
    clearIdleTimer(job);
    if (job.info.status !== "running") return;
    const timeout = job.info.idleTimeoutMs;
    if (timeout <= 0) return; // explicitly disabled
    const timer = setTimeout(() => {
      void requestKill(job, "idle");
    }, timeout);
    // A pending idle timer must never hold the process open on its own (a
    // default 120 s timer would otherwise keep a finished CLI run or test
    // worker alive). `unref` is Node/Bun-only and absent on an injected fake.
    (timer as { unref?: () => void }).unref?.();
    job.idleTimer = timer;
  }

  /**
   * F-009: evict the OLDEST terminated (non-running) entries once total
   * tracked jobs exceed `maxTrackedJobs` — insertion order (`Map` preserves
   * it), never a running job. Called after adding a new job, so a session
   * that starts many short-lived jobs over time does not accumulate an
   * unbounded `jobs` Map.
   */
  function evictOldestTerminatedIfOverCap(): void {
    if (jobs.size <= maxTrackedJobs) return;
    for (const [id, job] of jobs) {
      if (jobs.size <= maxTrackedJobs) break;
      if (job.info.status === "running") continue;
      jobs.delete(id);
    }
  }

  /**
   * F-009: once a job's final `exit` event has been delivered, shrink its
   * `outputBuffer` to a small tail rather than letting a long, chatty job's
   * buffer (up to {@link MAX_BACKGROUND_OUTPUT_BYTES}) linger forever. Rebases
   * `readCursor` by the same amount dropped (mirrors the F-005 fix in
   * `appendOutput` below) so a caller that has not yet read everything still
   * sees a consistent, non-negative cursor rather than skipped/blanked output.
   */
  function shrinkTerminatedOutput(job: InternalJob): void {
    if (job.outputBuffer.length <= TERMINATED_OUTPUT_TAIL_BYTES) return;
    const dropped = job.outputBuffer.length - TERMINATED_OUTPUT_TAIL_BYTES;
    job.outputBuffer = job.outputBuffer.slice(dropped);
    job.readCursor = Math.max(0, job.readCursor - dropped);
  }

  function appendOutput(job: InternalJob, chunk: string, stream: "stdout" | "stderr"): void {
    job.outputBuffer += chunk;
    if (job.outputHead.length < TASK_OUTPUT_HEAD_BYTES) {
      job.outputHead = (job.outputHead + chunk).slice(0, TASK_OUTPUT_HEAD_BYTES);
      job.info.outputHead = job.outputHead;
    }
    armIdleTimer(job); // any output proves the task is alive
    onEvent?.({ type: "output", jobId: job.info.jobId, chunk, stream });
    if (job.outputBuffer.length > MAX_BACKGROUND_OUTPUT_BYTES) {
      // Auto-kill rail (see MAX_BACKGROUND_OUTPUT_BYTES doc comment): an
      // unbounded buffer is a real memory-growth risk for a long-lived,
      // chatty job. Truncate what we keep and terminate the job; the caller
      // still gets everything up to the cap via readOutput.
      //
      // F-005: re-base `readCursor` by exactly what was dropped, not just the
      // buffer itself — otherwise a cursor that pointed past the new (shorter)
      // buffer silently skips or blanks output on the very next readOutput
      // call, right when a job is being force-killed.
      const dropped = job.outputBuffer.length - MAX_BACKGROUND_OUTPUT_BYTES;
      job.outputBuffer = job.outputBuffer.slice(dropped);
      job.readCursor = Math.max(0, job.readCursor - dropped);

      // F-013: only issue ONE auto-kill per job. The status doesn't flip off
      // "running" until the kill actually lands, so without this guard every
      // subsequent over-cap chunk arriving during the SIGTERM grace window
      // would re-enter this branch and re-fire terminateJob. Shares the same
      // `killRequested` flag F-007 uses to disambiguate a killed job from a
      // naturally-exited one.
      void requestKill(job, "output-cap");
    }
  }

  /**
   * Single entry point for every kill path (model, operator, idle rail,
   * output-cap rail, session sweep). Idempotent: the FIRST reason wins and a
   * repeat request simply awaits the in-flight termination, which is what
   * keeps `exit` to exactly one event per task (F-013).
   */
  function requestKill(job: InternalJob, reason: KillReason): Promise<void> {
    if (job.info.status !== "running") return Promise.resolve();
    if (job.killRequested) return job.exitedPromise;
    job.killRequested = true;
    job.pendingKillReason = reason;
    return terminateJob(job, killGraceMs);
  }

  async function terminateJob(job: InternalJob, graceMs: number): Promise<void> {
    if (job.info.status !== "running") return;
    clearIdleTimer(job); // the task is on its way out; the rail must not fire too
    // F-007: mark BEFORE signaling — the real `onExit` handler consults this
    // to report "killed" (not "exited") whenever it is set, regardless of
    // which signal actually ended the process. This also doubles as the
    // F-013 re-entrancy guard in `appendOutput` above (both callers may set
    // it; `terminateJob` itself is idempotent via the `status !== "running"`
    // guard at the top of this function).
    job.killRequested = true;
    job.handle.kill("SIGTERM");
    const exited = await Promise.race([job.exitedPromise.then(() => true), sleep(graceMs).then(() => false)]);
    if (!exited && job.info.status === "running") {
      job.handle.kill("SIGKILL");
      // Status + the `exit` event are reported EXCLUSIVELY by the real
      // `onExit` handler once the process actually dies (see `start()`
      // below) — no speculative status write or duplicate `exit` event here
      // (F-007: the old code force-set status/emitted `exit` itself in this
      // branch, which could double-emit alongside the real `onExit` firing
      // moments later).
    }
  }

  return {
    async start(command, opts) {
      const phase = opts?.phase ?? "background";

      // The cap applies to background starts only, and counts only
      // background-phase running tasks (see `backgroundRunningJobs`).
      if (phase === "background") {
        const running = backgroundRunningJobs();
        if (running.length >= maxConcurrent) {
          const names = running.map((j) => j.info.command).join(", ");
          return {
            ok: false,
            error: `background task limit reached (${maxConcurrent} running: ${names}); wait for one to finish or kill it with shell_job_kill first`,
          };
        }
      }

      let handle: BackgroundProcessHandle;
      try {
        handle = await spawn(command, cwd);
      } catch (cause) {
        return {
          ok: false,
          error: `command failed to start: ${cause instanceof Error ? cause.message : String(cause)}`,
        };
      }

      const jobId = `task-${++nextId}-${handle.pid}`;
      let resolveExited!: () => void;
      const exitedPromise = new Promise<void>((resolve) => {
        resolveExited = resolve;
      });
      const job: InternalJob = {
        info: {
          jobId,
          pid: handle.pid,
          command,
          status: "running",
          phase,
          // Stored AS GIVEN — clamping belongs to the caller (see
          // StartTaskOptions.idleTimeoutMs).
          idleTimeoutMs: opts?.idleTimeoutMs ?? idleMs,
          observed: false,
          startedAt: nowIso(),
        },
        handle,
        outputBuffer: "",
        outputHead: "",
        readCursor: 0,
        exited: false,
        killRequested: false,
        phaseEmitted: false,
        resolveExited,
        exitedPromise,
      };
      if (opts?.description !== undefined) job.info.description = opts.description;
      jobs.set(jobId, job);
      evictOldestTerminatedIfOverCap();
      onEvent?.({
        type: "start",
        jobId,
        pid: handle.pid,
        command,
        startedAt: job.info.startedAt,
        ...(opts?.description !== undefined ? { description: opts.description } : {}),
      });
      // A background-phase start is already "in the background" — emit its one
      // phase event now so the TUI lists it. A foreground start emits none
      // until (and unless) it is promoted.
      if (phase === "background") {
        job.phaseEmitted = true;
        onEvent?.({ type: "phase", jobId, phase: "background" });
      }

      handle.onOutput((chunk, stream) => appendOutput(job, chunk, stream));
      handle.onExit((info) => {
        if (job.exited) return;
        job.exited = true;
        clearIdleTimer(job);
        // F-007: a task with a kill requested reports "killed" whenever
        // killRequested is set, regardless of which signal actually ended the
        // process (SIGTERM alone succeeding is the COMMON case) and
        // regardless of the code it died with. Otherwise the exit CODE splits
        // a natural exit into completed (0) vs failed (non-zero).
        const terminal: "completed" | "failed" | "killed" = job.killRequested
          ? "killed"
          : info.exitCode === 0
            ? "completed"
            : "failed";
        job.info.status = terminal;
        if (job.killRequested) {
          job.info.killReason = job.pendingKillReason ?? "model";
        }
        job.info.exitCode = info.exitCode;
        job.info.endedAt = nowIso();
        job.resolveExited();
        onEvent?.({
          type: "exit",
          jobId,
          status: terminal,
          ...(job.info.killReason !== undefined ? { killReason: job.info.killReason } : {}),
          exitCode: info.exitCode,
          endedAt: job.info.endedAt,
        });
        // F-009: shrink the buffer only AFTER the final exit event has been
        // delivered — a caller polling shell_job_output has by now seen (or
        // had the chance to see) everything up to this point.
        shrinkTerminatedOutput(job);
        // Flow 265: the wake signal, fired after the exit event and the shrink
        // so a listener that immediately drains sees the final record. The
        // `job.exited` guard at the top of this handler is what keeps a repeat
        // exit from the process from producing a second notification.
        for (const listener of completionListeners) {
          try {
            listener(jobId);
          } catch {
            // A subscriber that throws must not break the output pump or the
            // other subscribers — same rule the TUI bridge already follows.
          }
        }
      });

      armIdleTimer(job);

      // Only a background start buffers early output: a foreground caller is
      // about to await the task itself, so delaying its return would add the
      // buffer window to EVERY ordinary shell_exec.
      if (phase === "background" && initialBufferMs > 0) {
        await sleep(initialBufferMs);
      }
      const output = job.outputBuffer.slice(job.readCursor);
      job.readCursor = job.outputBuffer.length;
      return { ok: true, jobId, pid: handle.pid, output };
    },

    get(jobId) {
      return jobs.get(jobId)?.info;
    },

    list() {
      return [...jobs.values()].map((j) => j.info);
    },

    readOutput(jobId) {
      const job = jobs.get(jobId);
      if (job === undefined) {
        return { ok: false, error: `unknown job_id: ${jobId}` };
      }
      const output = job.outputBuffer.slice(job.readCursor);
      job.readCursor = job.outputBuffer.length;
      // Flow 265: reading a task that has ALREADY finished is the delivery —
      // the agent asked and was told. Reading one that is still running is
      // not: nothing about its outcome was reported, so it must still produce
      // a notification when it ends.
      if (job.info.status !== "running") {
        job.info.observed = true;
      }
      return { ok: true, output };
    },

    async waitForExit(jobId, ms) {
      const job = jobs.get(jobId);
      if (job === undefined) return "unknown";
      // An already-finished task resolves at once — a caller must never wait
      // out the full window for a task that is already gone.
      if (job.exited || job.info.status !== "running") return "exited";

      let timer: ReturnType<typeof setTimeout> | undefined;
      const timedOut = await Promise.race([
        job.exitedPromise.then(() => false),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(true), ms);
          (timer as { unref?: () => void }).unref?.();
        }),
      ]);
      if (timer !== undefined) clearTimeout(timer);
      // A timeout NEVER kills: the caller decides (shell_exec promotes).
      return timedOut ? "timeout" : "exited";
    },

    promote(jobId) {
      const job = jobs.get(jobId);
      if (job === undefined) {
        return { ok: false, error: `unknown job_id: ${jobId}` };
      }
      job.info.phase = "background";
      if (!job.phaseEmitted) {
        job.phaseEmitted = true;
        onEvent?.({ type: "phase", jobId, phase: "background" });
      }
      // A running task cannot be un-started, so an over-cap promote is
      // REPORTED, never refused or killed. This is the one path by which
      // running background tasks can exceed `maxConcurrent` — bounded,
      // because every subsequent background start is still refused.
      const others = backgroundRunningJobs().filter((j) => j.info.jobId !== jobId);
      if (job.info.status === "running" && others.length >= maxConcurrent) {
        return { ok: true, overCap: others.map((j) => j.info.command).join(", ") };
      }
      return { ok: true };
    },

    async kill(jobId, reason = "model") {
      const job = jobs.get(jobId);
      if (job === undefined) {
        return { ok: false, error: `unknown job_id: ${jobId}` };
      }
      if (job.info.status !== "running") {
        return { ok: false, error: `job ${jobId} is not running (status: ${job.info.status})` };
      }
      await requestKill(job, reason);
      // Flow 265: whoever asked for this kill has their answer — the model
      // through `shell_job_kill`, the operator through the inspector — so the
      // outcome needs no second delivery. The rails (`idle`, `output-cap`) and
      // the session sweep go through `requestKill` directly and are NOT marked
      // here: nobody asked for those, so they still notify.
      job.info.observed = true;
      return { ok: true };
    },

    async sweepAll() {
      // Foreground tasks are swept too: at session exit nobody is left to
      // await them, so an unswept one would outlive the session.
      await Promise.all(runningJobs().map((job) => requestKill(job, "session-exit")));
    },

    drainUndelivered() {
      const drained: TaskCompletion[] = [];
      for (const job of jobs.values()) {
        const info = job.info;
        if (info.status === "running" || info.observed) continue;
        // A foreground task that exited inside its caller's yield was already
        // reported to the agent as that call's result; only a task handed back
        // as a handle can still be waiting to be told about.
        if (info.phase !== "background") continue;
        const endedAt = info.endedAt ?? nowIso();
        const durationMs = Math.max(0, Date.parse(endedAt) - Date.parse(info.startedAt));
        // Marked in the SAME synchronous pass as the read: nothing awaits
        // between the filter and the write, so a concurrent drain cannot see
        // this task unobserved and return it twice (N5).
        info.observed = true;
        drained.push({
          jobId: info.jobId,
          status: info.status,
          ...(info.killReason !== undefined ? { killReason: info.killReason } : {}),
          ...(info.exitCode !== undefined ? { exitCode: info.exitCode } : {}),
          startedAt: info.startedAt,
          endedAt,
          durationMs,
          // The ring holds the tail (shrunk on exit); the head snapshot is the
          // fallback for a task whose ring was emptied by a reader.
          output: job.outputBuffer.length > 0 ? job.outputBuffer : job.outputHead,
        });
      }
      return drained;
    },

    onCompletion(listener) {
      completionListeners.add(listener);
      return () => {
        completionListeners.delete(listener);
      };
    },
  };
}

/**
 * `shell_job_output(job_id)` — risk `read`: incremental, cursor-based, never a
 * full re-dump. Reads any supervised task, whether it started in the
 * background or was promoted there after outliving its caller's wait.
 */
export function shellJobOutputTool(registry: JobRegistry): InteractiveTool {
  return {
    definition: {
      name: "shell_job_output",
      description:
        "Return output produced by a shell task SINCE the previous call for that id — never the full transcript " +
        "again. Input: { job_id: string } — pass the task_id shell_exec returned for a command that outlived its " +
        "yield (or a background:true job). Poll this instead of re-running shell_exec to check on a long command.",
      inputSchema: {
        type: "object",
        properties: { job_id: { type: "string" } },
        required: ["job_id"],
        additionalProperties: false,
      },
      risk: "read",
    },
    invoke: async (input): Promise<InteractiveToolResult> => {
      const jobId = typeof input.job_id === "string" ? input.job_id : "";
      if (jobId.length === 0) {
        return { output: "shell_job_output requires a non-empty 'job_id'", isError: true };
      }
      const result = registry.readOutput(jobId);
      if (!result.ok) {
        return { output: result.error, isError: true };
      }
      return { output: result.output, isError: false };
    },
  };
}

/**
 * `shell_job_kill(job_id)` — risk `read` (no approval): process-group kill,
 * scoped to this session's own registry. Records kill reason `"model"`, which
 * is what distinguishes it in the task list from a task the idle/output-cap
 * rails or the session sweep ended.
 */
export function shellJobKillTool(registry: JobRegistry): InteractiveTool {
  return {
    definition: {
      name: "shell_job_kill",
      description:
        "Stop a running shell task — its entire process group, including any descendant it backgrounded. Input: " +
        "{ job_id: string } — the task_id shell_exec returned for a command still running after its yield (or a " +
        "background:true job). Only tasks in this session's own registry can be targeted.",
      inputSchema: {
        type: "object",
        properties: { job_id: { type: "string" } },
        required: ["job_id"],
        additionalProperties: false,
      },
      risk: "read",
    },
    invoke: async (input): Promise<InteractiveToolResult> => {
      const jobId = typeof input.job_id === "string" ? input.job_id : "";
      if (jobId.length === 0) {
        return { output: "shell_job_kill requires a non-empty 'job_id'", isError: true };
      }
      const result = await registry.kill(jobId);
      if (!result.ok) {
        return { output: result.error, isError: true };
      }
      return { output: `job ${jobId} killed`, isError: false };
    },
  };
}
