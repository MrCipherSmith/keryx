import path from "node:path";

// Multi-harness registry for the graph+wiki ORIENTATION injector — the A+B
// enforcement layer (availability + freshness), distinct from the ctx guard.
// Where the guard intercepts a command (PreToolUse) and blocks, the injector
// runs at session/prompt start and ADDS a compact graph map + wiki index to the
// model's context. Only harnesses whose hooks can inject context are registered;
// harnesses with block-only hooks (e.g. Windsurf) are listed as unsupported.
//
// Verified against current official docs:
//   claude — UserPromptSubmit, stdout added as context (.claude/settings.json)
//   codex  — UserPromptSubmit, stdout added as context (.codex/hooks.json)
//   cursor — sessionStart, stdout JSON { additional_context } (.cursor/hooks.json)

export const ORIENT_SENTINEL = "ctx-orient-hooks";
const MANAGED_KEY = "_keryxManaged";

export type Settings = Record<string, unknown>;
export type Confidence = "verified" | "experimental";

export interface OrientRuntime {
  readonly id: string;
  readonly label: string;
  readonly confidence: Confidence;
  // Format the orientation Markdown for this harness's injection mechanism.
  format(orientation: string): string;
  locate(projectRoot: string): string;
  merge(settings: Settings): Settings;
  strip(settings: Settings): Settings;
  validate(settings: Settings): string[];
}

function hookCommand(id: string): string {
  return `keryx orient ${id}`;
}

// --- shared sentinel + array helpers -----------------------------------------

function isManaged(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Record<string, unknown>)[MANAGED_KEY] === ORIENT_SENTINEL
  );
}
function stripManaged(existing: unknown): unknown[] {
  return Array.isArray(existing) ? existing.filter((g) => !isManaged(g)) : [];
}
function addSentinel(s: Settings): void {
  const m = Array.isArray(s[MANAGED_KEY]) ? (s[MANAGED_KEY] as unknown[]).filter((v) => v !== ORIENT_SENTINEL) : [];
  s[MANAGED_KEY] = [...m, ORIENT_SENTINEL];
}
function removeSentinel(s: Settings): void {
  if (!Array.isArray(s[MANAGED_KEY])) return;
  const m = (s[MANAGED_KEY] as unknown[]).filter((v) => v !== ORIENT_SENTINEL);
  if (m.length > 0) s[MANAGED_KEY] = m;
  else delete s[MANAGED_KEY];
}
function hooksObject(s: Settings): Settings {
  return typeof s.hooks === "object" && s.hooks !== null && !Array.isArray(s.hooks)
    ? { ...(s.hooks as Settings) }
    : {};
}
function mergeInto(s: Settings, key: string, group: Settings): Settings {
  const hooks = hooksObject(s);
  hooks[key] = [...stripManaged(hooks[key]), group];
  s.hooks = hooks;
  addSentinel(s);
  return s;
}
function stripFrom(s: Settings, key: string): Settings {
  if (typeof s.hooks !== "object" || s.hooks === null || Array.isArray(s.hooks)) {
    removeSentinel(s);
    return s;
  }
  const hooks = { ...(s.hooks as Settings) };
  if (Array.isArray(hooks[key])) {
    const remaining = stripManaged(hooks[key]);
    if (remaining.length > 0) hooks[key] = remaining;
    else delete hooks[key];
  }
  if (Object.keys(hooks).length > 0) s.hooks = hooks;
  else delete s.hooks;
  removeSentinel(s);
  return s;
}
function hasManaged(s: Settings, key: string, command: string): boolean {
  const hooks = s.hooks as Settings | undefined;
  const groups = Array.isArray(hooks?.[key]) ? (hooks?.[key] as unknown[]) : [];
  return groups.some((g) => {
    if (!isManaged(g)) return false;
    const inner = g as { hooks?: unknown; command?: unknown };
    if (inner.command === command) return true;
    return (
      Array.isArray(inner.hooks) &&
      (inner.hooks as Array<{ command?: unknown }>).some((h) => h?.command === command)
    );
  });
}

// --- formatting mechanisms ---------------------------------------------------

// Claude / Codex: plain stdout from the hook is added to context verbatim.
function plainStdout(orientation: string): string {
  return orientation;
}
// Cursor sessionStart: stdout JSON with the documented `additional_context` field.
function cursorAdditionalContext(orientation: string): string {
  return JSON.stringify({ additional_context: orientation });
}

// --- runtime definitions -----------------------------------------------------

export const CLAUDE_ORIENT: OrientRuntime = {
  id: "claude",
  label: ".claude/settings.json (UserPromptSubmit)",
  confidence: "verified",
  format: plainStdout,
  locate: (root) => path.join(root, ".claude", "settings.json"),
  merge: (s) =>
    mergeInto(s, "UserPromptSubmit", {
      hooks: [{ type: "command", command: hookCommand("claude") }],
      [MANAGED_KEY]: ORIENT_SENTINEL,
    }),
  strip: (s) => stripFrom(s, "UserPromptSubmit"),
  validate: (s) => (hasManaged(s, "UserPromptSubmit", hookCommand("claude")) ? [] : ["claude: missing UserPromptSubmit orientation hook"]),
};

export const CODEX_ORIENT: OrientRuntime = {
  id: "codex",
  label: ".codex/hooks.json (UserPromptSubmit)",
  confidence: "verified",
  format: plainStdout,
  locate: (root) => path.join(root, ".codex", "hooks.json"),
  merge: (s) =>
    mergeInto(s, "UserPromptSubmit", {
      hooks: [{ type: "command", command: hookCommand("codex") }],
      [MANAGED_KEY]: ORIENT_SENTINEL,
    }),
  strip: (s) => stripFrom(s, "UserPromptSubmit"),
  validate: (s) => (hasManaged(s, "UserPromptSubmit", hookCommand("codex")) ? [] : ["codex: missing UserPromptSubmit orientation hook"]),
};

export const CURSOR_ORIENT: OrientRuntime = {
  id: "cursor",
  label: ".cursor/hooks.json (sessionStart)",
  confidence: "verified",
  format: cursorAdditionalContext,
  locate: (root) => path.join(root, ".cursor", "hooks.json"),
  merge: (s) => {
    s.version = typeof s.version === "number" ? s.version : 1;
    return mergeInto(s, "sessionStart", {
      command: hookCommand("cursor"),
      [MANAGED_KEY]: ORIENT_SENTINEL,
    });
  },
  strip: (s) => stripFrom(s, "sessionStart"),
  validate: (s) => (hasManaged(s, "sessionStart", hookCommand("cursor")) ? [] : ["cursor: missing sessionStart orientation hook"]),
};

// Harnesses whose hooks CANNOT inject context (block-only / exit-code only), so
// the availability-injection approach does not apply.
export const UNSUPPORTED_ORIENT: Record<string, string> = {
  windsurf: "Windsurf hooks are exit-code only (block/allow); no documented field injects context. Use its rules/memories for standing context.",
  zed: "Zed has no scriptable session/prompt hook. Use static agent settings.",
  opencode: "OpenCode's chat.message / experimental.chat.system.transform can inject context in theory, but propagation is undocumented and known-buggy (sst/opencode#17100, oh-my-openagent#885). Left out until stable — use AGENTS.md for standing context.",
  antigravity: "Antigravity's context-injection hook is unverified (no first-party docs). Its pre-exec block hook IS supported — see `keryx ctx install-hook --runtime antigravity`.",
};

export const ORIENT_RUNTIMES: OrientRuntime[] = [CLAUDE_ORIENT, CODEX_ORIENT, CURSOR_ORIENT];

export function orientRuntimeIds(): string[] {
  return ORIENT_RUNTIMES.map((r) => r.id);
}
export function getOrientRuntime(id: string): OrientRuntime | undefined {
  return ORIENT_RUNTIMES.find((r) => r.id === id);
}
export function resolveOrientRuntimes(ids: string[]): {
  runtimes: OrientRuntime[];
  unknown: string[];
  unsupported: string[];
} {
  const wanted = ids.includes("all") ? orientRuntimeIds() : ids;
  const runtimes: OrientRuntime[] = [];
  const unknown: string[] = [];
  const unsupported: string[] = [];
  for (const id of wanted) {
    const r = getOrientRuntime(id);
    if (r) runtimes.push(r);
    else if (UNSUPPORTED_ORIENT[id]) unsupported.push(id);
    else unknown.push(id);
  }
  return { runtimes, unknown, unsupported };
}
