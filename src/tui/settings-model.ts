// Flow 374: the rows behind `/settings` — the settings-like slash commands
// gathered into one list. Pure: a plain snapshot in, rows out, no I/O and no
// renderer, so the TUI modal and the readline table are two views of the SAME
// rows and a unit test can pin every value text and scope label.
//
// Each action carries the slash line that performs it; the caller runs that
// line through the command's own handler. Nothing here decides how a setting
// is written, and `/mode`/`/plan` stay session-only exactly as typed.

import { REASONING_EFFORT_LEVELS, type ReasoningEffortLevel, type ReasoningEffortSource } from "../commands/agent";
import { PERMISSION_MODES, type PermissionMode } from "../commands/permission-mode";
import { RENDER_MODES, type RenderMode } from "../remote/rendering-mode";
import { THINK_DISPLAY_MODES, type ThinkDisplayMode } from "./reasoning-display";
import { THEME_IDS, type ThemeId } from "./theme";

export const SETTING_GROUPS = ["Safety", "Routing", "Display", "External"] as const;
export type SettingGroup = (typeof SETTING_GROUPS)[number];

/**
 * Where a change lives. `session` dies with the process, `saved` is written to
 * disk by the command's own handler, `restart` only takes effect on the next start.
 */
export type SettingScope = "session" | "saved" | "restart";

export interface SettingAction {
  label: string;
  /** The slash line this button runs, e.g. `/mode trust`. */
  command: string;
  /** This button is the value currently in effect. */
  active: boolean;
  /** The modal asks for a second Enter before running it. */
  confirm: boolean;
}

export interface SettingRow {
  id: string;
  group: SettingGroup;
  label: string;
  value: string;
  scope: SettingScope;
  /** Why the effective value is what it is, when something other than the plain setting decides it. */
  detail?: string;
  /** The command that owns this setting, and its usage line. */
  command: string;
  usage: string;
  /** Empty for a read-only row: the operator runs `command` instead. */
  actions: SettingAction[];
}

/** What the rows are built from. Loaded elsewhere (`settings-state.ts`), never here. */
export interface SettingsSnapshot {
  permissionMode: PermissionMode;
  /** This project's saved default, when one is set. */
  projectPermissionMode?: PermissionMode;
  plan: boolean;
  guard: boolean;
  editGuard: boolean;
  routing: boolean;
  externalPrivacy: { value: "on" | "off"; source: "project" | "user" | "default" };
  /**
   * `envWinsOnRestart`: the session's own choice is in effect, but KERYX_REASONING_EFFORT
   * is set too and, below a session override only, wins again on the next start.
   */
  reasoning: { effort: ReasoningEffortLevel; source: ReasoningEffortSource; envWinsOnRestart?: boolean };
  thinkDisplay: ThinkDisplayMode;
  theme: ThemeId;
  jevProfile: { on: number; total: number };
  /** `reason` is why the runtime is off, when it is. */
  externalAgents: { on: boolean; reason?: string };
  /** How Telegram replies are written (flow 395). `saveable`: a remote config exists to hold a change. */
  rendering: { mode: RenderMode; saveable: boolean };
}

const onOff = (value: boolean): string => (value ? "on" : "off");

function action(label: string, command: string, active: boolean, confirm = false): SettingAction {
  return { label, command, active, confirm };
}

function toggleActions(command: string, value: boolean): SettingAction[] {
  return [action("On", `${command} on`, value), action("Off", `${command} off`, !value)];
}

function neighbour(current: ThemeId, step: 1 | -1): ThemeId {
  const index = THEME_IDS.indexOf(current);
  return THEME_IDS[(index + step + THEME_IDS.length) % THEME_IDS.length]!;
}

/**
 * `/reasoning <level>` sets the session override AND writes the saved default, but
 * `resolveReasoningEffort` ranks session > KERYX_REASONING_EFFORT > saved. So a
 * press is lasting only while the variable is unset; with it set, the variable
 * wins again after a restart and the row says so instead of claiming `saved`.
 */
function reasoningScope(reasoning: SettingsSnapshot["reasoning"]): { scope: SettingScope; detail?: string } {
  switch (reasoning.source) {
    case "session":
      return reasoning.envWinsOnRestart === true
        ? { scope: "session", detail: "set this session; KERYX_REASONING_EFFORT wins again after a restart" }
        : { scope: "saved", detail: "set this session and saved" };
    case "env":
      return { scope: "session", detail: "from KERYX_REASONING_EFFORT; a choice here lasts this session, the variable wins again after a restart" };
    case "default":
      return { scope: "saved", detail: "default" };
    case "global":
      return { scope: "saved" };
  }
}

const EXTERNAL_PRIVACY_DETAIL: Record<SettingsSnapshot["externalPrivacy"]["source"], string | undefined> = {
  project: "this project overrides the per-user setting",
  user: undefined,
  default: "default",
};

export function buildSettingsRows(state: SettingsSnapshot): SettingRow[] {
  const reasoning = reasoningScope(state.reasoning);
  return [
    {
      id: "mode",
      group: "Safety",
      label: "Permission mode",
      value: state.permissionMode,
      scope: "session",
      ...(state.projectPermissionMode !== undefined ? { detail: `project default: ${state.projectPermissionMode}` } : {}),
      command: "/mode",
      usage: `/mode [${PERMISSION_MODES.join("|")}]`,
      actions: PERMISSION_MODES.map((mode) => action(mode, `/mode ${mode}`, mode === state.permissionMode, mode === "auto")),
    },
    {
      id: "plan",
      group: "Safety",
      label: "Plan (read-only)",
      value: onOff(state.plan),
      scope: "session",
      command: "/plan",
      usage: "/plan [on|off]",
      actions: toggleActions("/plan", state.plan),
    },
    {
      id: "guard",
      group: "Safety",
      label: "Turn guard",
      value: onOff(state.guard),
      scope: "saved",
      command: "/guard",
      usage: "/guard [on|off]",
      actions: toggleActions("/guard", state.guard),
    },
    {
      id: "editguard",
      group: "Safety",
      label: "Edit guard",
      value: onOff(state.editGuard),
      scope: "saved",
      detail: "this project",
      command: "/editguard",
      usage: "/editguard [on|off]",
      actions: toggleActions("/editguard", state.editGuard),
    },
    {
      id: "route",
      group: "Routing",
      label: "Classifier routing",
      value: onOff(state.routing),
      scope: "saved",
      command: "/route",
      usage: "/route [on|off]",
      actions: toggleActions("/route", state.routing),
    },
    {
      id: "reasoning",
      group: "Routing",
      label: "Reasoning effort",
      value: state.reasoning.effort,
      scope: reasoning.scope,
      ...(reasoning.detail !== undefined ? { detail: reasoning.detail } : {}),
      command: "/reasoning",
      usage: `/reasoning [${REASONING_EFFORT_LEVELS.join("|")}]`,
      actions: REASONING_EFFORT_LEVELS.map((level) => action(level, `/reasoning ${level}`, level === state.reasoning.effort)),
    },
    {
      id: "think",
      group: "Display",
      label: "Reasoning display",
      value: state.thinkDisplay,
      scope: "saved",
      command: "/think",
      usage: `/think [${THINK_DISPLAY_MODES.join("|")}]`,
      actions: THINK_DISPLAY_MODES.map((mode) => action(mode, `/think ${mode}`, mode === state.thinkDisplay)),
    },
    {
      id: "theme",
      group: "Display",
      label: "Theme",
      value: state.theme,
      scope: "saved",
      command: "/theme",
      usage: "/theme [name]",
      actions: [
        action("Auto", "/theme auto", state.theme === "auto"),
        action("Prev", `/theme ${neighbour(state.theme, -1)}`, false),
        action("Next", `/theme ${neighbour(state.theme, 1)}`, false),
      ],
    },
    {
      id: "external",
      group: "External",
      label: "External providers",
      value: state.externalPrivacy.value,
      scope: "saved",
      ...(EXTERNAL_PRIVACY_DETAIL[state.externalPrivacy.source] !== undefined
        ? { detail: EXTERNAL_PRIVACY_DETAIL[state.externalPrivacy.source]! }
        : {}),
      command: "/external",
      usage: "/external [on|off]",
      actions: toggleActions("/external", state.externalPrivacy.value === "on"),
    },
    {
      id: "external-agents",
      group: "External",
      label: "External agents",
      value: onOff(state.externalAgents.on),
      scope: "saved",
      ...(state.externalAgents.reason !== undefined ? { detail: state.externalAgents.reason } : {}),
      command: "/external-agents",
      usage: "/external-agents [on|off]",
      actions: toggleActions("/external-agents", state.externalAgents.on),
    },
    {
      id: "rendering",
      group: "External",
      label: "Telegram rendering",
      value: state.rendering.mode,
      scope: "saved",
      ...(state.rendering.saveable ? {} : { detail: "remote control is not set up yet" }),
      command: "/rendering",
      usage: `/rendering [${RENDER_MODES.join("|")}]`,
      actions: RENDER_MODES.map((mode) => action(mode, `/rendering ${mode}`, mode === state.rendering.mode)),
    },
    {
      id: "jevprofile",
      group: "External",
      label: "Jev review profile",
      value: `${state.jevProfile.on} of ${state.jevProfile.total} keys on`,
      scope: "saved",
      detail: "nine keys, no single value",
      command: "/jevprofile",
      usage: "/jevprofile",
      actions: [],
    },
  ];
}

/** The plain-text view: the readline shell's `/settings`. */
export function formatSettingsTable(rows: readonly SettingRow[], options: { available?: ReadonlySet<string> } = {}): string {
  const labelWidth = Math.max(...rows.map((row) => row.label.length));
  const valueWidth = Math.max(...rows.map((row) => row.value.length));
  const lines: string[] = [];
  for (const group of SETTING_GROUPS) {
    const inGroup = rows.filter((row) => row.group === group);
    if (inGroup.length === 0) continue;
    lines.push(group);
    for (const row of inGroup) {
      const here = options.available === undefined || options.available.has(row.command);
      const scope = `[${row.scope}]`.padEnd("[session]".length);
      const tail = here ? row.usage : `${row.usage} (TUI only)`;
      const detail = row.detail === undefined ? "" : `  (${row.detail})`;
      lines.push(`  ${row.label.padEnd(labelWidth)}  ${row.value.padEnd(valueWidth)}  ${scope}  ${tail}${detail}`);
    }
  }
  return `${lines.join("\n")}\n`;
}
