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

export { SUBSYSTEM_CTX_GUARD, SUBSYSTEM_ORIENT, SUBSYSTEM_SECURITY } from "./types";

export {
  HARNESS_ADAPTERS,
  SETTINGS_FILE_OWNERS,
  allowAction,
  assertRegistryCoherent,
  decisionCodecFor,
  getHarnessAdapter,
  harnessAdapterIds,
  refusalAction,
  settingsFileOwnerFor,
  surfacesOf,
} from "./registry";

export { createSettingsFileOwner, installSurfaces, uninstallSurfaces } from "./settings-file";

// F10: NOT exported here — `mergeIntoHookArray`, `addSentinelTo`,
// `removeSentinelFrom`, `stripFromHookArray`, `stripManagedBy` are raw
// mutation primitives a caller outside this directory should never reach for
// directly: every WRITE goes through a `SurfaceAdapter`'s own `merge`/`strip`
// and then a `SettingsFileOwner` (`installSurfaces`/`uninstallSurfaces`
// above), which is what actually enforces the coherence/validation
// guarantees this registry exists for. `readSettingsFile`/`writeSettingsFile`
// are held to the same bar for the same reason (a caller reading the file
// itself, bypassing `installSurfaces`, is one step from also writing it
// bypassing `SettingsFileOwner`) even though a read alone cannot corrupt
// anything; `src/ctx/hook-install.ts` is the one documented exception (it
// reads the pre-merge state to report what an install would upgrade) and
// imports it from the deep path for exactly that reason. All of these stay
// importable from the deep module path (`src/integrations/settings-json.ts`)
// for this directory's own surfaces and for tests that need to construct
// fixtures directly.
export { MANAGED_KEY, arrayAt, hooksObject, isManagedBy, managedGroups } from "./settings-json";
export type { GroupShape, ManagedGroupsQuery } from "./settings-json";

export {
  ANTIGRAVITY_DECISION_CODEC,
  CURSOR_DECISION_CODEC,
  EXIT_CODE_DECISION_CODEC,
  parseToolName,
} from "./codecs";

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
