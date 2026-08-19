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

import { realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import type { InteractiveTool, InteractiveToolResult } from "./interactive-tools";
import type { JobRegistry } from "./background-job-registry";
import { defaultSandboxProfile } from "../../process/sandbox/profile";
import type { SandboxProfile } from "../../process/sandbox/profile";
import { detectSandboxLauncher } from "../../process/sandbox/detect";
import type { DetectOptions } from "../../process/sandbox/detect";
import { wrapWithSandbox } from "../../process/sandbox/wrap";
import { setupNetworkRun } from "../../process/sandbox/network-run";
import type { MaskedCredential } from "../../process/sandbox/network-run";
import {
  buildDefaultMaskProviders,
  resolveAllowedDomains,
  resolveMasksFromSandboxEnv,
} from "../../process/sandbox/mask-resolve";
import { OPENAI_COMPAT_PROVIDERS } from "../../../commands/providers";
import { loadSandboxDefaults } from "../../../lib/sandbox-config";

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

/** OS-sandbox posture for the agent shell. `off` = current unsandboxed behavior. */
export type ShellSandboxMode = "off" | "workspace" | "strict";

/**
 * Resolve the shell sandbox mode from env, then global sandbox.json (P1), then
 * built-in `off` (human approval already gates each command; default-on breaks
 * global-cache tools). `workspace` = FS containment + network on; `strict` = +
 * network off. The global disable escape hatch forces `off`.
 */
export function resolveShellSandboxMode(
  env: Record<string, string | undefined>,
  sandboxConfigDir?: string,
): ShellSandboxMode {
  if (env.KERYX_DANGEROUSLY_DISABLE_SANDBOX === "1") return "off";
  const envRaw = env.KERYX_SANDBOX_SHELL;
  let raw = "";
  if (envRaw !== undefined && envRaw.trim().length > 0) {
    raw = envRaw.toLowerCase();
  } else {
    const d = loadSandboxDefaults(sandboxConfigDir).shell;
    raw = typeof d === "string" ? d.toLowerCase() : "";
  }
  if (raw === "strict") return "strict";
  if (raw === "workspace" || raw === "1" || raw === "on") return "workspace";
  if (raw === "off") return "off";
  return "off";
}

function canonical(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/** Extra writable roots from `KERYX_SANDBOX_ALLOW_WRITE` (comma-separated). */
function extraWritableRoots(env: Record<string, string | undefined>): string[] {
  const raw = env.KERYX_SANDBOX_ALLOW_WRITE;
  if (!raw) return [];
  return raw
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
    .map((p) => canonical(p.startsWith("~/") ? p.replace(/^~/, homedir()) : p));
}

/**
 * Extra read-denied roots from `KERYX_SANDBOX_READ_DENY` (comma-separated). Lets
 * an operator extend the built-in secret read-deny list with project- or
 * host-specific secret locations the defaults cannot know about (F2). `~/` is
 * expanded to the home directory. Trusted env config only — never a repo file.
 */
export function extraReadDenyRoots(env: Record<string, string | undefined>): string[] {
  const raw = env.KERYX_SANDBOX_READ_DENY;
  if (!raw) return [];
  return raw
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
    .map((p) => canonical(p.startsWith("~/") ? p.replace(/^~/, homedir()) : p));
}

/**
 * Build the agent-shell sandbox profile for `mode` (never `off`). A domain
 * allowlist from TRUSTED config (env, or a project policy the operator opted into
 * via `KERYX_SANDBOX_TRUST_PROJECT_POLICY`) switches network to `restricted`
 * (only those hosts via the loopback proxy), overriding the mode's on/off. An
 * untrusted in-repo policy cannot widen egress, so a `strict` request stays
 * network-off (F1).
 *
 * `home` MUST be canonicalized like `root`/`tmpdir()` are: on macOS `/var` (and so
 * `/var/folders/...`, where `$TMPDIR` and any HOME override into a scratch dir
 * commonly land) is a symlink to `/private/var`. The Seatbelt `subpath` rule for
 * `readDenyList` is built from this raw path; a process that opens a secret file
 * resolves through the real, canonical path, so an uncanonicalized deny-list entry
 * silently fails to match and the "secret" becomes readable. A real user's actual
 * `$HOME` (`/Users/<name>`) has no such symlink and is unaffected, but any HOME
 * override — exactly what an isolated CI run or test harness does for safety — was
 * silently exposed. Found live by the M1 safety-track containment preflight canary
 * (scripts/benchmark/run-containment.ts) before any agent case ran.
 */
function shellSandboxProfile(root: string, mode: Exclude<ShellSandboxMode, "off">, env: Record<string, string | undefined>): SandboxProfile {
  const base = defaultSandboxProfile(canonical(root), canonical(tmpdir()), canonical(homedir()));
  const writableRoots = [...base.writableRoots, ...extraWritableRoots(env)];
  const readDenyList = [...base.readDenyList, ...extraReadDenyRoots(env)];
  const domains = resolveAllowedDomains(env, root);
  if (domains.length > 0) {
    return { ...base, writableRoots, readDenyList, network: "restricted", allowedDomains: domains };
  }
  return { ...base, writableRoots, readDenyList, network: mode === "strict" ? "off" : "on" };
}

/**
 * Resolve credential masks for a restricted-network shell_exec run (AC7 surface).
 * Uses the shared resolver so harness can match outcomes (AC8).
 * `projectRoot` enables P2 `.keryx/sandbox-policy.json` when provided.
 */
export function resolveShellRestrictedMasks(
  env: Record<string, string | undefined>,
  sandboxConfigDir?: string,
  projectRoot?: string,
):
  | { ok: true; masks: MaskedCredential[]; tlsTerminate: boolean }
  | { ok: false; reason: string } {
  const providers = buildDefaultMaskProviders(OPENAI_COMPAT_PROVIDERS);
  const result = resolveMasksFromSandboxEnv({
    env,
    providers,
    ...(sandboxConfigDir !== undefined ? { sandboxConfigDir } : {}),
    ...(projectRoot !== undefined ? { projectRoot } : {}),
  });
  if (!result.ok) {
    return { ok: false, reason: result.reason };
  }
  const masks: MaskedCredential[] = result.resolution.masks.map((m) => ({
    name: m.name,
    realValue: env[m.name] ?? "",
    injectHosts: m.injectHosts,
  }));
  return {
    ok: true,
    masks,
    tlsTerminate: result.resolution.tlsTerminate,
  };
}

/**
 * Resolve the caller's base env for a shell command: ensure keys entered in
 * `keryx shell` (auth.json) are on `process.env` (`applySavedApiKeys`), then
 * return a plain string-only copy so the child always sees them explicitly
 * (some hosts inherit inconsistently when only cwd/stdout are set).
 *
 * Shared by BOTH the synchronous `shell_exec` path ({@link makeCommandRunner})
 * and the background-job spawner (`background-job-registry.ts`'s
 * `realSpawner`) — flow 173 finding F-014: the background path previously
 * built no env at all and never called `applySavedApiKeys`.
 */
export async function resolveShellEnv(): Promise<Record<string, string>> {
  const { applySavedApiKeys } = await import("../../../lib/shell-config");
  applySavedApiKeys();
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === "string") {
      env[k] = v;
    }
  }
  return env;
}

/** The final argv/env/network-teardown a command should be spawned with. */
export interface SandboxSpawnPlan {
  spawnArgs: string[];
  env: Record<string, string>;
  /** Closes the restricted-network proxy worker (no-op unless restricted). */
  netClose: () => Promise<void>;
}

/**
 * Resolve `command`'s spawn plan: mode → profile → launcher detect
 * (fail-closed when unavailable) → restricted-network masks/proxy →
 * `wrapWithSandbox`. Mode `off` returns the plain `sh -c <command>` argv
 * untouched.
 *
 * Shared by BOTH the synchronous `shell_exec` path ({@link makeCommandRunner})
 * and the background-job spawner (`background-job-registry.ts`'s
 * `realSpawner`) — flow 173 finding F-001: `background: true` previously
 * bypassed this entire block (no sandbox mode resolution, no launcher
 * detection, no fail-closed refusal), directly contradicting this flow's own
 * `description.md` Out-of-Scope statement that background jobs "reuse that
 * machinery." `detectOpts` is exposed only for deterministic unit tests
 * (mirrors `detectSandboxLauncher`'s own injectable surface); every real call
 * site omits it and gets real platform detection.
 */
export async function resolveSandboxedSpawn(
  root: string,
  command: string,
  baseEnv: Record<string, string>,
  detectOpts?: DetectOptions,
): Promise<{ ok: true; plan: SandboxSpawnPlan } | { ok: false; result: InteractiveToolResult }> {
  const env: Record<string, string> = { ...baseEnv };
  const mode = resolveShellSandboxMode(process.env);
  if (mode === "off") {
    return { ok: true, plan: { spawnArgs: ["/bin/sh", "-c", command], env, netClose: async () => {} } };
  }

  let profile = shellSandboxProfile(root, mode, process.env);
  const launcher = detectSandboxLauncher(detectOpts);
  if (!launcher.available) {
    return {
      ok: false,
      result: {
        output: `shell_exec: OS sandbox requested (KERYX_SANDBOX_SHELL=${mode}) but the launcher is unavailable (${launcher.reason ?? "unknown"}); failing closed. Install it or set KERYX_SANDBOX_SHELL=off.`,
        isError: true,
      },
    };
  }

  // Restricted network: start the loopback allowlist proxy, point the
  // command at it (HTTP_PROXY), and constrain the sandbox to that socket.
  let netClose: () => Promise<void> = async () => {};
  if (profile.network === "restricted") {
    // Credential masking via shared resolver (P0). Manual: KERYX_SANDBOX_MASK_ENV.
    // Auto: KERYX_SANDBOX_MASK_MODE=auto derives NAME@host from provider registry
    // for non-empty keys (after applySavedApiKeys). Fail-closed TLS (ADR-0007).
    const resolved = resolveShellRestrictedMasks(env, undefined, root);
    if (!resolved.ok) {
      return { ok: false, result: { output: `shell_exec: ${resolved.reason}`, isError: true } };
    }
    const { masks, tlsTerminate } = resolved;
    const net = await setupNetworkRun(profile, {
      ...(masks.length > 0 ? { masks } : {}),
      ...(tlsTerminate ? { tlsTerminate: true } : {}),
    });
    profile = net.profile;
    netClose = net.close;
    for (const [k, v] of Object.entries(net.envAdditions)) env[k] = v;
  }

  const wrapped = wrapWithSandbox(
    { path: "/bin/sh", argv: ["sh", "-c", command], env, cwd: root },
    profile,
    { platform: process.platform, ...(launcher.path ? { bwrapPath: launcher.path } : {}) },
  );
  if (!wrapped.ok) {
    await netClose();
    return { ok: false, result: { output: `shell_exec: sandbox refused the command: ${wrapped.reason}`, isError: true } };
  }
  const spawnArgs = [wrapped.command.path, ...wrapped.command.argv.slice(1)];
  return { ok: true, plan: { spawnArgs, env, netClose } };
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
      const resolved = await resolveSandboxedSpawn(root, command, baseEnv);
      if (!resolved.ok) {
        return resolved.result;
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
