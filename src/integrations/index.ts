// Flow 305 (W5-a): the public door of `src/integrations`. Everything outside
// this directory that needs the registry imports from here.

export type {
  AdapterKind,
  Confidence,
  DecisionCodec,
  HarnessAdapter,
  HookAction,
  PayloadCodec,
  Settings,
  SettingsFileOwner,
  SurfaceAdapter,
  SurfaceFlag,
  SurfaceSlot,
} from "./types";

export {
  HARNESS_ADAPTERS,
  SETTINGS_FILE_OWNERS,
  assertRegistryCoherent,
  getHarnessAdapter,
  harnessAdapterIds,
  settingsFileOwnerFor,
  surfacesOf,
} from "./registry";

export { createSettingsFileOwner, installSurfaces, uninstallSurfaces } from "./settings-file";

export {
  MANAGED_KEY,
  addSentinelTo,
  arrayAt,
  hooksObject,
  isManagedBy,
  managedGroups,
  mergeIntoHookArray,
  readSettingsFile,
  removeSentinelFrom,
  stripFromHookArray,
  stripManagedBy,
  writeSettingsFile,
} from "./settings-json";
export type { GroupShape, ManagedGroupsQuery } from "./settings-json";

export { allowAction, parseToolName, refusalAction } from "./codecs";

export {
  AGENT_CHECK_INPUT_COMMAND,
  AGENT_CHECK_OUTPUT_COMMAND,
  AGENT_HOOKS_SENTINEL,
  CTX_GUARD_ANTIGRAVITY,
  CTX_GUARD_CLAUDE,
  CTX_GUARD_CODEX,
  CTX_GUARD_CURSOR,
  CTX_GUARD_OPENCODE,
  CTX_GUARD_WINDSURF,
  CTX_HOOK_SENTINEL,
  ORIENT_CLAUDE,
  ORIENT_CODEX,
  ORIENT_CURSOR,
  ORIENT_SENTINEL,
  SECURITY_CHECK_INPUT_CLAUDE,
  SECURITY_CHECK_INPUT_CURSOR,
  SECURITY_CHECK_INPUT_GENERIC_MCP,
  SECURITY_CHECK_INPUT_WINDSURF,
  SECURITY_CHECK_OUTPUT_CLAUDE,
  SECURITY_CHECK_OUTPUT_CURSOR,
  SECURITY_CHECK_OUTPUT_GENERIC_MCP,
  SECURITY_CHECK_OUTPUT_WINDSURF,
  SECURITY_HOOKS_KEY,
  UNSUPPORTED_CTX_GUARD,
  UNSUPPORTED_ORIENT,
  checkInputCommand,
  checkOutputCommand,
  ctxHookCommand,
  orientHookCommand,
  preToolUseMatcher,
} from "./surfaces";
