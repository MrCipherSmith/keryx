// Session-scoped background job registry (flow 173, T2/T3): the harness-side
// half of `shell_exec({background:true})`. Sibling of `shell-exec-tool.ts`.
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
import { resolveSandboxedSpawn, resolveShellEnv } from "./shell-exec-tool";

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

/** Public, session-visible snapshot of a tracked job. */
export interface BackgroundJobInfo {
  jobId: string;
  pid: number;
  command: string;
  status: "running" | "exited" | "killed";
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

/** Lifecycle/output events for a future TUI bridge to subscribe to (not consumed here — T4/T5 is a separate task). */
export type BackgroundJobEvent =
  | { type: "start"; jobId: string; pid: number; command: string; startedAt: string }
  | { type: "output"; jobId: string; chunk: string; stream: "stdout" | "stderr" }
  | { type: "exit"; jobId: string; status: "exited" | "killed"; exitCode?: number; endedAt: string };

export interface JobRegistry {
  start(
    command: string,
  ): Promise<{ ok: true; jobId: string; pid: number; output: string } | { ok: false; error: string }>;
  get(jobId: string): BackgroundJobInfo | undefined;
  list(): BackgroundJobInfo[];
  readOutput(jobId: string): { ok: true; output: string } | { ok: false; error: string };
  kill(jobId: string): Promise<{ ok: true } | { ok: false; error: string }>;
  sweepAll(): Promise<void>;
}

interface InternalJob {
  info: BackgroundJobInfo;
  handle: BackgroundProcessHandle;
  outputBuffer: string;
  readCursor: number;
  exited: boolean;
  /**
   * Set the moment `terminateJob` is called for this job (flow 173 F-007).
   * The real `onExit` handler consults this to report status `"killed"`
   * whenever it is set, regardless of which signal (SIGTERM/SIGKILL) actually
   * ended the process — the common case (SIGTERM alone succeeds) previously
   * fell through to `onExit`'s default `"exited"`, indistinguishable from a
   * natural exit.
   */
  killRequested: boolean;
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
    const resolved = await resolveSandboxedSpawn(cwd, command, baseEnv);
    if (!resolved.ok) {
      throw new Error(resolved.result.output);
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
}): JobRegistry {
  const cwd = options?.cwd ?? process.cwd();
  const maxConcurrent = options?.maxConcurrent ?? resolveMaxConcurrentBackgroundJobs();
  const spawn = options?.spawn ?? realSpawner();
  const killGraceMs = options?.killGraceMs ?? BACKGROUND_KILL_GRACE_MS;
  const initialBufferMs = options?.initialBufferMs ?? DEFAULT_INITIAL_BUFFER_MS;
  const onEvent = options?.onEvent;
  const maxTrackedJobs = options?.maxTrackedJobs ?? MAX_TRACKED_JOBS;

  let nextId = 0;
  const jobs = new Map<string, InternalJob>();

  function runningJobs(): InternalJob[] {
    return [...jobs.values()].filter((j) => j.info.status === "running");
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
      if (!job.killRequested) {
        job.killRequested = true;
        void terminateJob(job, killGraceMs);
      }
    }
  }

  async function terminateJob(job: InternalJob, graceMs: number): Promise<void> {
    if (job.info.status !== "running") return;
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
    async start(command) {
      const running = runningJobs();
      if (running.length >= maxConcurrent) {
        const names = running.map((j) => j.info.command).join(", ");
        return {
          ok: false,
          error: `background job limit reached (${maxConcurrent} running: ${names}); wait for one to finish or kill it with shell_job_kill first`,
        };
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

      const jobId = `job-${++nextId}-${handle.pid}`;
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
          startedAt: nowIso(),
        },
        handle,
        outputBuffer: "",
        readCursor: 0,
        exited: false,
        killRequested: false,
        resolveExited,
        exitedPromise,
      };
      jobs.set(jobId, job);
      evictOldestTerminatedIfOverCap();
      onEvent?.({ type: "start", jobId, pid: handle.pid, command, startedAt: job.info.startedAt });

      handle.onOutput((chunk, stream) => appendOutput(job, chunk, stream));
      handle.onExit((info) => {
        if (job.exited) return;
        job.exited = true;
        if (job.info.status === "running") {
          // F-007: a job killed via terminateJob reports "killed" here
          // whenever killRequested is set, regardless of which signal
          // actually ended the process (SIGTERM alone succeeding is the
          // COMMON case and was previously mis-reported as "exited").
          job.info.status = job.killRequested ? "killed" : "exited";
        }
        job.info.exitCode = info.exitCode;
        job.info.endedAt = nowIso();
        job.resolveExited();
        onEvent?.({
          type: "exit",
          jobId,
          status: job.info.status,
          exitCode: info.exitCode,
          endedAt: job.info.endedAt,
        });
        // F-009: shrink the buffer only AFTER the final exit event has been
        // delivered — a caller polling shell_job_output has by now seen (or
        // had the chance to see) everything up to this point.
        shrinkTerminatedOutput(job);
      });

      if (initialBufferMs > 0) {
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
      return { ok: true, output };
    },

    async kill(jobId) {
      const job = jobs.get(jobId);
      if (job === undefined) {
        return { ok: false, error: `unknown job_id: ${jobId}` };
      }
      if (job.info.status !== "running") {
        return { ok: false, error: `job ${jobId} is not running (status: ${job.info.status})` };
      }
      await terminateJob(job, killGraceMs);
      return { ok: true };
    },

    async sweepAll() {
      await Promise.all(runningJobs().map((job) => terminateJob(job, killGraceMs)));
    },
  };
}

/** `shell_job_output(job_id)` — risk `read`: incremental, cursor-based, never a full re-dump. */
export function shellJobOutputTool(registry: JobRegistry): InteractiveTool {
  return {
    definition: {
      name: "shell_job_output",
      description:
        "Return output produced by a background job (started via shell_exec with background:true) SINCE the " +
        "previous call for that job_id — never the full transcript again. Input: { job_id: string }. Poll this " +
        "instead of re-running shell_exec to check on a long-running job.",
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

/** `shell_job_kill(job_id)` — risk `read` (no approval): process-group kill, scoped to this session's own registry. */
export function shellJobKillTool(registry: JobRegistry): InteractiveTool {
  return {
    definition: {
      name: "shell_job_kill",
      description:
        "Kill a background job started via shell_exec with background:true (its entire process group, including " +
        "any descendant it backgrounded). Input: { job_id: string }. Only jobs in this session's own registry can " +
        "be targeted.",
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
