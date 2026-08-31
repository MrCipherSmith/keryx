// Shared spawn preparation for foreground and background agent-shell commands.
// Keep this below the tool layer: both callers must receive the same saved
// credentials, sandbox posture, restricted-network proxy, and fail-closed
// sandbox-launcher behaviour.

import { realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { defaultSandboxProfile } from "./sandbox/profile";
import type { SandboxProfile } from "./sandbox/profile";
import { detectSandboxLauncher } from "./sandbox/detect";
import type { DetectOptions } from "./sandbox/detect";
import { wrapWithSandbox } from "./sandbox/wrap";
import { setupNetworkRun } from "./sandbox/network-run";
import type { MaskedCredential } from "./sandbox/network-run";
import {
  buildDefaultMaskProviders,
  resolveAllowedDomains,
  resolveMasksFromSandboxEnv,
} from "./sandbox/mask-resolve";
import { OPENAI_COMPAT_PROVIDERS } from "../../commands/providers";
import { loadSandboxDefaults } from "../../lib/sandbox-config";

export type ShellSandboxMode = "off" | "workspace" | "strict";

export interface SandboxSpawnPlan {
  spawnArgs: string[];
  env: Record<string, string>;
  netClose: () => Promise<void>;
}

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
    const configured = loadSandboxDefaults(sandboxConfigDir).shell;
    raw = typeof configured === "string" ? configured.toLowerCase() : "";
  }
  if (raw === "strict") return "strict";
  if (raw === "workspace" || raw === "1" || raw === "on") return "workspace";
  return "off";
}

function canonical(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

function rootsFromEnv(name: string, env: Record<string, string | undefined>): string[] {
  const raw = env[name];
  if (!raw) return [];
  return raw
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
    .map((p) => canonical(p.startsWith("~/") ? p.replace(/^~/, homedir()) : p));
}

function extraWritableRoots(env: Record<string, string | undefined>): string[] {
  return rootsFromEnv("KERYX_SANDBOX_ALLOW_WRITE", env);
}

export function extraReadDenyRoots(env: Record<string, string | undefined>): string[] {
  return rootsFromEnv("KERYX_SANDBOX_READ_DENY", env);
}

function shellSandboxProfile(
  root: string,
  mode: Exclude<ShellSandboxMode, "off">,
  env: Record<string, string | undefined>,
): SandboxProfile {
  const base = defaultSandboxProfile(canonical(root), canonical(tmpdir()), canonical(homedir()));
  const writableRoots = [...base.writableRoots, ...extraWritableRoots(env)];
  const readDenyList = [...base.readDenyList, ...extraReadDenyRoots(env)];
  const domains = resolveAllowedDomains(env, root);
  if (domains.length > 0) {
    return { ...base, writableRoots, readDenyList, network: "restricted", allowedDomains: domains };
  }
  return { ...base, writableRoots, readDenyList, network: mode === "strict" ? "off" : "on" };
}

export function resolveShellRestrictedMasks(
  env: Record<string, string | undefined>,
  sandboxConfigDir?: string,
  projectRoot?: string,
):
  | { ok: true; masks: MaskedCredential[]; tlsTerminate: boolean }
  | { ok: false; reason: string } {
  const result = resolveMasksFromSandboxEnv({
    env,
    providers: buildDefaultMaskProviders(OPENAI_COMPAT_PROVIDERS),
    ...(sandboxConfigDir === undefined ? {} : { sandboxConfigDir }),
    ...(projectRoot === undefined ? {} : { projectRoot }),
  });
  if (!result.ok) return { ok: false, reason: result.reason };
  return {
    ok: true,
    masks: result.resolution.masks.map((mask) => ({
      name: mask.name,
      realValue: env[mask.name] ?? "",
      injectHosts: mask.injectHosts,
    })),
    tlsTerminate: result.resolution.tlsTerminate,
  };
}

export async function resolveShellEnv(): Promise<Record<string, string>> {
  const { applySavedApiKeys } = await import("../../lib/shell-config");
  applySavedApiKeys();
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string") env[key] = value;
  }
  return env;
}

export async function resolveShellSpawn(
  root: string,
  command: string,
  baseEnv: Record<string, string>,
  detectOpts?: DetectOptions,
): Promise<{ ok: true; plan: SandboxSpawnPlan } | { ok: false; error: string }> {
  const env = { ...baseEnv };
  const mode = resolveShellSandboxMode(process.env);
  if (mode === "off") {
    return { ok: true, plan: { spawnArgs: ["/bin/sh", "-c", command], env, netClose: async () => {} } };
  }

  let profile = shellSandboxProfile(root, mode, process.env);
  const launcher = detectSandboxLauncher(detectOpts);
  if (!launcher.available) {
    return {
      ok: false,
      error: `shell_exec: OS sandbox requested (KERYX_SANDBOX_SHELL=${mode}) but the launcher is unavailable (${launcher.reason ?? "unknown"}); failing closed. Install it or set KERYX_SANDBOX_SHELL=off.`,
    };
  }

  let netClose: () => Promise<void> = async () => {};
  if (profile.network === "restricted") {
    const masks = resolveShellRestrictedMasks(env, undefined, root);
    if (!masks.ok) return { ok: false, error: `shell_exec: ${masks.reason}` };
    const net = await setupNetworkRun(profile, {
      ...(masks.masks.length === 0 ? {} : { masks: masks.masks }),
      ...(masks.tlsTerminate ? { tlsTerminate: true } : {}),
    });
    profile = net.profile;
    netClose = net.close;
    Object.assign(env, net.envAdditions);
  }

  const wrapped = wrapWithSandbox(
    { path: "/bin/sh", argv: ["sh", "-c", command], env, cwd: root },
    profile,
    { platform: process.platform, ...(launcher.path === undefined ? {} : { bwrapPath: launcher.path }) },
  );
  if (!wrapped.ok) {
    await netClose();
    return { ok: false, error: `shell_exec: sandbox refused the command: ${wrapped.reason}` };
  }
  return {
    ok: true,
    plan: { spawnArgs: [wrapped.command.path, ...wrapped.command.argv.slice(1)], env, netClose },
  };
}
