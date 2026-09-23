import path from "node:path";
import {
  AGENT_CHECK_INPUT_COMMAND,
  AGENT_CHECK_OUTPUT_COMMAND,
  AGENT_HOOKS_SENTINEL,
  SECURITY_CHECK_INPUT_CLAUDE,
  SECURITY_CHECK_INPUT_CURSOR,
  SECURITY_CHECK_INPUT_GENERIC_MCP,
  SECURITY_CHECK_INPUT_WINDSURF,
  SECURITY_CHECK_OUTPUT_CLAUDE,
  SECURITY_CHECK_OUTPUT_CURSOR,
  SECURITY_CHECK_OUTPUT_GENERIC_MCP,
  SECURITY_CHECK_OUTPUT_WINDSURF,
  SECURITY_HOOKS_KEY,
  checkInputCommand,
  checkOutputCommand,
  isManagedBy,
  type Settings as IntegrationSettings,
  type SurfaceAdapter,
} from "../../integrations";

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

export const CLAUDE_RUNTIME: RuntimeHook = composed(
  "claude",
  ".claude/settings.json",
  SECURITY_CHECK_INPUT_CLAUDE,
  SECURITY_CHECK_OUTPUT_CLAUDE,
);

export const RUNTIME_HOOKS: RuntimeHook[] = [
  CLAUDE_RUNTIME,
  composed("cursor", ".cursor/hooks.json", SECURITY_CHECK_INPUT_CURSOR, SECURITY_CHECK_OUTPUT_CURSOR),
  composed("windsurf", ".windsurf/hooks.json", SECURITY_CHECK_INPUT_WINDSURF, SECURITY_CHECK_OUTPUT_WINDSURF),
  composed("generic-mcp", ".mcp/security-hooks.json", SECURITY_CHECK_INPUT_GENERIC_MCP, SECURITY_CHECK_OUTPUT_GENERIC_MCP),
];

export function runtimeIds(): string[] {
  return RUNTIME_HOOKS.map((r) => r.id);
}

export function getRuntime(id: string): RuntimeHook | undefined {
  return RUNTIME_HOOKS.find((r) => r.id === id);
}
