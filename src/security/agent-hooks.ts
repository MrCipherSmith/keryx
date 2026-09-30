import { readFile } from "node:fs/promises";
import { installIntegration, settingsFileOwnerFor, uninstallIntegration, type SettingsFileOwner } from "../integrations/service";
import {
  AGENT_HOOKS_SENTINEL,
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

/**
 * The Claude settings file this project's security agent hooks live in,
 * relative to the project root — what `modules.security.hooks.agent` records.
 * Resolved per project (flow 361): `.claude/settings.local.json` unless the
 * manifest's `agentEntrypoints.claudeSettings` is shared.
 */
export function agentSettingsRelativePath(projectRoot: string): string {
  return CLAUDE_RUNTIME.relativePathFor(projectRoot);
}

export function agentSettingsPath(projectRoot: string): string {
  return CLAUDE_RUNTIME.settingsPath(projectRoot);
}

/**
 * True when the project's Claude settings file still carries the managed
 * security agent-hook sentinel, i.e. the agent hooks are installed there.
 * The one probe `init` and `update` reconcile a disabled hook against.
 */
export async function agentSettingsHasSecuritySentinel(projectRoot: string): Promise<boolean> {
  try {
    return (await readFile(agentSettingsPath(projectRoot), "utf8")).includes(AGENT_HOOKS_SENTINEL);
  } catch {
    return false;
  }
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
// Delegates to the installer core (flow 307, W5-b, T6: `installIntegration`
// in `src/integrations/installer.ts`), which routes through the runtime's
// `SettingsFileOwner` so this install can never silently invalidate a
// ctx-guard/orient surface sharing the same file, and records install-state.
// Returns the owner's errors (empty = written and valid) instead of
// discarding them, so a caller (CLI, or `installSecurityAgentHooks` below)
// can tell a refused write from a successful one.
export async function installRuntimeHooks(
  projectRoot: string,
  runtime: RuntimeHook,
  owner: SettingsFileOwner | undefined = settingsFileOwnerFor(runtime.relativePathFor(projectRoot)),
): Promise<{ ok: boolean; errors: string[] }> {
  if (!owner) {
    // Every registered runtime's file has an owner (derived from the same
    // registry these surfaces come from) — unreachable in practice.
    throw new Error(`${runtime.id}: no settings-file owner registered for ${runtime.relativePathFor(projectRoot)}`);
  }
  const { errors } = await installIntegration(projectRoot, runtime.id, {
    surfaces: [...SECURITY_SURFACE_IDS],
    ownerOverride: owner,
  });
  return { ok: errors.length === 0, errors };
}

// Remove ONLY the managed guard hooks for one runtime, preserving user content.
// Returns the owner's errors alongside whether anything was removed.
export async function uninstallRuntimeHooks(
  projectRoot: string,
  runtime: RuntimeHook,
  owner: SettingsFileOwner | undefined = settingsFileOwnerFor(runtime.relativePathFor(projectRoot)),
): Promise<{ ok: boolean; errors: string[] }> {
  if (!owner) {
    return { ok: false, errors: [] };
  }
  const { results, errors } = await uninstallIntegration(projectRoot, runtime.id, {
    surfaces: [...SECURITY_SURFACE_IDS],
    ownerOverride: owner,
  });
  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return { ok: results.some((r) => r.status === "removed"), errors: [] };
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
