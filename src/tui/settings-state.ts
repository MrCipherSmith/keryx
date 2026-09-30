// Flow 374: the I/O half of `/settings` — reads every setting from where its own
// command reads it, and hands the result to the pure row builder. Shared by the
// TUI modal and the readline table so the two can never disagree.
//
// What only the running session knows (the permission mode, plan, and the
// TUI's own toggles) comes in as `live`; everything else is read fresh. A read
// that fails falls back to the same default its command uses.

import { resolveExternalAgentsCapability } from "../capability/external-agents";
import { describeReasoningEffortSource } from "../commands/agent";
import type { PermissionMode } from "../commands/permission-mode";
import { readJevProfileForShell } from "../commands/review-jev-profile";
import { resolveExternalSetting } from "../lib/external-switch";
import { getProjectPermissionMode } from "../lib/permission-mode-config";
import { loadShellConfig } from "../lib/shell-config";
import { readJevEditGuardConfig } from "../review/jev-edit-guard-config";
import { RECOMMENDED_JEV_PROFILE } from "../review/jev-profile";
import { resolveThinkDisplayMode, type ThinkDisplayMode } from "./reasoning-display";
import type { SettingsSnapshot } from "./settings-model";
import { getThemeId } from "./theme";

/** The values only the running shell holds. The optional ones fall back to what was saved. */
export interface LiveSettings {
  permissionMode: PermissionMode;
  plan: boolean;
  guard?: boolean;
  routing?: boolean;
  thinkDisplay?: ThinkDisplayMode;
  reasoningOverride?: string | undefined;
}

function readReasoning(sessionOverride: string | undefined, globalEffort: string | undefined): SettingsSnapshot["reasoning"] {
  const resolved = describeReasoningEffortSource({ sessionOverride, globalEffort });
  // Without the session override, who wins next start: the variable, or the saved value?
  const afterRestart = describeReasoningEffortSource({ globalEffort });
  return resolved.source === "session" && afterRestart.source === "env" ? { ...resolved, envWinsOnRestart: true } : resolved;
}

async function orElse<T>(read: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await read();
  } catch {
    return fallback;
  }
}

export async function loadSettingsSnapshot(cwd: string, live: LiveSettings, configDir?: string): Promise<SettingsSnapshot> {
  const saved = loadShellConfig(configDir);
  const projectMode = getProjectPermissionMode(cwd, configDir);
  const [externalPrivacy, editGuard, jevProfile, agents] = await Promise.all([
    orElse(() => resolveExternalSetting({ cwd, ...(configDir !== undefined ? { dir: configDir } : {}) }), { value: "on" as const, source: "default" as const }),
    orElse(async () => (await readJevEditGuardConfig(cwd)).enabled, false),
    orElse(() => readJevProfileForShell(cwd), {} as Record<string, unknown>),
    orElse(() => resolveExternalAgentsCapability({ cwd }), { ok: false as const, reason: "could not be read" }),
  ]);
  return {
    permissionMode: live.permissionMode,
    ...(projectMode !== undefined ? { projectPermissionMode: projectMode } : {}),
    plan: live.plan,
    guard: live.guard ?? saved.turnGuard?.enabled === true,
    editGuard,
    routing: live.routing ?? saved.routingClassifier?.enabled === true,
    externalPrivacy,
    reasoning: readReasoning(live.reasoningOverride, saved.reasoningEffort),
    thinkDisplay: live.thinkDisplay ?? resolveThinkDisplayMode(saved.thinkDisplay),
    theme: getThemeId(),
    jevProfile: {
      on: RECOMMENDED_JEV_PROFILE.filter((entry) => jevProfile[entry.key] === true).length,
      total: RECOMMENDED_JEV_PROFILE.length,
    },
    externalAgents: agents.ok ? { on: true } : { on: false, reason: agents.reason },
  };
}
