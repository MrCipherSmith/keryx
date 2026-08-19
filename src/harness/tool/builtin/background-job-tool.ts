// Background job/watcher tools for interactive agent mode (flow 174).
//
// `start_job` and `watch_job` are the async counterparts to `shell_exec`: they
// return immediately instead of awaiting completion, so a long-lived process
// (a watch-mode test run, a dev server, a log tail) can run alongside the
// agent's own turn. `job_output`/`list_jobs` inspect them on demand;
// `stop_job` terminates one. All of it is a straight port of Claude Code's own
// `Bash(run_in_background)` / `Monitor` / `TaskOutput` / `TaskStop` primitives
// onto keryx's tool surface, with ONE deliberate divergence: an event never
// pushes into the transcript by itself (no host-level chat notification here)
// — it only updates the sidebar via `job-bridge.ts`. The agent decides when to
// call `job_output` and look.
//
// Security: both `start_job` and `watch_job` go through the EXACT SAME
// `prepareCommandSpawn` (env + `KERYX_SANDBOX_SHELL` posture) that
// `shell-exec-tool.ts` uses, and both are risk `"shell"` — a background
// command must never get a weaker approval/sandbox posture than a synchronous
// one. `stop_job` is also risk `"shell"`, but its `id` input only ever
// resolves to a process THIS session's own `start_job`/`watch_job` started —
// never an arbitrary PID.

import type { InteractiveTool, InteractiveToolResult } from "./interactive-tools";
import { prepareCommandSpawn } from "./shell-exec-tool";
import { emitJobFleet } from "../../../tui/job-bridge";

/** Minimal shape this module needs from a spawned process — satisfied by `Bun.Subprocess`. */
export interface JobProcess {
  readonly pid: number;
  readonly stdout?: ReadableStream<Uint8Array> | null;
  readonly stderr?: ReadableStream<Uint8Array> | null;
  readonly exited: Promise<number>;
  kill(signal?: NodeJS.Signals | number): void;
}

/** Launches a job process from resolved argv/env. Injectable so tests never spawn a real process. */
export type JobSpawnFn = (spawnArgs: string[], opts: { cwd: string; env: Record<string, string> }) => JobProcess;

const defaultJobSpawn: JobSpawnFn = (spawnArgs, opts) =>
  Bun.spawn(spawnArgs, { cwd: opts.cwd, env: opts.env, stdout: "pipe", stderr: "pipe" });

export const MAX_CONCURRENT_JOBS = 8;
export const MAX_BUFFERED_LINES = 200;
export const MAX_LINE_LEN = 2_000;
export const DEFAULT_WATCH_TIMEOUT_MS = 300_000;
export const MAX_WATCH_TIMEOUT_MS = 3_600_000;
const KILL_GRACE_MS = 2_000;
/** Sidebar repaint throttle — one process can emit thousands of lines/sec. */
const FLEET_EMIT_MIN_INTERVAL_MS = 150;

type JobKind = "job" | "watch";
type JobStatus = "running" | "done" | "failed";

interface JobRecord {
  id: string;
  kind: JobKind;
  label: string;
  command: string;
  status: JobStatus;
  pid?: number;
  proc?: JobProcess;
  /** `kind: "job"` — a ring buffer of the raw tail. `kind: "watch"` — one entry per event. */
  lines: string[];
  eventCount: number;
  exitSummary?: string;
  netClose: () => Promise<void>;
  lastEmit: number;
  timeoutTimer?: ReturnType<typeof setTimeout>;
}

function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function pushLine(record: JobRecord, line: string): void {
  record.lines.push(clip(line, MAX_LINE_LEN));
  if (record.lines.length > MAX_BUFFERED_LINES) {
    record.lines.shift();
  }
  if (record.kind === "watch") {
    record.eventCount += 1;
  }
}

/**
 * Registry of jobs started this session. A class (not free functions) so
 * `backgroundJobTools` can be given a fresh instance in tests instead of
 * sharing the process-wide singleton every other call site uses.
 */
export class JobRegistry {
  private readonly jobs = new Map<string, JobRecord>();
  private nextId = 1;
  /**
   * Slots claimed between the concurrency-cap check and the job actually
   * landing in `jobs` (i.e. across the `await prepareCommandSpawn(...)`).
   * Without this, two `start()` calls resolving that await concurrently
   * could both pass the cap check and both spawn — unreachable today because
   * `agent.ts` executes tool calls strictly sequentially, but cheap to close
   * off rather than leave as a standing assumption (flow 174 security
   * review, F-002).
   */
  private reservedSlots = 0;

  private mintId(): string {
    const id = `job:${this.nextId}`;
    this.nextId += 1;
    return id;
  }

  private runningCount(): number {
    let n = 0;
    for (const j of this.jobs.values()) {
      if (j.status === "running") n += 1;
    }
    return n;
  }

  private emitFleet(record: JobRecord, detail: string, force = false): void {
    const now = Date.now();
    if (!force && now - record.lastEmit < FLEET_EMIT_MIN_INTERVAL_MS) {
      return;
    }
    record.lastEmit = now;
    emitJobFleet({
      kind: "upsert",
      id: record.id,
      label: record.label,
      status: record.status,
      detail,
    });
  }

  private async attach(root: string, record: JobRecord, proc: JobProcess): Promise<void> {
    record.proc = proc;
    record.pid = proc.pid;
    this.emitFleet(record, "starting…", true);

    const readLines = async (stream: ReadableStream<Uint8Array> | null | undefined): Promise<void> => {
      if (stream === undefined || stream === null) return;
      const reader = stream.getReader();
      const decoder = new TextDecoder();
      let buffered = "";
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          if (chunk.value === undefined) continue;
          buffered += decoder.decode(chunk.value, { stream: true });
          // A process with newline-sparse output (a `\r`-only progress meter, or
          // one very large unterminated line) would otherwise grow `buffered`
          // without bound for as long as the job runs — and start_job/persistent
          // watch_job have no overall timeout. Flush a clipped partial line and
          // reset instead of ever letting it grow past one line's worth (flow 174
          // security review, F-001).
          if (buffered.length > MAX_LINE_LEN) {
            pushLine(record, buffered);
            buffered = "";
          }
          let nl = buffered.indexOf("\n");
          while (nl >= 0) {
            const line = buffered.slice(0, nl).replace(/\r$/, "");
            buffered = buffered.slice(nl + 1);
            if (line.length > 0) {
              pushLine(record, line);
              this.emitFleet(record, record.kind === "watch" ? `${record.eventCount} events · ${clip(line, 40)}` : clip(line, 60));
            }
            nl = buffered.indexOf("\n");
          }
        }
        if (buffered.length > 0) {
          pushLine(record, buffered);
        }
      } catch {
        // stream torn down by kill/exit — keep what was already buffered
      } finally {
        reader.releaseLock();
      }
    };

    const drained = Promise.all([readLines(proc.stdout), readLines(proc.stderr)]);
    const exit = await proc.exited;
    await drained;
    if (record.timeoutTimer !== undefined) {
      clearTimeout(record.timeoutTimer);
    }
    await record.netClose();

    if (record.exitSummary === undefined) {
      record.status = exit === 0 ? "done" : "failed";
      record.exitSummary = `exit ${exit}`;
    }
    this.emitFleet(record, record.exitSummary, true);
  }

  /** Starts `kind: "job"` or `kind: "watch"`. Returns the new job's id, or an error. */
  async start(
    root: string,
    command: string,
    label: string,
    kind: JobKind,
    opts: { persistent?: boolean; timeoutMs?: number } = {},
    spawn: JobSpawnFn = defaultJobSpawn,
  ): Promise<{ ok: true; id: string } | { ok: false; output: string }> {
    if (this.runningCount() + this.reservedSlots >= MAX_CONCURRENT_JOBS) {
      return { ok: false, output: `too many concurrent jobs (max ${MAX_CONCURRENT_JOBS}); stop one with stop_job first` };
    }
    this.reservedSlots += 1;
    let slotReleased = false;
    const releaseSlot = (): void => {
      if (!slotReleased) {
        slotReleased = true;
        this.reservedSlots -= 1;
      }
    };

    let netClose: () => Promise<void> = async () => {};
    let prepared: Awaited<ReturnType<typeof prepareCommandSpawn>>;
    try {
      prepared = await prepareCommandSpawn(root, command, (close) => {
        netClose = close;
      });
    } catch (cause) {
      releaseSlot();
      await netClose();
      return { ok: false, output: `command failed to start: ${cause instanceof Error ? cause.message : String(cause)}` };
    }
    if (!prepared.ok) {
      releaseSlot();
      await netClose();
      return { ok: false, output: prepared.output };
    }

    const id = this.mintId();
    const record: JobRecord = {
      id,
      kind,
      label,
      command,
      status: "running",
      lines: [],
      eventCount: 0,
      netClose,
      lastEmit: 0,
    };
    this.jobs.set(id, record);
    // From here on `runningCount()` itself counts this job — the reservation
    // has done its job of closing the check-then-act window above.
    releaseSlot();

    let proc: JobProcess;
    try {
      proc = spawn(prepared.spawn.spawnArgs, { cwd: root, env: prepared.spawn.env });
    } catch (cause) {
      record.status = "failed";
      record.exitSummary = `command failed to start: ${cause instanceof Error ? cause.message : String(cause)}`;
      await netClose();
      this.emitFleet(record, record.exitSummary, true);
      return { ok: false, output: record.exitSummary };
    }

    if (kind === "watch" && opts.persistent !== true) {
      const timeoutMs = Math.min(Math.max(opts.timeoutMs ?? DEFAULT_WATCH_TIMEOUT_MS, 1_000), MAX_WATCH_TIMEOUT_MS);
      record.timeoutTimer = setTimeout(() => {
        if (record.status !== "running") return;
        record.exitSummary = "timeout";
        record.status = "done";
        try {
          proc.kill("SIGTERM");
        } catch {
          // already gone
        }
        setTimeout(() => {
          try {
            proc.kill("SIGKILL");
          } catch {
            // already gone
          }
        }, KILL_GRACE_MS);
      }, timeoutMs);
    }

    // Deliberately not awaited — start_job/watch_job return immediately, the
    // stream/exit handling continues in the background.
    void this.attach(root, record, proc);

    return { ok: true, id };
  }

  /** SIGTERM then SIGKILL after a grace window; no-op if the job already finished. */
  async stop(id: string): Promise<{ ok: true } | { ok: false; output: string }> {
    const record = this.jobs.get(id);
    if (record === undefined) {
      return { ok: false, output: `no such job: ${id}` };
    }
    if (record.status !== "running" || record.proc === undefined) {
      return { ok: true }; // already finished — stopping it again is a no-op, not an error
    }
    record.exitSummary = "stopped";
    try {
      record.proc.kill("SIGTERM");
    } catch {
      // already gone
    }
    const proc = record.proc;
    await Promise.race([
      proc.exited,
      new Promise<void>((resolve) => {
        setTimeout(() => {
          try {
            proc.kill("SIGKILL");
          } catch {
            // already gone
          }
          resolve();
        }, KILL_GRACE_MS);
      }),
    ]);
    return { ok: true };
  }

  /** Terminates every job still tracked as running. Called from shell shutdown — no orphans survive the shell. */
  async killAll(): Promise<void> {
    const running = [...this.jobs.values()].filter((j) => j.status === "running").map((j) => j.id);
    await Promise.all(running.map((id) => this.stop(id)));
  }

  output(id: string, tail = 50): { ok: true; status: JobStatus; kind: JobKind; lines: string[] } | { ok: false; output: string } {
    const record = this.jobs.get(id);
    if (record === undefined) {
      return { ok: false, output: `no such job: ${id}` };
    }
    return { ok: true, status: record.status, kind: record.kind, lines: record.lines.slice(-Math.max(1, tail)) };
  }

  list(): Array<{ id: string; label: string; kind: JobKind; status: JobStatus; pid?: number }> {
    return [...this.jobs.values()].map((j) => ({
      id: j.id,
      label: j.label,
      kind: j.kind,
      status: j.status,
      ...(j.pid !== undefined ? { pid: j.pid } : {}),
    }));
  }
}

/** Process-wide default registry — one shell process, one job set, shared by both shells. */
export const backgroundJobRegistry = new JobRegistry();

/** Terminates every job still running on the default registry. Wire into shell shutdown (TUI + readline). */
export async function killAllBackgroundJobs(registry: JobRegistry = backgroundJobRegistry): Promise<void> {
  await registry.killAll();
}

function ok(output: string): InteractiveToolResult {
  return { output, isError: false };
}
function err(output: string): InteractiveToolResult {
  return { output, isError: true };
}

/** The five background-job tools, bound to `root`. Mirrors `shellExecTool`'s factory shape. */
export function backgroundJobTools(root: string, registry: JobRegistry = backgroundJobRegistry, spawn: JobSpawnFn = defaultJobSpawn): InteractiveTool[] {
  const startJob: InteractiveTool = {
    definition: {
      name: "start_job",
      description:
        "Start a long-lived command in the background and return immediately (unlike shell_exec, which waits for the " +
        "command to finish). Use for a test-watch run, a dev server, or anything that should keep running while you keep " +
        "working. Requires the user's approval before it runs, same as shell_exec. Shows up in the sidebar with a live " +
        "status; call job_output to read its buffered output, stop_job to end it. Input: { command: string, label?: string }.",
      inputSchema: {
        type: "object",
        properties: { command: { type: "string" }, label: { type: "string" } },
        required: ["command"],
        additionalProperties: false,
      },
      risk: "shell",
    },
    invoke: async (input) => {
      const command = typeof input.command === "string" ? input.command : "";
      if (command.length === 0) {
        return err("start_job requires a non-empty 'command'");
      }
      const label = typeof input.label === "string" && input.label.length > 0 ? input.label : command;
      const result = await registry.start(root, command, label, "job", {}, spawn);
      return result.ok ? ok(`started ${result.id}`) : err(`start_job: ${result.output}`);
    },
  };

  const watchJob: InteractiveTool = {
    definition: {
      name: "watch_job",
      description:
        "Start a background command whose output is treated as a stream of EVENTS, one per complete stdout line — " +
        "modeled on the same idea as a log/build watcher. Best given a filtered pipeline you author yourself (e.g. " +
        "`tail -f build.log | grep --line-buffered -E \"FAIL|Error\"`); merge stderr into it with `2>&1` if you need " +
        "failures from a command you run directly, since only stdout is read as events. Each event updates the sidebar " +
        "(last event + running count) — it never appears in the transcript on its own; call job_output to actually read " +
        "events. Requires the user's approval before it runs, same as shell_exec. Set persistent:true to run until " +
        "stop_job or the shell exits; otherwise it is killed after timeout_ms (default 300000, max 3600000). Input: " +
        "{ command: string, label?: string, persistent?: boolean, timeout_ms?: number }.",
      inputSchema: {
        type: "object",
        properties: {
          command: { type: "string" },
          label: { type: "string" },
          persistent: { type: "boolean" },
          timeout_ms: { type: "number" },
        },
        required: ["command"],
        additionalProperties: false,
      },
      risk: "shell",
    },
    invoke: async (input) => {
      const command = typeof input.command === "string" ? input.command : "";
      if (command.length === 0) {
        return err("watch_job requires a non-empty 'command'");
      }
      const label = typeof input.label === "string" && input.label.length > 0 ? input.label : command;
      const persistent = input.persistent === true;
      const timeoutMs = typeof input.timeout_ms === "number" ? input.timeout_ms : undefined;
      const result = await registry.start(root, command, label, "watch", { persistent, ...(timeoutMs !== undefined ? { timeoutMs } : {}) }, spawn);
      return result.ok ? ok(`watching ${result.id}`) : err(`watch_job: ${result.output}`);
    },
  };

  const jobOutput: InteractiveTool = {
    definition: {
      name: "job_output",
      description:
        "Read a job's or watcher's current status and buffered output — a raw tail for start_job, recent events for " +
        "watch_job. Input: { id: string, tail?: number } (tail defaults to 50 lines/events).",
      inputSchema: {
        type: "object",
        properties: { id: { type: "string" }, tail: { type: "number" } },
        required: ["id"],
        additionalProperties: false,
      },
      risk: "read",
    },
    invoke: async (input) => {
      const id = typeof input.id === "string" ? input.id : "";
      if (id.length === 0) {
        return err("job_output requires a non-empty 'id'");
      }
      const tail = typeof input.tail === "number" ? input.tail : 50;
      const result = registry.output(id, tail);
      if (!result.ok) {
        return err(result.output);
      }
      const header = `status: ${result.status} (${result.kind})`;
      const body = result.lines.length > 0 ? result.lines.join("\n") : "(no output yet)";
      return ok(`${header}\n${body}`);
    },
  };

  const listJobs: InteractiveTool = {
    definition: {
      name: "list_jobs",
      description: "List every background job/watcher still tracked this session (id, label, kind, status, pid).",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      risk: "read",
    },
    invoke: async () => {
      const jobs = registry.list();
      if (jobs.length === 0) {
        return ok("(no jobs)");
      }
      const lines = jobs.map((j) => `${j.id}\t${j.kind}\t${j.status}\t${j.label}${j.pid !== undefined ? `\tpid ${j.pid}` : ""}`);
      return ok(lines.join("\n"));
    },
  };

  const stopJob: InteractiveTool = {
    definition: {
      name: "stop_job",
      description: "Stop a background job/watcher started this session by id (from start_job/watch_job/list_jobs). Input: { id: string }.",
      inputSchema: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
        additionalProperties: false,
      },
      risk: "shell",
    },
    invoke: async (input) => {
      const id = typeof input.id === "string" ? input.id : "";
      if (id.length === 0) {
        return err("stop_job requires a non-empty 'id'");
      }
      const result = await registry.stop(id);
      return result.ok ? ok(`stopped ${id}`) : err(result.output);
    },
  };

  return [startJob, watchJob, jobOutput, listJobs, stopJob];
}
