import { pathExists } from "../lib/fs";
import { installSurfaces, settingsFileOwnerFor, uninstallSurfaces } from "../integrations";
import {
  CLAUDE_RUNTIME,
  MANAGED_KEY,
  getRuntime,
  runtimeIds,
  type RuntimeHook,
} from "./agent-hooks/runtimes";

const SECURITY_SURFACE_IDS = ["security-check-input", "security-check-output"] as const;

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
  checkInputCommand,
  checkOutputCommand,
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

// Install the managed guard hooks for one runtime, creating the settings file
// if absent, preserving every pre-existing key/entry, and staying idempotent.
// Routes through the runtime's `SettingsFileOwner` so this install can never
// silently invalidate a ctx-guard/orient surface sharing the same file.
// Returns the owner's errors (empty = written and valid) instead of
// discarding them, so a caller (CLI, or `installSecurityAgentHooks` below)
// can tell a refused write from a successful one.
export async function installRuntimeHooks(
  projectRoot: string,
  runtime: RuntimeHook,
): Promise<{ ok: boolean; errors: string[] }> {
  const owner = settingsFileOwnerFor(runtime.relativePath);
  if (!owner) {
    // Every registered runtime's file has an owner (derived from the same
    // registry these surfaces come from) — unreachable in practice.
    throw new Error(`${runtime.id}: no settings-file owner registered for ${runtime.relativePath}`);
  }
  const { errors } = await installSurfaces(projectRoot, runtime.relativePath, [...SECURITY_SURFACE_IDS], owner);
  return { ok: errors.length === 0, errors };
}

// Remove ONLY the managed guard hooks for one runtime, preserving user content.
// Returns the owner's errors alongside whether anything was removed.
export async function uninstallRuntimeHooks(
  projectRoot: string,
  runtime: RuntimeHook,
): Promise<{ ok: boolean; errors: string[] }> {
  const file = runtime.settingsPath(projectRoot);
  if (!(await pathExists(file))) {
    return { ok: false, errors: [] };
  }
  const owner = settingsFileOwnerFor(runtime.relativePath);
  if (!owner) {
    return { ok: false, errors: [] };
  }
  const { errors } = await uninstallSurfaces(projectRoot, runtime.relativePath, [...SECURITY_SURFACE_IDS], owner);
  return { ok: errors.length === 0, errors };
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
// Boolean-compatible for their existing callers, but a refused write now
// throws instead of silently returning `true`: `init`/`update` call these
// unguarded (no try/catch at the call site), so a thrown error propagates the
// same way any other failed install step in those commands does, rather than
// letting the manifest/CLI claim success for a write that never happened.
export async function installSecurityAgentHooks(projectRoot: string): Promise<boolean> {
  const { ok, errors } = await installRuntimeHooks(projectRoot, CLAUDE_RUNTIME);
  if (!ok) {
    throw new Error(`installSecurityAgentHooks: ${errors.join("; ")}`);
  }
  return true;
}

export async function uninstallSecurityAgentHooks(projectRoot: string): Promise<boolean> {
  const { ok, errors } = await uninstallRuntimeHooks(projectRoot, CLAUDE_RUNTIME);
  if (errors.length > 0) {
    throw new Error(`uninstallSecurityAgentHooks: ${errors.join("; ")}`);
  }
  return ok;
}

// Re-exported for callers that referenced the managed-key constant.
export { MANAGED_KEY };
