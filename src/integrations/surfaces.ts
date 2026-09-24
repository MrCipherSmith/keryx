// Flow 305 (W5-a): surface definitions per subsystem (ctx-guard, orient,
// security). Each `SurfaceAdapter.merge`/`strip`/`validate` is built from the
// shared walkers in `settings-json.ts`, so every JSON surface in the registry
// goes through the SAME sentinel/array logic rather than a per-subsystem copy.
//
// Confidence: contracts confirmed against first-party docs are `"verified"`;
// those from community docs or keryx's own invented shape are `"experimental"`
// and carry a risk note. Security on cursor/windsurf/generic-mcp is
// experimental because `securityHooks` matches no documented contract for
// those harnesses — tracked as OQ-3 (see `src/security/agent-hooks/runtimes.ts`
// history) and left for the matrix work this risk note cites.

import path from "node:path";
import {
  MANAGED_KEY,
  addSentinelTo,
  isManagedBy,
  managedGroups,
  mergeIntoHookArray,
  removeSentinelFrom,
  stripFromHookArray,
  stripManagedBy,
} from "./settings-json";
import {
  parseAntigravityCommand,
  parseCursorCommand,
  parseToolInputCommand,
  parseWindsurfCommand,
} from "./codecs";
import type { Settings, SurfaceAdapter } from "./types";

// ---------------------------------------------------------------------------
// ctx guard (subsystem "ctx-guard", flag "block", sentinel "ctx-agent-hooks")
// ---------------------------------------------------------------------------

export const CTX_HOOK_SENTINEL = "ctx-agent-hooks";

export function ctxHookCommand(id: string): string {
  return `keryx ctx hook ${id}`;
}

/** The matcher a runtime installs: the shell, plus its own native search tools. */
export function preToolUseMatcher(nativeSearchTools: readonly string[] | undefined): string {
  return ["Bash", ...(nativeSearchTools ?? [])].join("|");
}

function nestedPreToolUseGroup(id: string, matcher: string): Settings {
  return {
    matcher,
    hooks: [{ type: "command", command: ctxHookCommand(id) }],
    [MANAGED_KEY]: CTX_HOOK_SENTINEL,
  };
}

function nestedCtxValidate(id: string, matcher: string, container: string | undefined, key: string) {
  return (settings: Settings): string[] => {
    const present = managedGroups(settings, {
      sentinel: CTX_HOOK_SENTINEL,
      container: container ?? "hooks",
      key,
      shape: "nested",
      commandMatches: (c) => c === ctxHookCommand(id),
    });
    if (present.length === 0) return [`${id}: missing PreToolUse(${matcher}) guard`];
    const stale = present.some((g) => typeof g.matcher !== "string" || g.matcher !== matcher);
    if (stale) {
      return [
        `${id}: PreToolUse guard does not match ${matcher}; a tool it should cover bypasses it. ` +
          `Re-run \`keryx ctx install-hook --runtime ${id}\`.`,
      ];
    }
    return [];
  };
}

function nestedCtxSurface(opts: {
  id: string;
  relativePath: string;
  confidence: "verified" | "experimental";
  nativeSearchTools?: readonly string[];
  container?: string;
  key: string;
  sourceDocs: readonly string[];
}): SurfaceAdapter {
  const { id, relativePath, confidence, nativeSearchTools, container, key, sourceDocs } = opts;
  const matcher = preToolUseMatcher(nativeSearchTools);
  return {
    id: "ctx-guard",
    flag: "block",
    subsystem: "ctx-guard",
    sentinel: CTX_HOOK_SENTINEL,
    confidence,
    sourceDocs,
    settingsFile: (root) => path.join(root, ...relativePath.split("/")),
    relativePath,
    // `mergeIntoHookArray` also writes `_keryxManaged` and, when migrating a
    // pre-existing legacy `hooks` array, `unmigratedHooks` — both must be
    // declared or the coherence check (F3/OQ-3) cannot see collisions there.
    slots: [
      { key: container ?? "hooks", type: "object", access: "owns" },
      { key: "_keryxManaged", type: "array", access: "owns" },
      { key: "unmigratedHooks", type: "array", access: "owns" },
    ],
    merge: (s) => mergeIntoHookArray(s, key, nestedPreToolUseGroup(id, matcher), CTX_HOOK_SENTINEL),
    strip: (s) => stripFromHookArray(s, key, CTX_HOOK_SENTINEL),
    validate: nestedCtxValidate(id, matcher, container, key),
    // Per-runtime ctx-guard facts, carried here (F4) rather than duplicated
    // in `src/ctx/runtimes.ts`'s own per-runtime literal.
    label: `${relativePath} (${key})`,
    groupShape: "nested",
    groupKey: key,
    ...(container !== undefined ? { groupContainer: container } : {}),
    ...(nativeSearchTools !== undefined ? { nativeSearchTools } : {}),
    payloadCodec: parseToolInputCommand,
  };
}

function flatCtxValidate(id: string, key: string, missingMessage: string) {
  return (settings: Settings): string[] =>
    managedGroups(settings, {
      sentinel: CTX_HOOK_SENTINEL,
      container: "hooks",
      key,
      shape: "flat",
      commandMatches: (c) => c === ctxHookCommand(id),
    }).length === 0
      ? [missingMessage]
      : [];
}

export const CTX_GUARD_CLAUDE: SurfaceAdapter = nestedCtxSurface({
  id: "claude",
  relativePath: ".claude/settings.json",
  confidence: "verified",
  nativeSearchTools: ["Grep"],
  key: "PreToolUse",
  sourceDocs: ["src/ctx/runtimes.ts"],
});

export const CTX_GUARD_CODEX: SurfaceAdapter = nestedCtxSurface({
  id: "codex",
  relativePath: ".codex/hooks.json",
  confidence: "verified",
  key: "PreToolUse",
  sourceDocs: ["src/ctx/runtimes.ts", "docs/docs/harness.md"],
});

export const CTX_GUARD_CURSOR: SurfaceAdapter = {
  id: "ctx-guard",
  flag: "block",
  subsystem: "ctx-guard",
  sentinel: CTX_HOOK_SENTINEL,
  confidence: "verified",
  sourceDocs: ["src/ctx/runtimes.ts"],
  settingsFile: (root) => path.join(root, ".cursor", "hooks.json"),
  relativePath: ".cursor/hooks.json",
  slots: [
    { key: "hooks", type: "object", access: "owns" },
    { key: "version", type: "number", access: "owns" },
    { key: "_keryxManaged", type: "array", access: "owns" },
    { key: "unmigratedHooks", type: "array", access: "owns" },
  ],
  merge: (s) => {
    s.version = typeof s.version === "number" ? s.version : 1;
    return mergeIntoHookArray(
      s,
      "beforeShellExecution",
      { command: ctxHookCommand("cursor"), [MANAGED_KEY]: CTX_HOOK_SENTINEL },
      CTX_HOOK_SENTINEL,
    );
  },
  strip: (s) => stripFromHookArray(s, "beforeShellExecution", CTX_HOOK_SENTINEL),
  validate: flatCtxValidate("cursor", "beforeShellExecution", "cursor: missing beforeShellExecution guard"),
  label: ".cursor/hooks.json (beforeShellExecution)",
  groupShape: "flat",
  groupKey: "beforeShellExecution",
  payloadCodec: parseCursorCommand,
};

export const CTX_GUARD_WINDSURF: SurfaceAdapter = {
  id: "ctx-guard",
  flag: "block",
  subsystem: "ctx-guard",
  sentinel: CTX_HOOK_SENTINEL,
  confidence: "verified",
  sourceDocs: ["src/ctx/runtimes.ts"],
  settingsFile: (root) => path.join(root, ".windsurf", "hooks.json"),
  relativePath: ".windsurf/hooks.json",
  slots: [
    { key: "hooks", type: "object", access: "owns" },
    { key: "_keryxManaged", type: "array", access: "owns" },
    { key: "unmigratedHooks", type: "array", access: "owns" },
  ],
  merge: (s) =>
    mergeIntoHookArray(
      s,
      "pre_run_command",
      { command: ctxHookCommand("windsurf"), show_output: true, [MANAGED_KEY]: CTX_HOOK_SENTINEL },
      CTX_HOOK_SENTINEL,
    ),
  strip: (s) => stripFromHookArray(s, "pre_run_command", CTX_HOOK_SENTINEL),
  validate: flatCtxValidate("windsurf", "pre_run_command", "windsurf: missing pre_run_command guard"),
  label: ".windsurf/hooks.json (pre_run_command)",
  groupShape: "flat",
  groupKey: "pre_run_command",
  payloadCodec: parseWindsurfCommand,
};

const ANTIGRAVITY_CONTAINER = "keryx-ctx-guard";

export const CTX_GUARD_ANTIGRAVITY: SurfaceAdapter = {
  id: "ctx-guard",
  flag: "block",
  subsystem: "ctx-guard",
  sentinel: CTX_HOOK_SENTINEL,
  confidence: "experimental",
  riskNotes: ["No first-party docs confirm this hook contract; verify on a live install."],
  sourceDocs: ["src/ctx/runtimes.ts"],
  settingsFile: (root) => path.join(root, ".agents", "hooks.json"),
  relativePath: ".agents/hooks.json",
  slots: [
    { key: ANTIGRAVITY_CONTAINER, type: "object", access: "owns" },
    { key: "_keryxManaged", type: "array", access: "owns" },
  ],
  merge: (s) => {
    const existing = typeof s[ANTIGRAVITY_CONTAINER] === "object" && s[ANTIGRAVITY_CONTAINER] !== null
      ? (s[ANTIGRAVITY_CONTAINER] as Settings)
      : {};
    existing.PreToolUse = [
      ...stripManagedBy(CTX_HOOK_SENTINEL)((existing as Settings).PreToolUse),
      {
        matcher: "run_command",
        hooks: [{ type: "command", command: ctxHookCommand("antigravity") }],
        [MANAGED_KEY]: CTX_HOOK_SENTINEL,
      },
    ];
    s[ANTIGRAVITY_CONTAINER] = existing;
    addSentinelTo(s, CTX_HOOK_SENTINEL);
    return s;
  },
  strip: (s) => {
    if (typeof s[ANTIGRAVITY_CONTAINER] === "object" && s[ANTIGRAVITY_CONTAINER] !== null) {
      const group = s[ANTIGRAVITY_CONTAINER] as Settings;
      const remaining = stripManagedBy(CTX_HOOK_SENTINEL)(group.PreToolUse);
      if (remaining.length > 0) group.PreToolUse = remaining;
      else delete s[ANTIGRAVITY_CONTAINER];
    }
    removeSentinelFrom(s, CTX_HOOK_SENTINEL);
    return s;
  },
  // Was a second hand-rolled walker matching on `command` alone, so an inert
  // `type: "prompt"` entry validated clean. Routed through the shared nested
  // walker, rooted at antigravity's own named container. Unlike
  // claude/codex, this is presence-only — no matcher-staleness message —
  // matching the original hand-rolled validator exactly.
  validate: (s) =>
    managedGroups(s, {
      sentinel: CTX_HOOK_SENTINEL,
      container: ANTIGRAVITY_CONTAINER,
      key: "PreToolUse",
      shape: "nested",
      commandMatches: (c) => c === ctxHookCommand("antigravity"),
    }).length === 0
      ? ["antigravity: missing run_command guard"]
      : [],
  label: ".agents/hooks.json (PreToolUse/run_command)",
  groupShape: "nested",
  groupKey: "PreToolUse",
  groupContainer: ANTIGRAVITY_CONTAINER,
  payloadCodec: parseAntigravityCommand,
};

// OpenCode has no JSON hook config — it loads JS/TS plugins. The bridge plugin
// shells out to `keryx ctx hook opencode` and throws to block; its hook-side
// contract is the Claude-shaped payload the plugin itself authors.
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

export const CTX_GUARD_OPENCODE: SurfaceAdapter = {
  // "ctx-guard", like every other ctx-guard surface (F10) — opencode used to
  // be the only one keying its surface id to the harness id instead of its
  // subsystem; nothing depended on that (opencode owns its file outright, so
  // there is no owner-map collision), and the CtxRuntime built from this
  // surface still gets its `id` from the harness adapter, not the surface.
  id: "ctx-guard",
  flag: "block",
  subsystem: "ctx-guard",
  sentinel: CTX_HOOK_SENTINEL,
  confidence: "experimental",
  riskNotes: ["Bridged via a generated plugin file rather than a documented hook config."],
  sourceDocs: ["src/ctx/runtimes.ts"],
  settingsFile: (root) => path.join(root, ".opencode", "plugin", "keryx-ctx-guard.js"),
  relativePath: ".opencode/plugin/keryx-ctx-guard.js",
  slots: [],
  label: ".opencode/plugin/keryx-ctx-guard.js",
  payloadCodec: parseToolInputCommand,
  customInstall: async (root) => {
    const { mkdir, writeFile } = await import("node:fs/promises");
    const file = CTX_GUARD_OPENCODE.settingsFile!(root);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, OPENCODE_PLUGIN, "utf8");
    return [];
  },
  customUninstall: async (root) => {
    const { rm } = await import("node:fs/promises");
    const { pathExists } = await import("../lib/fs");
    const file = CTX_GUARD_OPENCODE.settingsFile!(root);
    if (!(await pathExists(file))) return false;
    await rm(file, { force: true });
    return true;
  },
};

// Harnesses with NO scriptable pre-exec gate today.
export const UNSUPPORTED_CTX_GUARD: Record<string, string> = {
  zed: "Zed has no scriptable pre-exec hook yet (tracking: zed-industries/zed#57943). Use its static agent tool_permissions (always_allow/always_deny) instead.",
};

// ---------------------------------------------------------------------------
// orient injector (subsystem "orient", flag "inject-context", sentinel
// "ctx-orient-hooks")
// ---------------------------------------------------------------------------

export const ORIENT_SENTINEL = "ctx-orient-hooks";

export function orientHookCommand(id: string): string {
  return `keryx orient ${id}`;
}

function orientValidate(id: string, key: string, missingMessage: string) {
  return (settings: Settings): string[] =>
    managedGroups(settings, {
      sentinel: ORIENT_SENTINEL,
      container: "hooks",
      key,
      // Lenient by design: cursor's group carries `command` directly while
      // claude/codex nest it under `hooks[]`. Either shape counts here so a
      // build that tightens the ctx-guard walker (which DOES require
      // `type:"command"`) does not also tighten this one — see flow 305 plan
      // risk note on orient validation.
      shape: "lenient",
      commandMatches: (c) => c === orientHookCommand(id),
    }).length === 0
      ? [missingMessage]
      : [];
}

export const ORIENT_CLAUDE: SurfaceAdapter = {
  id: "orient",
  flag: "inject-context",
  subsystem: "orient",
  sentinel: ORIENT_SENTINEL,
  confidence: "verified",
  sourceDocs: ["src/ctx/orient-runtimes.ts"],
  settingsFile: (root) => path.join(root, ".claude", "settings.json"),
  relativePath: ".claude/settings.json",
  slots: [
    { key: "hooks", type: "object", access: "owns" },
    { key: "_keryxManaged", type: "array", access: "owns" },
    { key: "unmigratedHooks", type: "array", access: "owns" },
  ],
  merge: (s) =>
    mergeIntoHookArray(
      s,
      "UserPromptSubmit",
      { hooks: [{ type: "command", command: orientHookCommand("claude") }], [MANAGED_KEY]: ORIENT_SENTINEL },
      ORIENT_SENTINEL,
    ),
  strip: (s) => stripFromHookArray(s, "UserPromptSubmit", ORIENT_SENTINEL),
  validate: orientValidate("claude", "UserPromptSubmit", "claude: missing UserPromptSubmit orientation hook"),
  label: ".claude/settings.json (UserPromptSubmit)",
};

export const ORIENT_CODEX: SurfaceAdapter = {
  id: "orient",
  flag: "inject-context",
  subsystem: "orient",
  sentinel: ORIENT_SENTINEL,
  confidence: "verified",
  sourceDocs: ["src/ctx/orient-runtimes.ts"],
  settingsFile: (root) => path.join(root, ".codex", "hooks.json"),
  relativePath: ".codex/hooks.json",
  slots: [
    { key: "hooks", type: "object", access: "owns" },
    { key: "_keryxManaged", type: "array", access: "owns" },
    { key: "unmigratedHooks", type: "array", access: "owns" },
  ],
  merge: (s) =>
    mergeIntoHookArray(
      s,
      "UserPromptSubmit",
      { hooks: [{ type: "command", command: orientHookCommand("codex") }], [MANAGED_KEY]: ORIENT_SENTINEL },
      ORIENT_SENTINEL,
    ),
  strip: (s) => stripFromHookArray(s, "UserPromptSubmit", ORIENT_SENTINEL),
  validate: orientValidate("codex", "UserPromptSubmit", "codex: missing UserPromptSubmit orientation hook"),
  label: ".codex/hooks.json (UserPromptSubmit)",
};

export const ORIENT_CURSOR: SurfaceAdapter = {
  id: "orient",
  flag: "inject-context",
  subsystem: "orient",
  sentinel: ORIENT_SENTINEL,
  confidence: "verified",
  sourceDocs: ["src/ctx/orient-runtimes.ts"],
  settingsFile: (root) => path.join(root, ".cursor", "hooks.json"),
  relativePath: ".cursor/hooks.json",
  slots: [
    { key: "hooks", type: "object", access: "owns" },
    { key: "version", type: "number", access: "owns" },
    { key: "_keryxManaged", type: "array", access: "owns" },
    { key: "unmigratedHooks", type: "array", access: "owns" },
  ],
  merge: (s) => {
    s.version = typeof s.version === "number" ? s.version : 1;
    return mergeIntoHookArray(
      s,
      "sessionStart",
      { command: orientHookCommand("cursor"), [MANAGED_KEY]: ORIENT_SENTINEL },
      ORIENT_SENTINEL,
    );
  },
  strip: (s) => stripFromHookArray(s, "sessionStart", ORIENT_SENTINEL),
  validate: orientValidate("cursor", "sessionStart", "cursor: missing sessionStart orientation hook"),
  label: ".cursor/hooks.json (sessionStart)",
};

// Harnesses whose hooks CANNOT inject context (block-only / undocumented).
export const UNSUPPORTED_ORIENT: Record<string, string> = {
  windsurf: "Windsurf hooks are exit-code only (block/allow); no documented field injects context. Use its rules/memories for standing context.",
  zed: "Zed has no scriptable session/prompt hook. Use static agent settings.",
  opencode: "OpenCode's chat.message / experimental.chat.system.transform can inject context in theory, but propagation is undocumented and known-buggy (sst/opencode#17100, oh-my-openagent#885). Left out until stable — use AGENTS.md for standing context.",
  antigravity: "Antigravity's context-injection hook is unverified (no first-party docs). Its pre-exec block hook IS supported — see `keryx ctx install-hook --runtime antigravity`.",
};

// ---------------------------------------------------------------------------
// security (subsystem "security", sentinel "security-agent-hooks"); split
// into two surfaces per harness — check-input (flag "prompt-gate") and
// check-output (flag "block") — because the flags they occupy differ, and
// because a coexistence test needs to install/uninstall either independently
// (AC5). They therefore never call `removeSentinelFrom` unconditionally: each
// strip checks whether its SIBLING surface still has managed content in the
// same file before clearing the shared sentinel, so uninstalling one never
// makes the audit lie about the other (flow 305 plan, interface decision 5).
// ---------------------------------------------------------------------------

export const AGENT_HOOKS_SENTINEL = "security-agent-hooks";
export const AGENT_CHECK_INPUT_COMMAND = "keryx security check-input --source untrusted-external";
export const AGENT_CHECK_OUTPUT_COMMAND = "keryx security check-output";

export function checkInputCommand(runtimeId: string): string {
  return `${AGENT_CHECK_INPUT_COMMAND} --runtime ${runtimeId}`;
}
export function checkOutputCommand(runtimeId: string): string {
  return `${AGENT_CHECK_OUTPUT_COMMAND} --runtime ${runtimeId}`;
}

const CLAUDE_PRE_TOOL_MATCHER = "Write|Edit";

export const SECURITY_CHECK_INPUT_CLAUDE: SurfaceAdapter = {
  id: "security-check-input",
  flag: "prompt-gate",
  subsystem: "security",
  sentinel: AGENT_HOOKS_SENTINEL,
  confidence: "verified",
  sourceDocs: ["src/security/agent-hooks/runtimes.ts"],
  settingsFile: (root) => path.join(root, ".claude", "settings.json"),
  relativePath: ".claude/settings.json",
  slots: [
    { key: "hooks", type: "object", access: "owns" },
    { key: "_keryxManaged", type: "array", access: "owns" },
    { key: "unmigratedHooks", type: "array", access: "owns" },
  ],
  merge: (s) =>
    mergeIntoHookArray(
      s,
      "UserPromptSubmit",
      { hooks: [{ type: "command", command: checkInputCommand("claude") }], [MANAGED_KEY]: AGENT_HOOKS_SENTINEL },
      AGENT_HOOKS_SENTINEL,
    ),
  strip: (s) => stripHookSurfaceKeepingSentinelIfSiblingPresent(s, "UserPromptSubmit", "PreToolUse", (c) => c.startsWith(AGENT_CHECK_OUTPUT_COMMAND)),
  validate: (s) =>
    hasStartsWithCommand(s, "hooks", "UserPromptSubmit", AGENT_CHECK_INPUT_COMMAND)
      ? []
      : ["claude: missing UserPromptSubmit check-input hook"],
};

export const SECURITY_CHECK_OUTPUT_CLAUDE: SurfaceAdapter = {
  id: "security-check-output",
  flag: "block",
  subsystem: "security",
  sentinel: AGENT_HOOKS_SENTINEL,
  confidence: "verified",
  sourceDocs: ["src/security/agent-hooks/runtimes.ts"],
  settingsFile: (root) => path.join(root, ".claude", "settings.json"),
  relativePath: ".claude/settings.json",
  slots: [
    { key: "hooks", type: "object", access: "owns" },
    { key: "_keryxManaged", type: "array", access: "owns" },
    { key: "unmigratedHooks", type: "array", access: "owns" },
  ],
  merge: (s) =>
    mergeIntoHookArray(
      s,
      "PreToolUse",
      {
        matcher: CLAUDE_PRE_TOOL_MATCHER,
        hooks: [{ type: "command", command: checkOutputCommand("claude") }],
        [MANAGED_KEY]: AGENT_HOOKS_SENTINEL,
      },
      AGENT_HOOKS_SENTINEL,
    ),
  strip: (s) => stripHookSurfaceKeepingSentinelIfSiblingPresent(s, "PreToolUse", "UserPromptSubmit", (c) => c.startsWith(AGENT_CHECK_INPUT_COMMAND)),
  validate: (s) =>
    hasStartsWithCommand(s, "hooks", "PreToolUse", AGENT_CHECK_OUTPUT_COMMAND)
      ? []
      : ["claude: missing PreToolUse check-output hook"],
};

/**
 * F6 (deliberate behaviour change, decision recorded by the orchestrator):
 * only entries carrying the `_keryxManaged` sentinel count towards "the check
 * hook is installed" — an unmanaged entry whose `command` merely happens to
 * start with the right base string no longer validates as installed. Before
 * this, a hostile or accidental unmanaged entry with the right-shaped command
 * (but none of the sentinel bookkeeping) could pass validation while never
 * having gone through this installer at all.
 */
function hasStartsWithCommand(settings: Settings, container: string, key: string, base: string): boolean {
  const isManaged = isManagedBy(AGENT_HOOKS_SENTINEL);
  const holder = typeof settings[container] === "object" && settings[container] !== null ? (settings[container] as Settings) : undefined;
  const groups = holder && Array.isArray(holder[key]) ? (holder[key] as unknown[]) : [];
  const commands = groups.flatMap((g) => {
    if (!isManaged(g)) return [];
    const entry = g as { hooks?: unknown };
    return Array.isArray(entry.hooks) ? (entry.hooks as Array<{ command?: unknown }>).map((h) => h.command) : [];
  });
  return commands.some((c) => typeof c === "string" && c.startsWith(base));
}

/** Strip this surface's own nested group; clear the shared sentinel only if its sibling key has none left. */
function stripHookSurfaceKeepingSentinelIfSiblingPresent(
  settings: Settings,
  ownKey: string,
  siblingKey: string,
  siblingCommandMatches: (c: string) => boolean,
): Settings {
  if (typeof settings.hooks !== "object" || settings.hooks === null || Array.isArray(settings.hooks)) {
    removeSentinelFrom(settings, AGENT_HOOKS_SENTINEL);
    return settings;
  }
  const hooks = { ...(settings.hooks as Settings) };
  if (Array.isArray(hooks[ownKey])) {
    const remaining = stripManagedBy(AGENT_HOOKS_SENTINEL)(hooks[ownKey]);
    if (remaining.length > 0) hooks[ownKey] = remaining;
    else delete hooks[ownKey];
  }
  if (Object.keys(hooks).length > 0) settings.hooks = hooks;
  else delete settings.hooks;
  const siblingPresent =
    managedGroups(settings, {
      sentinel: AGENT_HOOKS_SENTINEL,
      container: "hooks",
      key: siblingKey,
      shape: "nested",
      commandMatches: siblingCommandMatches,
    }).length > 0;
  if (!siblingPresent) removeSentinelFrom(settings, AGENT_HOOKS_SENTINEL);
  return settings;
}

// --- flat runtimes (cursor / windsurf / generic-mcp) --------------------------

export const SECURITY_HOOKS_KEY = "securityHooks";

function dropLegacyHooksArray(settings: Settings): void {
  if (!Array.isArray(settings.hooks)) return;
  const remaining = stripManagedBy(AGENT_HOOKS_SENTINEL)(settings.hooks);
  if (remaining.length > 0) settings.hooks = remaining;
  else delete settings.hooks;
}

function flatOn(g: unknown): string | undefined {
  return typeof g === "object" && g !== null ? ((g as Record<string, unknown>).on as string | undefined) : undefined;
}

/**
 * A managed entry carrying the security sentinel that neither the input nor
 * the output surface claims — `on` is something other than `"input"`/
 * `"output"`. Nothing in the two-surface model ever installs one, but
 * nothing removed one either (probe P8): each surface's filter only matched
 * its OWN `on`, so an entry with a stray `on` (or none) sat forever, and the
 * strip-clears-the-sentinel check only looked at the sibling `on`, so it
 * could leave the sentinel behind claiming an orphan that outlives both
 * surfaces. Each surface's merge/strip below also sweeps these up, and the
 * sentinel is cleared only when NO managed entry remains at all — matching
 * the pre-refactor `flatStrip`, which cleared unconditionally.
 */
function isOrphanManagedEntry(g: unknown): boolean {
  const on = flatOn(g);
  return isManagedBy(AGENT_HOOKS_SENTINEL)(g) && on !== "input" && on !== "output";
}

function flatSecuritySurface(harnessId: string, on: "input" | "output", relativePath: string): SurfaceAdapter {
  const command = on === "input" ? checkInputCommand(harnessId) : checkOutputCommand(harnessId);
  const base = on === "input" ? AGENT_CHECK_INPUT_COMMAND : AGENT_CHECK_OUTPUT_COMMAND;
  return {
    id: on === "input" ? "security-check-input" : "security-check-output",
    flag: on === "input" ? "prompt-gate" : "block",
    subsystem: "security",
    sentinel: AGENT_HOOKS_SENTINEL,
    confidence: "experimental",
    riskNotes: [
      "`securityHooks` matches no documented hook contract for this harness; it is keryx's own invention (tracked as OQ-3).",
    ],
    sourceDocs: ["src/security/agent-hooks/runtimes.ts"],
    settingsFile: (root) => path.join(root, ...relativePath.split("/")),
    relativePath,
    slots: [
      { key: SECURITY_HOOKS_KEY, type: "array", access: "owns" },
      { key: "_keryxManaged", type: "array", access: "owns" },
      // `dropLegacyHooksArray` only ever touches a PRE-EXISTING `hooks`
      // array (a shape written before `securityHooks` existed) and never
      // creates the key — see `SurfaceSlot.access` — so it coexists with a
      // ctx-guard/orient surface on the same file declaring `hooks: object`.
      { key: "hooks", type: "array", access: "migrates-legacy" },
    ],
    merge: (s) => {
      dropLegacyHooksArray(s);
      const existing = Array.isArray(s[SECURITY_HOOKS_KEY]) ? (s[SECURITY_HOOKS_KEY] as unknown[]) : [];
      const kept = existing.filter((g) => !(isManagedBy(AGENT_HOOKS_SENTINEL)(g) && flatOn(g) === on) && !isOrphanManagedEntry(g));
      s[SECURITY_HOOKS_KEY] = [...kept, { on, command, [MANAGED_KEY]: AGENT_HOOKS_SENTINEL }];
      addSentinelTo(s, AGENT_HOOKS_SENTINEL);
      return s;
    },
    strip: (s) => {
      dropLegacyHooksArray(s);
      const existing = Array.isArray(s[SECURITY_HOOKS_KEY]) ? (s[SECURITY_HOOKS_KEY] as unknown[]) : [];
      const remaining = existing.filter((g) => !(isManagedBy(AGENT_HOOKS_SENTINEL)(g) && flatOn(g) === on) && !isOrphanManagedEntry(g));
      if (remaining.length > 0) s[SECURITY_HOOKS_KEY] = remaining;
      else delete s[SECURITY_HOOKS_KEY];
      // Clear the sentinel only when NO managed entry remains at all (not
      // only the sibling's `on`) — an orphan must never keep the sentinel
      // alive once both real surfaces are gone.
      const anyManagedRemains = remaining.some((g) => isManagedBy(AGENT_HOOKS_SENTINEL)(g));
      if (!anyManagedRemains) removeSentinelFrom(s, AGENT_HOOKS_SENTINEL);
      return s;
    },
    validate: (s) => {
      const groups = Array.isArray(s[SECURITY_HOOKS_KEY]) ? (s[SECURITY_HOOKS_KEY] as unknown[]) : [];
      // `.some` over MANAGED entries with this `on`, never `.find`: a hostile
      // entry sharing `on` with the managed one must not read as installed.
      const managedCommands = groups
        .filter((g) => isManagedBy(AGENT_HOOKS_SENTINEL)(g) && flatOn(g) === on)
        .map((g) => (g as { command?: unknown }).command)
        .filter((c): c is string => typeof c === "string");
      return managedCommands.some((c) => c.startsWith(base)) ? [] : [`${harnessId}: missing ${on} hook routing to check-${on}`];
    },
  };
}

export const SECURITY_CHECK_INPUT_CURSOR = flatSecuritySurface("cursor", "input", ".cursor/hooks.json");
export const SECURITY_CHECK_OUTPUT_CURSOR = flatSecuritySurface("cursor", "output", ".cursor/hooks.json");
export const SECURITY_CHECK_INPUT_WINDSURF = flatSecuritySurface("windsurf", "input", ".windsurf/hooks.json");
export const SECURITY_CHECK_OUTPUT_WINDSURF = flatSecuritySurface("windsurf", "output", ".windsurf/hooks.json");
export const SECURITY_CHECK_INPUT_GENERIC_MCP = flatSecuritySurface("generic-mcp", "input", ".mcp/security-hooks.json");
export const SECURITY_CHECK_OUTPUT_GENERIC_MCP = flatSecuritySurface("generic-mcp", "output", ".mcp/security-hooks.json");
