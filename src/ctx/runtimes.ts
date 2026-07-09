import path from "node:path";
import { buildBlockMessage, classifyCommand, type HookClassification } from "./hook-classify";

// Multi-harness registry for the gdctx routing guard. The command CLASSIFIER is
// harness-agnostic (hook-classify.ts). What differs per harness is only:
//   1. WHERE the pre-exec hook is configured (settings path + schema),
//   2. HOW the harness hands the command to the hook (payload format),
//   3. HOW the hook signals BLOCK vs ALLOW back to the harness,
//   4. WHAT install artifact is written (a JSON config group, or a plugin file).
//
// Each CtxRuntime encapsulates exactly those concerns, verified against that
// harness's documented hook contract. Contracts confirmed against first-party
// docs are `confidence: "verified"`; those from community docs are
// `confidence: "experimental"` and print a warning at install time. Harnesses
// with no scriptable pre-exec gate (e.g. Zed today) are NOT registered.
//
// Sentinel discipline: managed JSON groups carry `_keryxManaged:"ctx-agent-hooks"`
// so uninstall removes ONLY our entry and re-install is idempotent.

export const CTX_HOOK_SENTINEL = "ctx-agent-hooks";
export const MANAGED_KEY = "_keryxManaged";

export type Settings = Record<string, unknown>;

// What the hook process should do for one classified command. `exitCode` plus
// optional `stdout`/`stderr` covers every block style harnesses use: exit-code
// blocking (Claude/Codex/Windsurf: exit 2 + stderr) and stdout-JSON decisions
// (Cursor: `{permission:"deny"}`, Antigravity: `{allow_tool:false}`).
export interface HookAction {
  exitCode: number;
  stdout?: string;
  stderr?: string;
}

export type Confidence = "verified" | "experimental";

export interface CtxRuntime {
  readonly id: string;
  readonly label: string;
  readonly confidence: Confidence;
  // --- hook side (invoked by `keryx ctx hook <id>`) ---
  parseCommand(payload: string): string | null;
  block(command: string, classification: HookClassification): HookAction;
  allow(classification: HookClassification): HookAction;
  // --- install side ---
  // Path of the artifact this runtime installs (for reporting).
  locate(projectRoot: string): string;
  // For JSON-config runtimes: merge/strip a parsed settings object. Runtimes
  // that write a non-JSON artifact (e.g. OpenCode plugin) leave these undefined
  // and implement customInstall/customUninstall instead.
  merge?(settings: Settings): Settings;
  strip?(settings: Settings): Settings;
  validate?(settings: Settings): string[];
  // For non-JSON runtimes: fully own install/uninstall. Returns errors ([] = ok).
  customInstall?(projectRoot: string): Promise<string[]>;
  customUninstall?(projectRoot: string): Promise<boolean>;
}

function hookCommand(id: string): string {
  return `keryx ctx hook ${id}`;
}

// --- shared sentinel helpers (JSON-config runtimes) --------------------------

function isManagedGroup(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Record<string, unknown>)[MANAGED_KEY] === CTX_HOOK_SENTINEL
  );
}

function stripManaged(existing: unknown): unknown[] {
  return Array.isArray(existing) ? existing.filter((g) => !isManagedGroup(g)) : [];
}

function addSentinel(settings: Settings): void {
  const managed = Array.isArray(settings[MANAGED_KEY])
    ? (settings[MANAGED_KEY] as unknown[]).filter((v) => v !== CTX_HOOK_SENTINEL)
    : [];
  settings[MANAGED_KEY] = [...managed, CTX_HOOK_SENTINEL];
}

function removeSentinel(settings: Settings): void {
  if (!Array.isArray(settings[MANAGED_KEY])) return;
  const managed = (settings[MANAGED_KEY] as unknown[]).filter((v) => v !== CTX_HOOK_SENTINEL);
  if (managed.length > 0) settings[MANAGED_KEY] = managed;
  else delete settings[MANAGED_KEY];
}

function hooksObject(settings: Settings): Settings {
  return typeof settings.hooks === "object" &&
    settings.hooks !== null &&
    !Array.isArray(settings.hooks)
    ? { ...(settings.hooks as Settings) }
    : {};
}

// Merge/strip a managed group into a named array under `settings.hooks[key]`.
function mergeIntoHookArray(settings: Settings, key: string, group: Settings): Settings {
  const hooks = hooksObject(settings);
  hooks[key] = [...stripManaged(hooks[key]), group];
  settings.hooks = hooks;
  addSentinel(settings);
  return settings;
}

function stripFromHookArray(settings: Settings, key: string): Settings {
  if (typeof settings.hooks !== "object" || settings.hooks === null || Array.isArray(settings.hooks)) {
    removeSentinel(settings);
    return settings;
  }
  const hooks = { ...(settings.hooks as Settings) };
  if (Array.isArray(hooks[key])) {
    const remaining = stripManaged(hooks[key]);
    if (remaining.length > 0) hooks[key] = remaining;
    else delete hooks[key];
  }
  if (Object.keys(hooks).length > 0) settings.hooks = hooks;
  else delete settings.hooks;
  removeSentinel(settings);
  return settings;
}

function hasManagedInArray(settings: Settings, key: string, command: string): boolean {
  const hooks = settings.hooks as Settings | undefined;
  const groups = Array.isArray(hooks?.[key]) ? (hooks?.[key] as unknown[]) : [];
  return groups.some((g) => {
    if (!isManagedGroup(g)) return false;
    const inner = (g as { hooks?: unknown; command?: unknown });
    if (inner.command === command) return true; // flat entry (cursor/windsurf)
    return (
      Array.isArray(inner.hooks) &&
      (inner.hooks as Array<{ command?: unknown }>).some((h) => h?.command === command)
    );
  });
}

// --- payload parsers ---------------------------------------------------------

function parseJson(payload: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(payload) as unknown;
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

// Claude Code / Codex / OpenCode bridge: { tool_name:"Bash", tool_input.command }.
function parseToolInputCommand(payload: string): string | null {
  const record = parseJson(payload);
  if (!record || record.tool_name !== "Bash") return null;
  const input = record.tool_input;
  if (typeof input !== "object" || input === null) return null;
  const command = (input as Record<string, unknown>).command;
  return typeof command === "string" ? command : null;
}

// Cursor beforeShellExecution: top-level { command }.
function parseCursorCommand(payload: string): string | null {
  const record = parseJson(payload);
  const command = record?.command;
  return typeof command === "string" ? command : null;
}

// Windsurf pre_run_command: { tool_info: { command_line } }.
function parseWindsurfCommand(payload: string): string | null {
  const record = parseJson(payload);
  const info = record?.tool_info;
  if (typeof info !== "object" || info === null) return null;
  const command = (info as Record<string, unknown>).command_line;
  return typeof command === "string" ? command : null;
}

// Antigravity run_command: { toolCall: { args: { CommandLine } } }.
function parseAntigravityCommand(payload: string): string | null {
  const record = parseJson(payload);
  const call = record?.toolCall;
  const args = call && typeof call === "object" ? (call as Record<string, unknown>).args : undefined;
  const command = args && typeof args === "object" ? (args as Record<string, unknown>).CommandLine : undefined;
  return typeof command === "string" ? command : null;
}

// --- block/allow signalers ---------------------------------------------------

// Exit-2 + stderr (Claude, Codex, Windsurf, OpenCode bridge).
function exitCodeBlock(command: string, c: HookClassification): HookAction {
  return { exitCode: 2, stderr: `${buildBlockMessage(command, c)}\n` };
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
  return {
    exitCode: 0,
    stdout: `${JSON.stringify({ permission: "deny", agent_message: buildBlockMessage(command, c) })}\n`,
  };
}
function cursorAllow(_c: HookClassification): HookAction {
  return { exitCode: 0, stdout: `${JSON.stringify({ permission: "allow" })}\n` };
}

// Antigravity: stdout top-level { allow_tool, deny_reason }; always exit 0.
function antigravityBlock(command: string, c: HookClassification): HookAction {
  return {
    exitCode: 0,
    stdout: `${JSON.stringify({ allow_tool: false, deny_reason: buildBlockMessage(command, c) })}\n`,
  };
}
function antigravityAllow(_c: HookClassification): HookAction {
  return { exitCode: 0, stdout: `${JSON.stringify({ allow_tool: true })}\n` };
}

// --- JSON group builders (install artifacts) ---------------------------------

// Claude/Codex PreToolUse group: { matcher, hooks:[{type,command}], _keryxManaged }.
function preToolUseGroup(id: string): Settings {
  return {
    matcher: "Bash",
    hooks: [{ type: "command", command: hookCommand(id) }],
    [MANAGED_KEY]: CTX_HOOK_SENTINEL,
  };
}

// --- runtime definitions -----------------------------------------------------

export const CLAUDE_RUNTIME: CtxRuntime = {
  id: "claude",
  label: ".claude/settings.json (PreToolUse/Bash)",
  confidence: "verified",
  parseCommand: parseToolInputCommand,
  block: exitCodeBlock,
  allow: exitCodeAllow,
  locate: (root) => path.join(root, ".claude", "settings.json"),
  merge: (s) => mergeIntoHookArray(s, "PreToolUse", preToolUseGroup("claude")),
  strip: (s) => stripFromHookArray(s, "PreToolUse"),
  validate: (s) => (hasManagedInArray(s, "PreToolUse", hookCommand("claude")) ? [] : ["claude: missing PreToolUse(Bash) guard"]),
};

export const CODEX_RUNTIME: CtxRuntime = {
  id: "codex",
  label: ".codex/hooks.json (PreToolUse/Bash)",
  confidence: "verified",
  parseCommand: parseToolInputCommand,
  block: exitCodeBlock,
  allow: exitCodeAllow,
  locate: (root) => path.join(root, ".codex", "hooks.json"),
  merge: (s) => mergeIntoHookArray(s, "PreToolUse", preToolUseGroup("codex")),
  strip: (s) => stripFromHookArray(s, "PreToolUse"),
  validate: (s) => (hasManagedInArray(s, "PreToolUse", hookCommand("codex")) ? [] : ["codex: missing PreToolUse(Bash) guard"]),
};

export const CURSOR_RUNTIME: CtxRuntime = {
  id: "cursor",
  label: ".cursor/hooks.json (beforeShellExecution)",
  confidence: "verified",
  parseCommand: parseCursorCommand,
  block: cursorBlock,
  allow: cursorAllow,
  locate: (root) => path.join(root, ".cursor", "hooks.json"),
  merge: (s) => {
    s.version = typeof s.version === "number" ? s.version : 1;
    return mergeIntoHookArray(s, "beforeShellExecution", {
      command: hookCommand("cursor"),
      [MANAGED_KEY]: CTX_HOOK_SENTINEL,
    });
  },
  strip: (s) => stripFromHookArray(s, "beforeShellExecution"),
  validate: (s) => (hasManagedInArray(s, "beforeShellExecution", hookCommand("cursor")) ? [] : ["cursor: missing beforeShellExecution guard"]),
};

export const WINDSURF_RUNTIME: CtxRuntime = {
  id: "windsurf",
  label: ".windsurf/hooks.json (pre_run_command)",
  confidence: "verified",
  parseCommand: parseWindsurfCommand,
  block: exitCodeBlock,
  allow: exitCodeAllow,
  locate: (root) => path.join(root, ".windsurf", "hooks.json"),
  merge: (s) =>
    mergeIntoHookArray(s, "pre_run_command", {
      command: hookCommand("windsurf"),
      show_output: true,
      [MANAGED_KEY]: CTX_HOOK_SENTINEL,
    }),
  strip: (s) => stripFromHookArray(s, "pre_run_command"),
  validate: (s) => (hasManagedInArray(s, "pre_run_command", hookCommand("windsurf")) ? [] : ["windsurf: missing pre_run_command guard"]),
};

export const ANTIGRAVITY_RUNTIME: CtxRuntime = {
  id: "antigravity",
  label: ".agents/hooks.json (PreToolUse/run_command)",
  confidence: "experimental",
  parseCommand: parseAntigravityCommand,
  block: antigravityBlock,
  allow: antigravityAllow,
  locate: (root) => path.join(root, ".agents", "hooks.json"),
  merge: (s) => {
    // Antigravity groups PreToolUse under a named top-level key.
    const key = "keryx-ctx-guard";
    const existing = typeof s[key] === "object" && s[key] !== null ? (s[key] as Settings) : {};
    existing.PreToolUse = [
      ...stripManaged((existing as Settings).PreToolUse),
      {
        matcher: "run_command",
        hooks: [{ type: "command", command: hookCommand("antigravity") }],
        [MANAGED_KEY]: CTX_HOOK_SENTINEL,
      },
    ];
    s[key] = existing;
    addSentinel(s);
    return s;
  },
  strip: (s) => {
    const key = "keryx-ctx-guard";
    if (typeof s[key] === "object" && s[key] !== null) {
      const group = s[key] as Settings;
      const remaining = stripManaged(group.PreToolUse);
      if (remaining.length > 0) group.PreToolUse = remaining;
      else delete s[key];
    }
    removeSentinel(s);
    return s;
  },
  validate: (s) => {
    const group = s["keryx-ctx-guard"] as Settings | undefined;
    const list = Array.isArray(group?.PreToolUse) ? (group?.PreToolUse as unknown[]) : [];
    const ok = list.some(
      (g) => isManagedGroup(g) &&
        Array.isArray((g as { hooks?: unknown[] }).hooks) &&
        ((g as { hooks: Array<{ command?: unknown }> }).hooks.some((h) => h?.command === hookCommand("antigravity"))),
    );
    return ok ? [] : ["antigravity: missing run_command guard"];
  },
};

// OpenCode has no JSON hook config — it loads JS/TS plugins. We ship a small
// bridge plugin that shells out to `keryx ctx hook opencode` and throws to
// block. Its hook-side contract is the Claude-shaped payload WE author in the
// plugin, so it reuses parseToolInputCommand + exit-2 blocking.
const OPENCODE_PLUGIN = `// keryx gdctx routing guard — generated by \`keryx ctx install-hook --runtime opencode\`.
// Bridges OpenCode's tool.execute.before to \`keryx ctx hook opencode\`.
import { spawnSync } from "node:child_process";

export const KeryxCtxGuard = async () => ({
  "tool.execute.before": async (input, output) => {
    if (input?.tool !== "bash") return;
    const command = output?.args?.command;
    if (typeof command !== "string") return;
    const payload = JSON.stringify({ tool_name: "Bash", tool_input: { command } });
    const res = spawnSync("keryx", ["ctx", "hook", "opencode"], { input: payload, encoding: "utf8" });
    if (res.status === 2) {
      throw new Error(res.stderr?.trim() || "[keryx ctx] blocked: route this through keryx ctx …");
    }
  },
});
`;

export const OPENCODE_RUNTIME: CtxRuntime = {
  id: "opencode",
  label: ".opencode/plugin/keryx-ctx-guard.js",
  confidence: "experimental",
  parseCommand: parseToolInputCommand,
  block: exitCodeBlock,
  allow: exitCodeAllow,
  locate: (root) => path.join(root, ".opencode", "plugin", "keryx-ctx-guard.js"),
  customInstall: async (root) => {
    const { mkdir, writeFile } = await import("node:fs/promises");
    const file = OPENCODE_RUNTIME.locate(root);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, OPENCODE_PLUGIN, "utf8");
    return [];
  },
  customUninstall: async (root) => {
    const { rm } = await import("node:fs/promises");
    const { pathExists } = await import("../lib/fs");
    const file = OPENCODE_RUNTIME.locate(root);
    if (!(await pathExists(file))) return false;
    await rm(file, { force: true });
    return true;
  },
};

// Harnesses with NO scriptable pre-exec gate today. Registered only so the CLI
// can give a precise "unsupported" message instead of "unknown runtime".
export const UNSUPPORTED_RUNTIMES: Record<string, string> = {
  zed: "Zed has no scriptable pre-exec hook yet (tracking: zed-industries/zed#57943). Use its static agent tool_permissions (always_allow/always_deny) instead.",
};

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
