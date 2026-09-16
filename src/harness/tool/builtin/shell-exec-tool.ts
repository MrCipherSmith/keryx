// shell_exec tool for interactive agent mode (flow 036 / SA-01 Flow C).
//
// This is the ONE write/execute capability. It is risk `shell` and is NEVER run
// except through the agent driver's DEFAULT-DENY approval gate (see
// `src/commands/agent.ts`): the model can propose a command, but nothing executes
// without an explicit user `y`. The command runs in the project root; output is
// bounded; failures return `{ isError: true }` rather than throwing. The runner is
// injectable so unit tests are deterministic (no real subprocess).
//
// OS sandbox (flow 098): OPT-IN via `KERYX_SANDBOX_SHELL` — the interactive agent
// already gates every command behind human approval, and default-on would break
// common tools that write to global caches (bun/npm/cargo). When enabled the
// command runs OS-contained (macOS seatbelt / Linux bwrap). Extra writable roots
// (e.g. `~/.bun`) via `KERYX_SANDBOX_ALLOW_WRITE`.

import type { InteractiveTool, InteractiveToolResult } from "./interactive-tools";
import type { JobRegistry, StartTaskOptions } from "./background-job-registry";
// Value import, one-way: the registry imports only `../../process/shell-spawn`,
// never this module (see its `ENV_SHELL_TIMEOUT_MS_FALLBACK` comment), so this
// edge closes no cycle.
import { ENV_SHELL_IDLE_MS, clampTaskIdleTimeoutMs } from "./background-job-registry";
import type { DetectOptions } from "../../process/sandbox/detect";
import {
  resolveShellEnv,
  resolveShellSpawn,
  type SandboxSpawnPlan,
} from "../../process/shell-spawn";
export {
  extraReadDenyRoots,
  resolveShellEnv,
  resolveShellRestrictedMasks,
  resolveShellSandboxMode,
} from "../../process/shell-spawn";
export type { SandboxSpawnPlan, ShellSandboxMode } from "../../process/shell-spawn";

/** Runs a shell command string and returns bounded output (or an error result). */
export type CommandRunner = (command: string) => Promise<InteractiveToolResult>;

const MAX_OUTPUT_BYTES = 20_000;

/**
 * Deadline for one approved command. Without it `await proc.exited` waits
 * forever: a single hanging command blocks the agent turn permanently and there
 * is no cancellation path to interrupt it (stress finding C3b).
 *
 * Two minutes is chosen to sit above ordinary interactive work (`git`, `bun
 * test`, a build step) and well below "the user has given up". A longer job is
 * the operator's call, via the env override.
 */
export const DEFAULT_SHELL_TIMEOUT_MS = 120_000;

/** Env override for {@link DEFAULT_SHELL_TIMEOUT_MS}; an explicit `0` disables it. */
export const ENV_SHELL_TIMEOUT_MS = "KERYX_SHELL_TIMEOUT_MS";

/**
 * Resolve the shell deadline in ms. Unset / empty / non-numeric / negative all
 * fall back to the default — a malformed value must never silently mean "no
 * deadline". `0` disables the deadline, but only when set deliberately.
 */
export function resolveShellTimeoutMs(env: Record<string, string | undefined> = process.env): number {
  const raw = env[ENV_SHELL_TIMEOUT_MS];
  if (raw === undefined || raw.trim().length === 0) {
    return DEFAULT_SHELL_TIMEOUT_MS;
  }
  const n = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(n) || n < 0) {
    return DEFAULT_SHELL_TIMEOUT_MS;
  }
  return n;
}

/**
 * Yield window for a FOREGROUND `shell_exec` (flow 263): how long the tool
 * waits for the command to finish before handing back a task handle.
 *
 * This is NOT a deadline — unlike {@link DEFAULT_SHELL_TIMEOUT_MS}, nothing is
 * killed when it expires. The command keeps running as a supervised task and
 * the model reads it with `shell_job_output`. Ten seconds is short enough that
 * a turn never visibly stalls, and long enough that ordinary interactive work
 * (`git status`, a lint run) still returns its output inline rather than as a
 * handle the model has to poll.
 */
export const DEFAULT_SHELL_YIELD_MS = 10_000;

/** Env override for {@link DEFAULT_SHELL_YIELD_MS}; an explicit `0` yields immediately. */
export const ENV_SHELL_YIELD_MS = "KERYX_SHELL_YIELD_MS";

/**
 * Resolve the yield window in ms under the same fail-safe rules as
 * {@link resolveShellTimeoutMs}: unset / empty / non-numeric / negative all
 * fall back to the default. An explicit `0` is honoured — every command then
 * becomes a task handle immediately, a deliberate (if unusual) operator
 * choice rather than a malformed value.
 */
export function resolveShellYieldMs(env: Record<string, string | undefined> = process.env): number {
  const raw = env[ENV_SHELL_YIELD_MS];
  if (raw === undefined || raw.trim().length === 0) {
    return DEFAULT_SHELL_YIELD_MS;
  }
  const n = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(n) || n < 0) {
    return DEFAULT_SHELL_YIELD_MS;
  }
  return n;
}

/** Apply the shared 20KB output cap, marking a truncated transcript as such. */
function boundOutput(text: string): string {
  return text.length > MAX_OUTPUT_BYTES ? `${text.slice(0, MAX_OUTPUT_BYTES)}\n…(truncated)` : text;
}

/**
 * The handle returned for a task still running when `shell_exec` hands back:
 * `task_id` is the primary key, `job_id` the same value kept as an alias so
 * existing `shell_job_output`/`shell_job_kill` callers keep working.
 */
function taskHandleResult(args: {
  taskId: string;
  pid: number;
  output: string;
  notice: string;
  overCap?: string;
}): InteractiveToolResult {
  return {
    output: JSON.stringify({
      task_id: args.taskId,
      job_id: args.taskId,
      pid: args.pid,
      status: "running",
      output: boundOutput(args.output),
      notice: args.notice,
      ...(args.overCap !== undefined ? { over_cap: args.overCap } : {}),
    }),
    isError: false,
  };
}

export async function resolveSandboxedSpawn(
  root: string,
  command: string,
  baseEnv: Record<string, string>,
  detectOpts?: DetectOptions,
): Promise<{ ok: true; plan: SandboxSpawnPlan } | { ok: false; result: InteractiveToolResult }> {
  const resolved = await resolveShellSpawn(root, command, baseEnv, detectOpts);
  return resolved.ok ? resolved : { ok: false, result: { output: resolved.error, isError: true } };
}

/**
 * The default runner: execute `command` in `cwd = root` via `sh -c`, capturing
 * bounded stdout/stderr. Never throws — a non-zero exit or a spawn failure becomes
 * `{ isError: ... }`. OS-contained when `KERYX_SANDBOX_SHELL` opts in.
 */
export function makeCommandRunner(root: string): CommandRunner {
  return async (command) => {
    // Closes the restricted-network proxy worker (no-op unless restricted). Run
    // exactly once in the finally, after success or failure.
    let netClose: () => Promise<void> = async () => {};
    try {
      const baseEnv = await resolveShellEnv();
      const resolved = await resolveShellSpawn(root, command, baseEnv);
      if (!resolved.ok) {
        return { output: resolved.error, isError: true };
      }
      netClose = resolved.plan.netClose;

      const proc = Bun.spawn(resolved.plan.spawnArgs, {
        cwd: root,
        stdout: "pipe",
        stderr: "pipe",
        env: resolved.plan.env,
      });

      // Deadline. On expiry: SIGTERM, then SIGKILL if the process ignores it,
      // so a command that traps TERM cannot outlive its deadline either. The
      // output collected so far is still reported — a timeout with no context
      // is much harder to act on than a truncated transcript.
      const timeoutMs = resolveShellTimeoutMs(process.env);
      let timedOut = false;
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      let forceTimer: ReturnType<typeof setTimeout> | undefined;
      if (timeoutMs > 0) {
        killTimer = setTimeout(() => {
          timedOut = true;
          try {
            proc.kill("SIGTERM");
          } catch {
            // already gone
          }
          forceTimer = setTimeout(() => {
            try {
              proc.kill("SIGKILL");
            } catch {
              // already gone
            }
          }, 2_000);
        }, timeoutMs);
      }

      // Read incrementally rather than with `Response.text()`, which only
      // resolves when the pipe CLOSES. Killing `sh` does not necessarily close
      // it: a grandchild (`sh -c 'echo x; sleep 30'` → the `sleep`) inherits the
      // write end and can outlive the shell, so waiting on the pipe would hang
      // past the very deadline we just enforced. Incremental reads also mean the
      // output produced before the timeout is still available to report.
      const out = { text: "" };
      const err = { text: "" };
      const readInto = async (stream: ReadableStream<Uint8Array> | undefined, sink: { text: string }): Promise<void> => {
        if (stream === undefined) return;
        const reader = stream.getReader();
        const decoder = new TextDecoder();
        try {
          for (;;) {
            const chunk = await reader.read();
            if (chunk.done) break;
            if (chunk.value !== undefined) sink.text += decoder.decode(chunk.value, { stream: true });
          }
        } catch {
          // stream torn down by the kill — keep what we have
        } finally {
          reader.releaseLock();
        }
      };

      let exit = 0;
      try {
        const drained = Promise.all([readInto(proc.stdout, out), readInto(proc.stderr, err)]);
        exit = await proc.exited;
        if (timedOut) {
          // Do not wait on pipes a surviving grandchild may still hold open.
          await Promise.race([drained, new Promise((r) => setTimeout(r, 200))]);
        } else {
          await drained;
        }
      } finally {
        if (killTimer !== undefined) clearTimeout(killTimer);
        if (forceTimer !== undefined) clearTimeout(forceTimer);
      }
      const stdout = out.text;
      const stderr = err.text;

      const combined = `${stdout}${stderr.length > 0 ? `\n${stderr}` : ""}`.trim();
      const bounded =
        combined.length > MAX_OUTPUT_BYTES
          ? `${combined.slice(0, MAX_OUTPUT_BYTES)}\n…(truncated)`
          : combined;
      if (timedOut) {
        const notice = `shell_exec: timed out after ${timeoutMs}ms and was killed (raise or disable with ${ENV_SHELL_TIMEOUT_MS})`;
        return {
          output: bounded.length > 0 ? `${bounded}\n${notice}` : notice,
          isError: true,
        };
      }
      const output = bounded.length > 0 ? bounded : `(no output; exit ${exit})`;
      return { output, isError: exit !== 0 };
    } catch (cause) {
      return {
        output: `command failed to start: ${cause instanceof Error ? cause.message : String(cause)}`,
        isError: true,
      };
    } finally {
      await netClose();
    }
  };
}

/**
 * The `shell_exec` tool, bound to `root`. `run` defaults to a real subprocess
 * runner and is injectable for deterministic tests. Risk `shell` → the driver
 * requires approval before this ever executes (identically for `background:
 * true` — flow 173 AC10: no separate or stricter gate).
 *
 * `jobRegistry` makes EVERY command a supervised task (flow 263, widening
 * flow 173's `background:true`-only delegation):
 *
 * - No registry → `run(command)`, the synchronous path this function has
 *   always had, unchanged (D-17). `background:true` is refused outright rather
 *   than routed there: running a dev server through the synchronous runner is
 *   the exact freeze this flow removes.
 * - Registry, no `background` → a FOREGROUND task, awaited for up to the yield
 *   window. Exits within it and the caller sees the ordinary synchronous
 *   result; outlives it and the task is PROMOTED to the background (never
 *   killed) and a `{task_id, …}` handle is returned instead.
 * - Registry + `background:true` → a background-phase start that skips the
 *   wait entirely, returning the same handle shape.
 *
 * `options.yieldMs` overrides {@link resolveShellYieldMs} (tests inject a short
 * window so they never wait the real 10 s).
 */
export function shellExecTool(
  root: string,
  run: CommandRunner = makeCommandRunner(root),
  jobRegistry?: JobRegistry,
  options?: { yieldMs?: number },
): InteractiveTool {
  return {
    definition: {
      name: "shell_exec",
      description:
        "Run a shell command in the project root (e.g. `git status`, `bun test`). Requires the user's approval " +
        "before it runs. Input: { command: string, background?: boolean, description?: string, " +
        "idle_timeout_ms?: integer }. EVERY command returns within a bounded wait — a short one returns its " +
        "output directly, and one still running when the wait elapses keeps running as a task: you get " +
        "{task_id, pid, status, output} instead of its final output, and read the rest with " +
        "shell_job_output(task_id) and stop it with shell_job_kill(task_id). So a slow command never freezes " +
        "the session and never needs to be guessed at in advance. background:true only SKIPS the wait (use it " +
        "for a dev server or a watch build you know you will not read inline); it changes nothing else. " +
        "description is a short label for the task list. idle_timeout_ms is for a command that is deliberately " +
        "SILENT for a long time (a sleep, a slow poll) — a task that produces no output for its idle timeout " +
        "is killed, so raise it rather than lose the command. Combined stdout+stderr is CAPPED at 20,000 bytes " +
        "from the start of output — do not use sed/grep/cat/awk here to locate code (they can silently " +
        "truncate before reaching what you need, and repeating the command returns the same truncated head); " +
        "use search_code or graph_symbol instead, which are built for that and stay within the cap.",
      inputSchema: {
        type: "object",
        properties: {
          command: { type: "string" },
          background: { type: "boolean" },
          description: { type: "string" },
          idle_timeout_ms: { type: "integer" },
        },
        required: ["command"],
        additionalProperties: false,
      },
      risk: "shell",
    },
    invoke: async (input) => {
      const command = typeof input.command === "string" ? input.command : "";
      if (command.length === 0) {
        return { output: "shell_exec requires a non-empty 'command'", isError: true };
      }
      const background = input.background === true;

      if (jobRegistry === undefined) {
        if (background) {
          return { output: "shell_exec: background jobs are not available in this session", isError: true };
        }
        return run(command);
      }

      const startOpts: StartTaskOptions = { phase: background ? "background" : "foreground" };
      if (typeof input.description === "string" && input.description.length > 0) {
        startOpts.description = input.description;
      }
      if (typeof input.idle_timeout_ms === "number") {
        // Clamped HERE, not in the registry: the clamp has a floor, so a model
        // cannot disable the idle rail on its own task (an internal caller
        // still may, by passing 0 to the registry directly).
        startOpts.idleTimeoutMs = clampTaskIdleTimeoutMs(input.idle_timeout_ms);
      }

      const started = await jobRegistry.start(command, startOpts);
      if (!started.ok) {
        // The cap refusal, which names the running commands, reaches the model
        // as an ordinary tool error rather than a hang.
        return { output: started.error, isError: true };
      }
      const taskId = started.jobId;

      if (background) {
        return taskHandleResult({
          taskId,
          pid: started.pid,
          output: started.output,
          notice: `running as a background task; read new output with shell_job_output("${taskId}") and stop it with shell_job_kill("${taskId}")`,
        });
      }

      const yieldMs = options?.yieldMs ?? resolveShellYieldMs();
      const outcome = await jobRegistry.waitForExit(taskId, yieldMs);
      // Drain once, after the wait: `start` already consumed whatever was
      // buffered at spawn time, so the full transcript is the two halves
      // concatenated.
      let collected = started.output;
      const pending = jobRegistry.readOutput(taskId);
      if (pending.ok) collected += pending.output;

      if (outcome === "timeout") {
        // Promote, never kill — this is what turns a slow command into a task
        // the model can come back to instead of a dead one.
        const promoted = jobRegistry.promote(taskId);
        if (!promoted.ok) {
          return { output: promoted.error, isError: true };
        }
        return taskHandleResult({
          taskId,
          pid: started.pid,
          output: collected,
          notice: `still running after ${yieldMs}ms, so it is now a background task; read new output with shell_job_output("${taskId}") and stop it with shell_job_kill("${taskId}")`,
          ...(promoted.overCap !== undefined ? { overCap: promoted.overCap } : {}),
        });
      }

      const info = jobRegistry.get(taskId);
      if (outcome === "unknown" || info === undefined) {
        // Only reachable if the entry was evicted between start and wait.
        const so_far = boundOutput(collected.trim());
        const lost = `shell_exec: task ${taskId} is no longer tracked, so its exit status is unknown`;
        return { output: so_far.length > 0 ? `${so_far}\n${lost}` : lost, isError: true };
      }

      // Exited within the yield: the ordinary synchronous result, with no
      // handle — the model should not have to poll a command that is done.
      //
      // Built from the task's HEAD snapshot, not from what was drained above:
      // the registry shrinks a terminated task's ring buffer to its TAIL from
      // inside `onExit`, which runs before this await resolves, so `collected`
      // can be missing the start of a chatty command's output — exactly the
      // part this result caps to. `collected` remains the fallback for a task
      // that produced nothing (no snapshot) or one whose entry is gone.
      const exitCode = info.exitCode ?? 0;
      const bounded = boundOutput((info.outputHead ?? collected).trim());
      const body = bounded.length > 0 ? bounded : `(no output; exit ${exitCode})`;
      const idleKilled = info.status === "killed" && info.killReason === "idle";
      const output = idleKilled
        ? `${body}\nshell_exec: no output for ${info.idleTimeoutMs}ms, so the command was killed (raise it for this command with idle_timeout_ms, or change the default with ${ENV_SHELL_IDLE_MS})`
        : body;
      return { output, isError: info.status !== "completed" };
    },
  };
}
