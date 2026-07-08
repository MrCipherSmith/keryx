import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathExists } from "../lib/fs";
import {
  AGENT_CHECK_INPUT_COMMAND,
  AGENT_CHECK_OUTPUT_COMMAND,
  AGENT_HOOKS_SENTINEL,
  CLAUDE_RUNTIME,
  MANAGED_KEY,
  getRuntime,
  runtimeIds,
  type RuntimeHook,
  type Settings,
} from "./agent-hooks/runtimes";

// Merge-safe installer for the Metaproject Security agent guard hooks. Block E
// generalizes the shipped Claude-Code installer over a multi-runtime registry
// (`agent-hooks/runtimes.ts`): `cursor`, `windsurf`, `generic-mcp` in addition
// to Claude Code. Each runtime routes agent input/output through the security
// CLI (`check-input` / `check-output`).
//
// #1 rule: never clobber user config. Every managed hook group carries a
// sentinel key so uninstall targets ONLY the entries this installer wrote; all
// pre-existing keys and user hook entries are preserved untouched, and re-install
// is idempotent (managed groups are stripped and re-appended, never duplicated).

export {
  AGENT_CHECK_INPUT_COMMAND,
  AGENT_CHECK_OUTPUT_COMMAND,
  AGENT_HOOKS_SENTINEL,
  runtimeIds,
} from "./agent-hooks/runtimes";
export type { RuntimeHook } from "./agent-hooks/runtimes";

export const AGENT_SETTINGS_RELATIVE_PATH = ".claude/settings.json";

export function agentSettingsPath(projectRoot: string): string {
  return CLAUDE_RUNTIME.settingsPath(projectRoot);
}

// Backwards-compatible accessor for the managed Claude hook groups.
export function securityAgentHookEntries(): {
  UserPromptSubmit: unknown;
  PreToolUse: unknown;
} {
  const rendered = CLAUDE_RUNTIME.merge({}) as {
    hooks: { UserPromptSubmit: unknown[]; PreToolUse: unknown[] };
  };
  return {
    UserPromptSubmit: rendered.hooks.UserPromptSubmit.at(-1),
    PreToolUse: rendered.hooks.PreToolUse.at(-1),
  };
}

async function readSettings(file: string): Promise<Settings> {
  if (!(await pathExists(file))) {
    return {};
  }
  try {
    const parsed = JSON.parse(await readFile(file, "utf8")) as unknown;
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Settings;
    }
    return {};
  } catch {
    throw new Error(`Cannot parse ${file}: file is not valid JSON`);
  }
}

async function writeSettings(file: string, settings: Settings): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
}

// Install the managed guard hooks for one runtime, creating the settings file if
// absent, preserving every pre-existing key/entry, and staying idempotent.
export async function installRuntimeHooks(
  projectRoot: string,
  runtime: RuntimeHook,
): Promise<boolean> {
  const file = runtime.settingsPath(projectRoot);
  const settings = await readSettings(file);
  const merged = runtime.merge(settings);
  await writeSettings(file, merged);
  return true;
}

// Remove ONLY the managed guard hooks for one runtime, preserving user content.
export async function uninstallRuntimeHooks(
  projectRoot: string,
  runtime: RuntimeHook,
): Promise<boolean> {
  const file = runtime.settingsPath(projectRoot);
  if (!(await pathExists(file))) {
    return false;
  }
  const settings = await readSettings(file);
  const stripped = runtime.strip(settings);
  await writeSettings(file, stripped);
  return true;
}

// Resolve requested runtime ids (`"all"` ⇒ every registered runtime). Unknown
// ids are reported so the CLI can surface them.
export function resolveRuntimes(ids: string[]): {
  runtimes: RuntimeHook[];
  unknown: string[];
} {
  const wanted = ids.includes("all") ? runtimeIds() : ids;
  const runtimes: RuntimeHook[] = [];
  const unknown: string[] = [];
  for (const id of wanted) {
    const runtime = getRuntime(id);
    if (runtime) runtimes.push(runtime);
    else unknown.push(id);
  }
  return { runtimes, unknown };
}

// Claude-Code convenience wrappers (shipped API — used by `init`/`update`).
export async function installSecurityAgentHooks(projectRoot: string): Promise<boolean> {
  return installRuntimeHooks(projectRoot, CLAUDE_RUNTIME);
}

export async function uninstallSecurityAgentHooks(projectRoot: string): Promise<boolean> {
  return uninstallRuntimeHooks(projectRoot, CLAUDE_RUNTIME);
}

// Re-exported for callers that referenced the managed-key constant.
export { MANAGED_KEY };
