import path from "node:path";
import {
  AGENT_CHECK_INPUT_COMMAND,
  AGENT_CHECK_OUTPUT_COMMAND,
  AGENT_HOOKS_SENTINEL,
  HARNESS_ADAPTERS,
  SECURITY_HOOKS_KEY,
  checkInputCommand,
  checkOutputCommand,
  isManagedBy,
  surfacesOf,
  type Settings as IntegrationSettings,
  type SurfaceAdapter,
} from "../../integrations/service";

// Multi-runtime agent-hook registry (Block E, E5). Each supported agent runtime
// declares WHERE its settings live, HOW to merge/strip the managed security
// guard entries (preserving user content), and a validator that proves the
// rendered config routes input/output through the security CLI.
//
// This module is a VIEW over `src/integrations` (flow 305, W5-a): the
// registry actually splits security into two independent surfaces per
// harness — `security-check-input` and `security-check-output` — so either
// can be installed/uninstalled on its own without the shared sentinel lying
// about the other (see `src/integrations/surfaces.ts`). `RuntimeHook` below
// composes the pair back into the single merge/strip/validate shape this
// module has always exposed, in canonical order (input, then output), which
// reproduces byte-identical output to the pre-split installer.
//
// Every runtime shares the sentinel discipline (`_keryxManaged`): managed
// entries are tagged so a targeted uninstall removes ONLY this installer's
// entries and a re-install never duplicates them. Claude Code keeps its shipped
// event-keyed `.claude/settings.json` schema; the other runtimes use a flat
// managed-groups array so their (still-evolving, OQ-3) schemas stay simple and
// validator-checked.

export { AGENT_HOOKS_SENTINEL, SECURITY_HOOKS_KEY };
export const MANAGED_KEY = "_keryxManaged";

export { AGENT_CHECK_INPUT_COMMAND, AGENT_CHECK_OUTPUT_COMMAND, checkInputCommand, checkOutputCommand };

export type Settings = IntegrationSettings;

export interface RuntimeHook {
  readonly id: string;
  // Absolute settings-file path for this runtime under a project root.
  settingsPath(projectRoot: string): string;
  /** Path relative to the project root, for `SettingsFileOwner` lookup. */
  readonly relativePath: string;
  // Merge the managed entries into `settings`, preserving user content and
  // staying idempotent. Returns the settings object to write.
  merge(settings: Settings): Settings;
  // Remove ONLY the managed entries + sentinel, preserving user content.
  strip(settings: Settings): Settings;
  // Structural validation of a rendered config: empty array = valid.
  validate(settings: Settings): string[];
}

export function isManagedGroup(value: unknown): boolean {
  return isManagedBy(AGENT_HOOKS_SENTINEL)(value);
}

/** Compose two independently-installable surfaces into one legacy RuntimeHook. */
function composed(id: string, relativePath: string, input: SurfaceAdapter, output: SurfaceAdapter): RuntimeHook {
  return {
    id,
    relativePath,
    settingsPath: (root) => path.join(root, ...relativePath.split("/")),
    merge: (s) => output.merge!(input.merge!(s)),
    strip: (s) => output.strip!(input.strip!(s)),
    validate: (s) => [...input.validate!(s), ...output.validate!(s)],
  };
}

// Built by mapping over `HARNESS_ADAPTERS`, in registry order (flow 305
// review fix, F4) — an adapter contributes a `RuntimeHook` only when it
// registers BOTH a security "prompt-gate" (check-input) and a security
// "block" (check-output) surface; every other adapter (codex, antigravity,
// opencode, zed today) is silently skipped, so this list can never drift
// from what the registry actually declares.
export const RUNTIME_HOOKS: RuntimeHook[] = HARNESS_ADAPTERS.flatMap((adapter) => {
  const input = surfacesOf(adapter, { subsystem: "security", flag: "prompt-gate" })[0];
  const output = surfacesOf(adapter, { subsystem: "security", flag: "block" })[0];
  if (!input || !output) return [];
  return [composed(adapter.id, input.relativePath!, input, output)];
});

function runtimeFor(id: string): RuntimeHook {
  const runtime = RUNTIME_HOOKS.find((r) => r.id === id);
  if (!runtime) throw new Error(`integrations registry: no security runtime registered for "${id}"`);
  return runtime;
}

export const CLAUDE_RUNTIME: RuntimeHook = runtimeFor("claude");

export function runtimeIds(): string[] {
  return RUNTIME_HOOKS.map((r) => r.id);
}

export function getRuntime(id: string): RuntimeHook | undefined {
  return RUNTIME_HOOKS.find((r) => r.id === id);
}
