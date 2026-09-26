// Flow 305 (W5-a): the public door of `src/integrations`. Everything outside
// this directory that needs the registry imports from here.
//
// Named `service.ts` (not `index.ts`) to match the facade convention the
// other core owners already use (see `src/lib/import-policy.ts`'s
// `client-imports-core-internal` rule, which recognizes a compliant import
// only by that literal basename) — a `../integrations` directory import
// resolves to this file's module specifier only when it is imported as
// `../integrations/service`.

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
  SUBSYSTEM_ACP_PERMISSION,
  SUBSYSTEM_AGENTS,
  SUBSYSTEM_CTX_GUARD,
  SUBSYSTEM_INSTRUCTIONS,
  SUBSYSTEM_LEARNING,
  SUBSYSTEM_ORIENT,
  SUBSYSTEM_RULES_EXPORT,
  SUBSYSTEM_SECURITY,
} from "./types";

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
  COPILOT_DECISION_CODEC,
  CURSOR_DECISION_CODEC,
  EXIT_CODE_DECISION_CODEC,
  parseCopilotToolArgsCommand,
  parseKiroCommand,
  parseRunShellCommandInput,
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
  nestedCtxSurface,
  orientHookCommand,
  preToolUseMatcher,
} from "./surfaces";

export {
  installedRulesExportHarnesses,
  renderRulesForHarnesses,
  type RulesExportResult,
} from "./rules-export";

// Flow 343: the Jev EDIT GUARD's own standalone `PostToolUse` surface — see
// `./jev-edit-guard-surface.ts`'s header for why it is exported here rather
// than added to `HARNESS_ADAPTERS`.
export {
  EDIT_GUARD_CLAUDE_SETTINGS_RELATIVE_PATH,
  EDIT_GUARD_HOOK_MATCHER,
  EDIT_GUARD_HOOK_SENTINEL,
  JEV_EDIT_GUARD_SURFACE,
  editGuardHookCommand,
} from "./jev-edit-guard-surface";

export {
  ACP_PERMISSION_ZED,
  CTX_GUARD_GEMINI_CLI,
  CTX_GUARD_GITHUB_COPILOT_AGENT,
  CTX_GUARD_KIRO,
  INSTRUCTIONS_GEMINI_CLI,
  INSTRUCTIONS_GITHUB_COPILOT_AGENT,
  INSTRUCTIONS_KIRO,
  INSTRUCTIONS_ZED,
  KERYX_SHELL_UNSUPPORTED,
  KERYX_SHELL_UNSUPPORTED_REASON,
  LAST_VERIFIED_W5B,
} from "./surfaces-w5b";

export {
  LEARNING_OBSERVER_CLAUDE,
  LEARNING_OBSERVER_EVENTS,
  LEARNING_OBSERVER_SENTINEL,
  learningObserverCommand,
} from "./surfaces-learning";

export {
  INSTRUCTIONS_END_MARKER,
  INSTRUCTIONS_START_MARKER,
  inspectMarkdownBlock,
  installMarkdownBlock,
  probeMarkdownBlock,
  renderInstructionsBlock,
  uninstallMarkdownBlock,
  type MarkdownBlockInspection,
} from "./markdown-block";

// ---------------------------------------------------------------------------
// Flow 307 (W5-b), T6: the installer core (install/uninstall/doctor per
// runtime, with per-surface install-state) — new modules, appended here
// rather than interleaved with the W5-a exports above.
// ---------------------------------------------------------------------------
export {
  INSTALL_STATE_SCHEMA_VERSION,
  installStatePath,
  readInstallState,
  recordSurfaceInstalled,
  recordSurfaceUninstalled,
  sha256OfFile,
} from "./install-state";
export type { InstallState, InstalledModuleRecord } from "./install-state";

export {
  doctorIntegration,
  installIntegration,
  resolveSurfaceSelection,
  uninstallIntegration,
} from "./installer";
export type {
  DoctorIntegrationResult,
  DoctorSurfaceResult,
  InstallIntegrationResult,
  InstallOptions,
  InstallSurfaceStatus,
  SurfaceResult,
  UninstallIntegrationResult,
  UninstallSurfaceStatus,
} from "./installer";

// T8: the generated capability matrix — re-exported here too so the CLI
// command (an adapter-zone caller) can reach it through this one door
// instead of importing `./matrix` directly.
export {
  DEFAULT_MATRIX_ARTIFACT,
  SURFACE_FLAG_ORDER,
  checkCapabilityMatrix,
  generateCapabilityMatrix,
  writeCapabilityMatrix,
} from "./matrix";
export type { CapabilityMatrixDocument } from "./matrix";
