import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathExists } from "../lib/fs";

// Merge-safe installer for the Metaproject Security agent guard hooks in a
// project-local `.claude/settings.json`. The two hooks route agent inputs and
// outputs through the security CLI:
//   - UserPromptSubmit -> `gd-metapro security check-input --source untrusted-external`
//   - PreToolUse(Write|Edit) -> `gd-metapro security check-output`
//
// #1 rule: never clobber user config. Every managed hook group carries a
// sentinel key so uninstall targets ONLY the entries this installer wrote; all
// pre-existing keys and user hook entries are preserved untouched, and re-install
// is idempotent (managed groups are stripped and re-appended, never duplicated).

export const AGENT_HOOKS_SENTINEL = "security-agent-hooks";
const MANAGED_KEY = "_gdMetaproManaged";

export const AGENT_CHECK_INPUT_COMMAND =
  "gd-metapro security check-input --source untrusted-external";
export const AGENT_CHECK_OUTPUT_COMMAND = "gd-metapro security check-output";
const PRE_TOOL_USE_MATCHER = "Write|Edit";

export const AGENT_SETTINGS_RELATIVE_PATH = ".claude/settings.json";

type HookCommand = { type: "command"; command: string };
type HookGroup = {
  matcher?: string;
  hooks: HookCommand[];
  [MANAGED_KEY]?: string;
  [key: string]: unknown;
};

export function agentSettingsPath(projectRoot: string): string {
  return path.join(projectRoot, ".claude", "settings.json");
}

// The managed hook groups this installer owns, each tagged with the sentinel so
// they can be removed precisely without touching user-authored entries.
function managedUserPromptSubmitGroup(): HookGroup {
  return {
    hooks: [{ type: "command", command: AGENT_CHECK_INPUT_COMMAND }],
    [MANAGED_KEY]: AGENT_HOOKS_SENTINEL,
  };
}

function managedPreToolUseGroup(): HookGroup {
  return {
    matcher: PRE_TOOL_USE_MATCHER,
    hooks: [{ type: "command", command: AGENT_CHECK_OUTPUT_COMMAND }],
    [MANAGED_KEY]: AGENT_HOOKS_SENTINEL,
  };
}

export function securityAgentHookEntries(): {
  UserPromptSubmit: HookGroup;
  PreToolUse: HookGroup;
} {
  return {
    UserPromptSubmit: managedUserPromptSubmitGroup(),
    PreToolUse: managedPreToolUseGroup(),
  };
}

function isManagedGroup(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Record<string, unknown>)[MANAGED_KEY] === AGENT_HOOKS_SENTINEL
  );
}

// Return the user-authored groups for one hook event, dropping any previously
// installed managed security groups so re-install stays idempotent.
function stripManaged(existing: unknown): unknown[] {
  if (!Array.isArray(existing)) {
    return [];
  }
  return existing.filter((group) => !isManagedGroup(group));
}

async function readSettings(projectRoot: string): Promise<Record<string, unknown>> {
  const file = agentSettingsPath(projectRoot);
  if (!(await pathExists(file))) {
    return {};
  }
  try {
    const parsed = JSON.parse(await readFile(file, "utf8")) as unknown;
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return {};
  } catch {
    // Malformed settings: fall back to an empty object rather than clobbering is
    // unsafe, so we surface via a thrown error to the caller instead.
    throw new Error(`Cannot parse ${file}: file is not valid JSON`);
  }
}

async function writeSettings(
  projectRoot: string,
  settings: Record<string, unknown>,
): Promise<void> {
  const file = agentSettingsPath(projectRoot);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
}

// Merge the managed security hook groups into `.claude/settings.json`, creating
// the file if absent, preserving every pre-existing key and user hook entry, and
// staying idempotent on re-run. Returns true when the file was written.
export async function installSecurityAgentHooks(projectRoot: string): Promise<boolean> {
  const settings = await readSettings(projectRoot);
  const hooks: Record<string, unknown> =
    typeof settings.hooks === "object" &&
    settings.hooks !== null &&
    !Array.isArray(settings.hooks)
      ? { ...(settings.hooks as Record<string, unknown>) }
      : {};

  const entries = securityAgentHookEntries();
  hooks.UserPromptSubmit = [
    ...stripManaged(hooks.UserPromptSubmit),
    entries.UserPromptSubmit,
  ];
  hooks.PreToolUse = [...stripManaged(hooks.PreToolUse), entries.PreToolUse];

  settings.hooks = hooks;

  const managed = Array.isArray(settings[MANAGED_KEY])
    ? (settings[MANAGED_KEY] as unknown[]).filter(
        (value) => value !== AGENT_HOOKS_SENTINEL,
      )
    : [];
  settings[MANAGED_KEY] = [...managed, AGENT_HOOKS_SENTINEL];

  await writeSettings(projectRoot, settings);
  return true;
}

// Remove ONLY the managed security hook groups, preserving all user content.
// Empties/keys that become empty are cleaned up so no dangling structure remains.
export async function uninstallSecurityAgentHooks(projectRoot: string): Promise<boolean> {
  const file = agentSettingsPath(projectRoot);
  if (!(await pathExists(file))) {
    return false;
  }
  const settings = await readSettings(projectRoot);
  if (
    typeof settings.hooks !== "object" ||
    settings.hooks === null ||
    Array.isArray(settings.hooks)
  ) {
    return false;
  }
  const hooks = { ...(settings.hooks as Record<string, unknown>) };

  for (const event of ["UserPromptSubmit", "PreToolUse"] as const) {
    if (!Array.isArray(hooks[event])) {
      continue;
    }
    const remaining = stripManaged(hooks[event]);
    if (remaining.length > 0) {
      hooks[event] = remaining;
    } else {
      delete hooks[event];
    }
  }

  if (Object.keys(hooks).length > 0) {
    settings.hooks = hooks;
  } else {
    delete settings.hooks;
  }

  if (Array.isArray(settings[MANAGED_KEY])) {
    const managed = (settings[MANAGED_KEY] as unknown[]).filter(
      (value) => value !== AGENT_HOOKS_SENTINEL,
    );
    if (managed.length > 0) {
      settings[MANAGED_KEY] = managed;
    } else {
      delete settings[MANAGED_KEY];
    }
  }

  await writeSettings(projectRoot, settings);
  return true;
}
