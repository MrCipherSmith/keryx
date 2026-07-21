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
import { defaultSandboxProfile } from "../../process/sandbox/profile";
import type { SandboxProfile } from "../../process/sandbox/profile";
import { detectSandboxLauncher } from "../../process/sandbox/detect";
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
 * Build the agent-shell sandbox profile for `mode` (never `off`). A domain
 * allowlist (env or project policy) switches network to `restricted`
 * (only those hosts via the loopback proxy), overriding the mode's on/off.
 */
function shellSandboxProfile(root: string, mode: Exclude<ShellSandboxMode, "off">, env: Record<string, string | undefined>): SandboxProfile {
  const base = defaultSandboxProfile(canonical(root), canonical(tmpdir()), homedir());
  const writableRoots = [...base.writableRoots, ...extraWritableRoots(env)];
  const domains = resolveAllowedDomains(env, root);
  if (domains.length > 0) {
    return { ...base, writableRoots, network: "restricted", allowedDomains: domains };
  }
  return { ...base, writableRoots, network: mode === "strict" ? "off" : "on" };
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
      // Ensure keys entered in `keryx shell` (auth.json) are on process.env, then
      // pass env explicitly so the child always sees them (some hosts inherit
      // inconsistently when only cwd/stdout are set).
      const { applySavedApiKeys } = await import("../../../lib/shell-config");
      applySavedApiKeys();
      const env: Record<string, string> = {};
      for (const [k, v] of Object.entries(process.env)) {
        if (typeof v === "string") {
          env[k] = v;
        }
      }

      // Default argv: `sh -c <command>`. When the sandbox is enabled, wrap it in
      // the platform launcher; fail closed if the launcher is unavailable.
      let spawnArgs = ["/bin/sh", "-c", command];
      const mode = resolveShellSandboxMode(process.env);
      if (mode !== "off") {
        let profile = shellSandboxProfile(root, mode, process.env);
        const launcher = detectSandboxLauncher();
        if (!launcher.available) {
          return {
            output: `shell_exec: OS sandbox requested (KERYX_SANDBOX_SHELL=${mode}) but the launcher is unavailable (${launcher.reason ?? "unknown"}); failing closed. Install it or set KERYX_SANDBOX_SHELL=off.`,
            isError: true,
          };
        }
        // Restricted network: start the loopback allowlist proxy, point the
        // command at it (HTTP_PROXY), and constrain the sandbox to that socket.
        if (profile.network === "restricted") {
          // Credential masking via shared resolver (P0). Manual: KERYX_SANDBOX_MASK_ENV.
          // Auto: KERYX_SANDBOX_MASK_MODE=auto derives NAME@host from provider registry
          // for non-empty keys (after applySavedApiKeys). Fail-closed TLS (ADR-0007).
          const resolved = resolveShellRestrictedMasks(env, undefined, root);
          if (!resolved.ok) {
            return { output: `shell_exec: ${resolved.reason}`, isError: true };
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
          return { output: `shell_exec: sandbox refused the command: ${wrapped.reason}`, isError: true };
        }
        spawnArgs = [wrapped.command.path, ...wrapped.command.argv.slice(1)];
      }

      const proc = Bun.spawn(spawnArgs, {
        cwd: root,
        stdout: "pipe",
        stderr: "pipe",
        env,
      });
      const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      const exit = await proc.exited;
      const combined = `${stdout}${stderr.length > 0 ? `\n${stderr}` : ""}`.trim();
      const bounded =
        combined.length > MAX_OUTPUT_BYTES
          ? `${combined.slice(0, MAX_OUTPUT_BYTES)}\n…(truncated)`
          : combined;
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
 * requires approval before this ever executes.
 */
export function shellExecTool(root: string, run: CommandRunner = makeCommandRunner(root)): InteractiveTool {
  return {
    definition: {
      name: "shell_exec",
      description:
        "Run a shell command in the project root (e.g. `git status`, `bun test`). Requires the user's approval before it runs. Input: { command: string }.",
      inputSchema: {
        type: "object",
        properties: { command: { type: "string" } },
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
      return run(command);
    },
  };
}
