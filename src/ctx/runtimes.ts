import { buildBlockMessage, classifyCommand, type HookClassification } from "./hook-classify";
import {
  CTX_GUARD_ANTIGRAVITY,
  CTX_GUARD_CLAUDE,
  CTX_GUARD_CODEX,
  CTX_GUARD_CURSOR,
  CTX_GUARD_OPENCODE,
  CTX_GUARD_WINDSURF,
  CTX_HOOK_SENTINEL,
  UNSUPPORTED_CTX_GUARD,
  allowAction,
  managedGroups,
  parseToolName,
  preToolUseMatcher as registryPreToolUseMatcher,
  refusalAction,
  type HarnessAdapter,
  type HookAction,
  type Settings as IntegrationSettings,
  type SurfaceAdapter,
} from "../integrations";

// Multi-harness registry for the gdctx routing guard. This module is a VIEW
// over `src/integrations` (flow 305, W5-a): every merge/strip/validate
// function below is the SAME function object registered on the matching
// `SurfaceAdapter` in `src/integrations/surfaces.ts` — there is exactly one
// copy of the walker logic (`src/integrations/settings-json.ts`), and this
// file only re-shapes it into the `CtxRuntime` interface every existing
// caller and test already imports.
//
// What differs per harness is only:
//   1. WHERE the pre-exec hook is configured (settings path + schema),
//   2. HOW the harness hands the command to the hook (payload format),
//   3. HOW the hook signals BLOCK vs ALLOW back to the harness,
//   4. WHAT install artifact is written (a JSON config group, or a plugin file).
//
// Contracts confirmed against first-party docs are `confidence: "verified"`;
// those from community docs are `confidence: "experimental"` and print a
// warning at install time. Harnesses with no scriptable pre-exec gate (e.g.
// Zed today) are NOT registered.
//
// Sentinel discipline: managed JSON groups carry `_keryxManaged:"ctx-agent-hooks"`
// so uninstall removes ONLY our entry and re-install is idempotent.

export { CTX_HOOK_SENTINEL };
export const MANAGED_KEY = "_keryxManaged";

export type Settings = IntegrationSettings;
export type { HookAction };
export type Confidence = "verified" | "experimental";

/** How a runtime spells an installed hook — see `CtxRuntime.groupShape`. */
export type GroupShape = "flat" | "nested";

export interface CtxRuntime {
  readonly id: string;
  readonly label: string;
  readonly confidence: Confidence;
  parseCommand(payload: string): string | null;
  readonly nativeSearchTools?: readonly string[];
  readonly groupShape: GroupShape;
  readonly groupKey: string;
  readonly groupContainer?: string;
  /** Path relative to the project root, for `SettingsFileOwner` lookup. Absent for non-JSON artifacts. */
  readonly relativePath?: string;
  block(command: string, classification: HookClassification): HookAction;
  allow(classification: HookClassification): HookAction;
  locate(projectRoot: string): string;
  merge?(settings: Settings): Settings;
  strip?(settings: Settings): Settings;
  validate?(settings: Settings): string[];
  customInstall?(projectRoot: string): Promise<string[]>;
  customUninstall?(projectRoot: string): Promise<boolean>;
}

function hookCommand(id: string): string {
  return `keryx ctx hook ${id}`;
}

/** The matcher a runtime installs: the shell, plus its own native search tools. */
export function preToolUseMatcher(runtime: Pick<CtxRuntime, "nativeSearchTools">): string {
  return registryPreToolUseMatcher(runtime.nativeSearchTools);
}

/**
 * What an install would REPLACE, read before the merge — or null if nothing
 * stale is there. See `src/integrations/settings-json.ts::managedGroups` for
 * the shared presence/staleness walker this is built from.
 */
export function describeExistingGuard(settings: Settings, runtime: CtxRuntime): string | null {
  const expected = preToolUseMatcher(runtime);
  const present = managedGroups(settings, {
    sentinel: CTX_HOOK_SENTINEL,
    container: runtime.groupContainer ?? "hooks",
    key: runtime.groupKey,
    shape: runtime.groupShape,
    commandMatches: (c) => c === hookCommand(runtime.id),
  });
  if (present.length === 0) return null;
  const stale = present.some((g) => typeof g.matcher !== "string" || g.matcher !== expected);
  if (!stale) return null;
  const found = present.map((group) => (typeof group.matcher === "string" ? group.matcher : "(no matcher)")).join(", ");
  return `upgraded an existing guard: ${found} -> ${expected}`;
}

/**
 * Refusal for a native search tool. It names the replacement rather than only
 * denying, and it is escapable in practice even though it carries no in-line
 * marker of its own: `keryx ctx rg` does the same job, and a Bash command with
 * `# keryx:raw <reason>` remains available for anything raw.
 */
export function nativeSearchMessage(tool: string): string {
  return [
    `[keryx ctx] The \`${tool}\` tool searches project code without the gdctx routing layer.`,
    `Use instead:  keryx ctx rg "<pattern>" [path]`,
    `The routed form is compressed and recorded in the routing audit (ctx_used).`,
    `Structural question (callers, usages, blast radius)? Use gdgraph first.`,
    `If raw output is genuinely required, run it through Bash with an escape marker:`,
    `  rg "<pattern>" <path>   # keryx:raw <why raw is needed>`,
  ].join("\n");
}

export { parseToolName, refusalAction, allowAction };

// --- per-harness payload parsers (re-exported for direct callers/tests) ------

import { parseAntigravityCommand, parseCursorCommand, parseToolInputCommand, parseWindsurfCommand } from "../integrations/codecs";

// Exit-2 + stderr (Claude, Codex, Windsurf, OpenCode bridge).
function exitCodeBlock(command: string, c: HookClassification): HookAction {
  return refusalAction("claude", buildBlockMessage(command, c));
}
function exitCodeAllow(c: HookClassification): HookAction {
  if (c.escapeReason !== undefined) {
    const reason = c.escapeReason || "(no reason given)";
    return { exitCode: 0, stderr: `[keryx ctx] raw command allowed via escape marker — reason: ${reason}\n` };
  }
  return { exitCode: 0 };
}

// Cursor: stdout { permission: "deny", agent_message } / { permission: "allow" }.
function cursorBlock(command: string, c: HookClassification): HookAction {
  return refusalAction("cursor", buildBlockMessage(command, c));
}
function cursorAllow(_c: HookClassification): HookAction {
  return { exitCode: 0, stdout: `${JSON.stringify({ permission: "allow" })}\n` };
}

// Antigravity: stdout top-level { allow_tool, deny_reason }; always exit 0.
function antigravityBlock(command: string, c: HookClassification): HookAction {
  return refusalAction("antigravity", buildBlockMessage(command, c));
}
function antigravityAllow(_c: HookClassification): HookAction {
  return { exitCode: 0, stdout: `${JSON.stringify({ allow_tool: true })}\n` };
}

// --- runtime definitions: shaped views over the registry's ctx-guard surfaces

function asRuntime(opts: {
  id: string;
  label: string;
  confidence: Confidence;
  groupShape: GroupShape;
  groupKey: string;
  groupContainer?: string;
  nativeSearchTools?: readonly string[];
  parseCommand(payload: string): string | null;
  block(command: string, c: HookClassification): HookAction;
  allow(c: HookClassification): HookAction;
  surface: SurfaceAdapter;
}): CtxRuntime {
  return {
    id: opts.id,
    label: opts.label,
    confidence: opts.confidence,
    groupShape: opts.groupShape,
    groupKey: opts.groupKey,
    ...(opts.groupContainer !== undefined ? { groupContainer: opts.groupContainer } : {}),
    ...(opts.surface.relativePath !== undefined ? { relativePath: opts.surface.relativePath } : {}),
    ...(opts.nativeSearchTools !== undefined ? { nativeSearchTools: opts.nativeSearchTools } : {}),
    parseCommand: opts.parseCommand,
    block: opts.block,
    allow: opts.allow,
    locate: (root) => opts.surface.settingsFile!(root),
    ...(opts.surface.merge !== undefined ? { merge: opts.surface.merge } : {}),
    ...(opts.surface.strip !== undefined ? { strip: opts.surface.strip } : {}),
    ...(opts.surface.validate !== undefined ? { validate: opts.surface.validate } : {}),
  };
}

export const CLAUDE_RUNTIME: CtxRuntime = asRuntime({
  id: "claude",
  label: ".claude/settings.json (PreToolUse)",
  confidence: "verified",
  groupShape: "nested",
  groupKey: "PreToolUse",
  nativeSearchTools: ["Grep"],
  parseCommand: parseToolInputCommand,
  block: exitCodeBlock,
  allow: exitCodeAllow,
  surface: CTX_GUARD_CLAUDE,
});

export const CODEX_RUNTIME: CtxRuntime = asRuntime({
  id: "codex",
  label: ".codex/hooks.json (PreToolUse)",
  confidence: "verified",
  groupShape: "nested",
  groupKey: "PreToolUse",
  parseCommand: parseToolInputCommand,
  block: exitCodeBlock,
  allow: exitCodeAllow,
  surface: CTX_GUARD_CODEX,
});

export const CURSOR_RUNTIME: CtxRuntime = asRuntime({
  id: "cursor",
  label: ".cursor/hooks.json (beforeShellExecution)",
  confidence: "verified",
  groupShape: "flat",
  groupKey: "beforeShellExecution",
  parseCommand: parseCursorCommand,
  block: cursorBlock,
  allow: cursorAllow,
  surface: CTX_GUARD_CURSOR,
});

export const WINDSURF_RUNTIME: CtxRuntime = asRuntime({
  id: "windsurf",
  label: ".windsurf/hooks.json (pre_run_command)",
  confidence: "verified",
  groupShape: "flat",
  groupKey: "pre_run_command",
  parseCommand: parseWindsurfCommand,
  block: exitCodeBlock,
  allow: exitCodeAllow,
  surface: CTX_GUARD_WINDSURF,
});

export const ANTIGRAVITY_RUNTIME: CtxRuntime = asRuntime({
  id: "antigravity",
  label: ".agents/hooks.json (PreToolUse/run_command)",
  confidence: "experimental",
  groupShape: "nested",
  groupKey: "PreToolUse",
  groupContainer: "keryx-ctx-guard",
  parseCommand: parseAntigravityCommand,
  block: antigravityBlock,
  allow: antigravityAllow,
  surface: CTX_GUARD_ANTIGRAVITY,
});

export const OPENCODE_RUNTIME: CtxRuntime = {
  id: "opencode",
  label: ".opencode/plugin/keryx-ctx-guard.js",
  confidence: "experimental",
  groupShape: "nested",
  groupKey: "PreToolUse",
  parseCommand: parseToolInputCommand,
  block: exitCodeBlock,
  allow: exitCodeAllow,
  locate: (root) => CTX_GUARD_OPENCODE.settingsFile!(root),
  customInstall: (root) => CTX_GUARD_OPENCODE.customInstall!(root),
  customUninstall: (root) => CTX_GUARD_OPENCODE.customUninstall!(root),
};

// Harnesses with NO scriptable pre-exec gate today. Registered only so the CLI
// can give a precise "unsupported" message instead of "unknown runtime".
export const UNSUPPORTED_RUNTIMES: Record<string, string> = UNSUPPORTED_CTX_GUARD;

export const CTX_RUNTIMES: CtxRuntime[] = [
  CLAUDE_RUNTIME,
  CODEX_RUNTIME,
  CURSOR_RUNTIME,
  WINDSURF_RUNTIME,
  ANTIGRAVITY_RUNTIME,
  OPENCODE_RUNTIME,
];

export function runtimeIds(): string[] {
  return CTX_RUNTIMES.map((r) => r.id);
}

export function getRuntime(id: string): CtxRuntime | undefined {
  return CTX_RUNTIMES.find((r) => r.id === id);
}

export function resolveRuntimes(ids: string[]): {
  runtimes: CtxRuntime[];
  unknown: string[];
  unsupported: string[];
} {
  const wanted = ids.includes("all") ? runtimeIds() : ids;
  const runtimes: CtxRuntime[] = [];
  const unknown: string[] = [];
  const unsupported: string[] = [];
  for (const id of wanted) {
    const runtime = getRuntime(id);
    if (runtime) runtimes.push(runtime);
    else if (UNSUPPORTED_RUNTIMES[id]) unsupported.push(id);
    else unknown.push(id);
  }
  return { runtimes, unknown, unsupported };
}

export { classifyCommand, buildBlockMessage, type HookClassification };
export type { HarnessAdapter };
