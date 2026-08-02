import path from "node:path";

// Multi-runtime agent-hook registry (Block E, E5). Each supported agent runtime
// declares WHERE its settings live, HOW to merge/strip the managed security
// guard entries (preserving user content), and a validator that proves the
// rendered config routes input/output through the security CLI.
//
// Every runtime shares the sentinel discipline (`_keryxManaged`): managed
// entries are tagged so a targeted uninstall removes ONLY this installer's
// entries and a re-install never duplicates them. Claude Code keeps its shipped
// event-keyed `.claude/settings.json` schema; the other runtimes use a flat
// managed-groups array so their (still-evolving, OQ-3) schemas stay simple and
// validator-checked.

export const AGENT_HOOKS_SENTINEL = "security-agent-hooks";
export const MANAGED_KEY = "_keryxManaged";

/**
 * The installed hook commands, per runtime.
 *
 * `--runtime <id>` is what makes a refusal actually refuse. Without it the
 * command exits 1 on a blocked decision, and `src/ctx/runtimes.ts` — which owns
 * this contract — records that exit 1 is a NON-BLOCKING error for Claude, Codex
 * and Windsurf, while Cursor and Antigravity decide from stdout JSON and ignore
 * the code entirely. So the guard reported and did not refuse, on every runtime
 * keryx installs into, and the two hook surfaces in this repository disagreed
 * about the block signal with only one of them having looked it up.
 *
 * The base strings stay exported: they are what the validators match a rendered
 * config against, and a command carrying a different runtime id is still the
 * managed one.
 */
export const AGENT_CHECK_INPUT_COMMAND =
  "keryx security check-input --source untrusted-external";
export const AGENT_CHECK_OUTPUT_COMMAND = "keryx security check-output";

export function checkInputCommand(runtimeId: string): string {
  return `${AGENT_CHECK_INPUT_COMMAND} --runtime ${runtimeId}`;
}

export function checkOutputCommand(runtimeId: string): string {
  return `${AGENT_CHECK_OUTPUT_COMMAND} --runtime ${runtimeId}`;
}

export type Settings = Record<string, unknown>;

export interface RuntimeHook {
  readonly id: string;
  // Absolute settings-file path for this runtime under a project root.
  settingsPath(projectRoot: string): string;
  // Merge the managed entries into `settings`, preserving user content and
  // staying idempotent. Returns the settings object to write.
  merge(settings: Settings): Settings;
  // Remove ONLY the managed entries + sentinel, preserving user content.
  strip(settings: Settings): Settings;
  // Structural validation of a rendered config: empty array = valid.
  validate(settings: Settings): string[];
}

export function isManagedGroup(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Record<string, unknown>)[MANAGED_KEY] === AGENT_HOOKS_SENTINEL
  );
}

function stripManagedFromArray(existing: unknown): unknown[] {
  return Array.isArray(existing) ? existing.filter((g) => !isManagedGroup(g)) : [];
}

function setSentinel(settings: Settings): void {
  const managed = Array.isArray(settings[MANAGED_KEY])
    ? (settings[MANAGED_KEY] as unknown[]).filter((v) => v !== AGENT_HOOKS_SENTINEL)
    : [];
  settings[MANAGED_KEY] = [...managed, AGENT_HOOKS_SENTINEL];
}

function clearSentinel(settings: Settings): void {
  if (Array.isArray(settings[MANAGED_KEY])) {
    const managed = (settings[MANAGED_KEY] as unknown[]).filter(
      (v) => v !== AGENT_HOOKS_SENTINEL,
    );
    if (managed.length > 0) settings[MANAGED_KEY] = managed;
    else delete settings[MANAGED_KEY];
  }
}

// ---------------------------------------------------------------------------
// Claude Code — the shipped `.claude/settings.json` event-keyed schema.
// ---------------------------------------------------------------------------

const CLAUDE_PRE_TOOL_MATCHER = "Write|Edit";

function claudeMerge(settings: Settings): Settings {
  const hooks: Settings =
    typeof settings.hooks === "object" &&
    settings.hooks !== null &&
    !Array.isArray(settings.hooks)
      ? { ...(settings.hooks as Settings) }
      : {};

  hooks.UserPromptSubmit = [
    ...stripManagedFromArray(hooks.UserPromptSubmit),
    {
      hooks: [{ type: "command", command: checkInputCommand("claude") }],
      [MANAGED_KEY]: AGENT_HOOKS_SENTINEL,
    },
  ];
  hooks.PreToolUse = [
    ...stripManagedFromArray(hooks.PreToolUse),
    {
      matcher: CLAUDE_PRE_TOOL_MATCHER,
      hooks: [{ type: "command", command: checkOutputCommand("claude") }],
      [MANAGED_KEY]: AGENT_HOOKS_SENTINEL,
    },
  ];

  settings.hooks = hooks;
  setSentinel(settings);
  return settings;
}

function claudeStrip(settings: Settings): Settings {
  if (
    typeof settings.hooks !== "object" ||
    settings.hooks === null ||
    Array.isArray(settings.hooks)
  ) {
    clearSentinel(settings);
    return settings;
  }
  const hooks = { ...(settings.hooks as Settings) };
  for (const event of ["UserPromptSubmit", "PreToolUse"] as const) {
    if (!Array.isArray(hooks[event])) continue;
    const remaining = stripManagedFromArray(hooks[event]);
    if (remaining.length > 0) hooks[event] = remaining;
    else delete hooks[event];
  }
  if (Object.keys(hooks).length > 0) settings.hooks = hooks;
  else delete settings.hooks;
  clearSentinel(settings);
  return settings;
}

function claudeValidate(settings: Settings): string[] {
  const errors: string[] = [];
  const hooks = settings.hooks as Settings | undefined;
  const cmds = (event: string): string[] =>
    (Array.isArray(hooks?.[event]) ? (hooks?.[event] as unknown[]) : []).flatMap(
      (g) =>
        Array.isArray((g as { hooks?: unknown[] })?.hooks)
          ? ((g as { hooks: Array<{ command?: unknown }> }).hooks.map((h) =>
              typeof h.command === "string" ? h.command : "",
            ))
          : [],
    );
  // Prefix, not equality: the command now carries `--runtime claude`, and a
  // config written by an older keryx must still validate.
  if (!cmds("UserPromptSubmit").some((c) => c.startsWith(AGENT_CHECK_INPUT_COMMAND))) {
    errors.push("claude: missing UserPromptSubmit check-input hook");
  }
  if (!cmds("PreToolUse").some((c) => c.startsWith(AGENT_CHECK_OUTPUT_COMMAND))) {
    errors.push("claude: missing PreToolUse check-output hook");
  }
  return errors;
}

// ---------------------------------------------------------------------------
// Flat managed-groups runtimes (cursor / windsurf / generic-mcp).
//
// These entries live under `securityHooks`, NOT under `hooks`, and that is a
// correctness fix rather than a style choice.
//
// `src/ctx/runtimes.ts` installs a shell guard into the SAME FILES —
// `.cursor/hooks.json` and `.windsurf/hooks.json` — and writes `hooks` as an
// OBJECT keyed by the runtime's real event name (`beforeShellExecution`,
// `pre_run_command`), which it marks `confidence: "verified"`. This installer
// wrote `hooks` as an ARRAY. Two incompatible types under one key, and each
// installer's strip helper replaces what it does not recognise wholesale, so
// whichever ran second destroyed the first:
//
//   ctx then security -> ctx.validate: ["cursor: missing beforeShellExecution guard"]
//   security then ctx -> sec.validate: ["cursor: missing input hook routing …"]
//   and in both cases  -> _keryxManaged: ["ctx-agent-hooks","security-agent-hooks"]
//
// The sentinel kept claiming the destroyed guard was installed, so an audit or
// an uninstall would report a guard that is not there. An operator who ran both
// documented install commands ended up with exactly one of them, chosen by
// ordering.
//
// `hooks` now belongs to ctx, which has verified contracts for it. These entries
// move to their own key, so neither installer can see or damage the other's.
//
// STATED, because a round found it and the honest answer is not to hide it:
// this shape is keryx's own invention and matches no documented contract for
// cursor or windsurf. `flatValidate` checks that the installer wrote what the
// installer intended — not that the runtime will honour it. Where ctx has a
// verified event name for these files, this module does not, and inventing a
// second one would repeat the mistake rather than fix it. Tracked as OQ-3.
// ---------------------------------------------------------------------------

/** The key this installer owns. `hooks` belongs to `src/ctx/runtimes.ts`. */
export const SECURITY_HOOKS_KEY = "securityHooks";

/**
 * Remove this installer's entries from the LEGACY `hooks` array, if present.
 *
 * A config written before the split has managed groups in `hooks`. They must go,
 * or an uninstall leaves them behind and a re-install duplicates them — but only
 * OURS, and only when `hooks` is an array. If a user put their own entries in
 * that array they stay, and if `hooks` is an object it is ctx's and is not
 * touched at all.
 */
function dropLegacyEntries(settings: Settings): void {
  if (!Array.isArray(settings.hooks)) {
    return;
  }
  const remaining = stripManagedFromArray(settings.hooks);
  if (remaining.length > 0) {
    settings.hooks = remaining;
  } else {
    delete settings.hooks;
  }
}

function flatMerge(id: string): (settings: Settings) => Settings {
  return (settings: Settings): Settings => {
    dropLegacyEntries(settings);
    const userGroups = stripManagedFromArray(settings[SECURITY_HOOKS_KEY]);
    settings[SECURITY_HOOKS_KEY] = [
      ...userGroups,
      { on: "input", command: checkInputCommand(id), [MANAGED_KEY]: AGENT_HOOKS_SENTINEL },
      { on: "output", command: checkOutputCommand(id), [MANAGED_KEY]: AGENT_HOOKS_SENTINEL },
    ];
    setSentinel(settings);
    return settings;
  };
}

function flatStrip(settings: Settings): Settings {
  dropLegacyEntries(settings);
  const remaining = stripManagedFromArray(settings[SECURITY_HOOKS_KEY]);
  if (remaining.length > 0) {
    settings[SECURITY_HOOKS_KEY] = remaining;
  } else {
    delete settings[SECURITY_HOOKS_KEY];
  }
  clearSentinel(settings);
  return settings;
}

function flatValidate(id: string): (settings: Settings) => string[] {
  return (settings: Settings): string[] => {
    const errors: string[] = [];
    const groups = Array.isArray(settings[SECURITY_HOOKS_KEY])
      ? (settings[SECURITY_HOOKS_KEY] as unknown[])
      : [];
    // `.some` over the MANAGED entries, not `.find` over the first match.
    //
    // `flatMerge` appends the managed entries AFTER preserved user groups, so
    // `find` reached a user entry first whenever one carried the same `on`. A
    // repository could ship a `.cursor/hooks.json` holding
    // `{on:"input", command:"keryx security check-input …; curl … | sh"}` and
    // `hooks install` would validate clean against the attacker's line while
    // the managed one sat below it unread. The symmetric case is noisier and
    // just as wrong: a benign user entry made install report the managed hook
    // missing when it was present.
    //
    // Every other validator in both registries already used `.some`; this was
    // the one that did not.
    const managedCommands = (on: string): string[] =>
      groups
        .filter(
          (x) =>
            x !== null &&
            typeof x === "object" &&
            (x as { on?: unknown }).on === on &&
            isManagedGroup(x),
        )
        .map((x) => (x as { command?: unknown }).command)
        .filter((command): command is string => typeof command === "string");
    // `startsWith`, because the command carries `--runtime <id>`. Matching the
    // base means a config written by an older keryx still validates, and a
    // config carrying the wrong runtime id is still recognisably the managed
    // hook rather than a stranger's.
    if (!managedCommands("input").some((c) => c.startsWith(AGENT_CHECK_INPUT_COMMAND))) {
      errors.push(`${id}: missing input hook routing to check-input`);
    }
    if (!managedCommands("output").some((c) => c.startsWith(AGENT_CHECK_OUTPUT_COMMAND))) {
      errors.push(`${id}: missing output hook routing to check-output`);
    }
    return errors;
  };
}

function flatRuntime(id: string, relativePath: string): RuntimeHook {
  return {
    id,
    settingsPath: (root) => path.join(root, ...relativePath.split("/")),
    merge: flatMerge(id),
    strip: flatStrip,
    validate: flatValidate(id),
  };
}

export const CLAUDE_RUNTIME: RuntimeHook = {
  id: "claude",
  settingsPath: (root) => path.join(root, ".claude", "settings.json"),
  merge: claudeMerge,
  strip: claudeStrip,
  validate: claudeValidate,
};

export const RUNTIME_HOOKS: RuntimeHook[] = [
  CLAUDE_RUNTIME,
  flatRuntime("cursor", ".cursor/hooks.json"),
  flatRuntime("windsurf", ".windsurf/hooks.json"),
  flatRuntime("generic-mcp", ".mcp/security-hooks.json"),
];

export function runtimeIds(): string[] {
  return RUNTIME_HOOKS.map((r) => r.id);
}

export function getRuntime(id: string): RuntimeHook | undefined {
  return RUNTIME_HOOKS.find((r) => r.id === id);
}
