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
import type { JobRegistry } from "./background-job-registry";
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
 * `jobRegistry` (flow 173, T2/T3) backs the optional `background: true` input:
 * when set, `invoke` skips `run`/the synchronous deadline path ENTIRELY and
 * delegates to `jobRegistry.start`, returning immediately with `{job_id,
 * pid}` instead of blocking on exit. Omitted, `background` is absent/false is
 * unaffected — the synchronous path this function already had.
 */
export function shellExecTool(
  root: string,
  run: CommandRunner = makeCommandRunner(root),
  jobRegistry?: JobRegistry,
): InteractiveTool {
  return {
    definition: {
      name: "shell_exec",
      description:
        "Run a shell command in the project root (e.g. `git status`, `bun test`). Requires the user's approval " +
        "before it runs. Input: { command: string, background?: boolean }. Combined stdout+stderr is CAPPED at " +
        "20,000 bytes from the start of output — do not use sed/grep/cat/awk here to locate code (they can " +
        "silently truncate before reaching what you need, and repeating the command returns the same truncated " +
        "head); use search_code or graph_symbol instead, which are built for that and stay within the cap. Set " +
        "background:true for a long-running command (a dev server, a watch build) — it returns immediately with " +
        "{job_id, pid} instead of blocking; poll shell_job_output(job_id) for new output and shell_job_kill" +
        "(job_id) to stop it.",
      inputSchema: {
        type: "object",
        properties: { command: { type: "string" }, background: { type: "boolean" } },
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
      if (input.background === true) {
        if (jobRegistry === undefined) {
          return { output: "shell_exec: background jobs are not available in this session", isError: true };
        }
        const started = await jobRegistry.start(command);
        if (!started.ok) {
          return { output: started.error, isError: true };
        }
        return {
          output: JSON.stringify({ job_id: started.jobId, pid: started.pid, output: started.output }),
          isError: false,
        };
      }
      return run(command);
    },
  };
}
