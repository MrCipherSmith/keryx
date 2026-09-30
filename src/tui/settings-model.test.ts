import { describe, expect, test } from "bun:test";
import { REASONING_EFFORT_LEVELS } from "../commands/agent";
import { PERMISSION_MODES } from "../commands/permission-mode";
import { buildSettingsRows, formatSettingsTable, SETTING_GROUPS, type SettingRow, type SettingsSnapshot } from "./settings-model";
import { THINK_DISPLAY_MODES } from "./reasoning-display";
import { THEME_IDS } from "./theme";

const BASE: SettingsSnapshot = {
  permissionMode: "ask",
  plan: false,
  guard: false,
  editGuard: false,
  routing: false,
  externalPrivacy: { value: "on", source: "user" },
  reasoning: { effort: "off", source: "global" },
  thinkDisplay: "auto",
  theme: "auto",
  jevProfile: { on: 3, total: 9 },
  externalAgents: { on: false, reason: "not enabled" },
};

const rowOf = (rows: readonly SettingRow[], id: string): SettingRow => {
  const row = rows.find((candidate) => candidate.id === id);
  if (row === undefined) throw new Error(`no row ${id}`);
  return row;
};

describe("buildSettingsRows", () => {
  const rows = buildSettingsRows(BASE);

  test("every row, in order, with its group, label, value and scope", () => {
    expect(rows.map((row) => [row.id, row.group, row.label, row.value, row.scope])).toEqual([
      ["mode", "Safety", "Permission mode", "ask", "session"],
      ["plan", "Safety", "Plan (read-only)", "off", "session"],
      ["guard", "Safety", "Turn guard", "off", "saved"],
      ["editguard", "Safety", "Edit guard", "off", "saved"],
      ["route", "Routing", "Classifier routing", "off", "saved"],
      ["reasoning", "Routing", "Reasoning effort", "off", "saved"],
      ["think", "Display", "Reasoning display", "auto", "saved"],
      ["theme", "Display", "Theme", "auto", "saved"],
      ["external", "External", "External providers", "on", "saved"],
      ["external-agents", "External", "External agents", "off", "saved"],
      ["jevprofile", "External", "Jev review profile", "3 of 9 keys on", "saved"],
    ]);
  });

  test("groups appear contiguously and in the declared order", () => {
    const seen = rows.map((row) => row.group).filter((group, index, all) => all.indexOf(group) === index);
    expect(seen).toEqual([...SETTING_GROUPS]);
  });

  test("each row names the command that owns it, and its buttons run that command", () => {
    const owner: Record<string, string> = {
      mode: "/mode",
      plan: "/plan",
      guard: "/guard",
      editguard: "/editguard",
      route: "/route",
      reasoning: "/reasoning",
      think: "/think",
      theme: "/theme",
      external: "/external",
      "external-agents": "/external-agents",
      jevprofile: "/jevprofile",
    };
    for (const row of rows) {
      expect(row.command).toBe(owner[row.id]!);
      expect(row.usage.startsWith(row.command)).toBe(true);
      for (const action of row.actions) expect(action.command.startsWith(`${row.command} `)).toBe(true);
    }
  });

  test("/external is the privacy switch, never the agent runtime's command", () => {
    expect(rowOf(rows, "external").command).toBe("/external");
    expect(rowOf(rows, "external-agents").command).toBe("/external-agents");
  });

  test("the session rows are session, and no other row claims it", () => {
    expect(rows.filter((row) => row.scope === "session").map((row) => row.id)).toEqual(["mode", "plan"]);
  });

  test("permission mode: one button per mode, the current one active, only auto asks twice", () => {
    const mode = rowOf(buildSettingsRows({ ...BASE, permissionMode: "trust" }), "mode");
    expect(mode.actions.map((a) => [a.label, a.command, a.active, a.confirm])).toEqual(
      PERMISSION_MODES.map((m) => [m, `/mode ${m}`, m === "trust", m === "auto"]),
    );
  });

  test("a project default is shown next to the session's own mode", () => {
    expect(rowOf(buildSettingsRows({ ...BASE, permissionMode: "trust", projectPermissionMode: "ask" }), "mode").detail).toBe(
      "project default: ask",
    );
    expect(rowOf(rows, "mode").detail).toBeUndefined();
  });

  test("on/off rows mark exactly one button active and flip with the value", () => {
    for (const id of ["plan", "guard", "editguard", "route", "external-agents"]) {
      const off = rowOf(rows, id);
      expect(off.actions.map((a) => [a.label, a.active])).toEqual([
        ["On", false],
        ["Off", true],
      ]);
      expect(off.actions.map((a) => a.confirm)).toEqual([false, false]);
    }
    const on = buildSettingsRows({
      ...BASE,
      plan: true,
      guard: true,
      editGuard: true,
      routing: true,
      externalPrivacy: { value: "off", source: "project" },
      externalAgents: { on: true },
    });
    for (const id of ["plan", "guard", "editguard", "route", "external-agents"]) expect(rowOf(on, id).value).toBe("on");
    expect(rowOf(on, "plan").actions.map((a) => a.active)).toEqual([true, false]);
    expect(rowOf(rows, "external").actions.map((a) => a.active)).toEqual([true, false]);
    expect(rowOf(on, "external").value).toBe("off");
    expect(rowOf(on, "external").actions.map((a) => a.active)).toEqual([false, true]);
  });

  test("reasoning: one button per level, and the source explains the value", () => {
    const reasoning = rowOf(buildSettingsRows({ ...BASE, reasoning: { effort: "high", source: "session" } }), "reasoning");
    expect(reasoning.value).toBe("high");
    expect(reasoning.detail).toBe("set this session and saved");
    expect(reasoning.scope).toBe("saved");
    expect(reasoning.actions.map((a) => [a.label, a.command, a.active])).toEqual(
      REASONING_EFFORT_LEVELS.map((level) => [level, `/reasoning ${level}`, level === "high"]),
    );
    expect(rowOf(buildSettingsRows({ ...BASE, reasoning: { effort: "off", source: "default" } }), "reasoning").detail).toBe("default");
    expect(rowOf(rows, "reasoning").detail).toBeUndefined();
  });

  test("reasoning: scope and detail follow the real precedence (session > env > saved), one case per source", () => {
    const of = (reasoning: SettingsSnapshot["reasoning"]) => rowOf(buildSettingsRows({ ...BASE, reasoning }), "reasoning");
    // A press sets the session AND the saved value; with no variable set, it is saved for real.
    expect(of({ effort: "high", source: "session" })).toMatchObject({ scope: "saved", detail: "set this session and saved" });
    // With the variable set it wins again after a restart: not `saved`.
    const pinned = of({ effort: "high", source: "session", envWinsOnRestart: true });
    expect(pinned.scope).toBe("session");
    expect(pinned.detail).toBe("set this session; KERYX_REASONING_EFFORT wins again after a restart");
    const env = of({ effort: "low", source: "env" });
    expect(env.scope).toBe("session");
    expect(env.detail).toContain("KERYX_REASONING_EFFORT");
    expect(env.detail).toContain("after a restart");
    expect(of({ effort: "medium", source: "global" })).toMatchObject({ scope: "saved" });
    expect(of({ effort: "medium", source: "global" }).detail).toBeUndefined();
    expect(of({ effort: "off", source: "default" })).toMatchObject({ scope: "saved", detail: "default" });
  });

  test("reasoning display: one button per mode", () => {
    const think = rowOf(buildSettingsRows({ ...BASE, thinkDisplay: "hide" }), "think");
    expect(think.actions.map((a) => [a.label, a.command, a.active])).toEqual(
      THINK_DISPLAY_MODES.map((mode) => [mode, `/think ${mode}`, mode === "hide"]),
    );
  });

  test("theme: Auto plus the neighbours in the theme list, wrapping at both ends", () => {
    const first = THEME_IDS[0]!;
    const last = THEME_IDS[THEME_IDS.length - 1]!;
    const second = THEME_IDS[1]!;
    const atFirst = rowOf(buildSettingsRows({ ...BASE, theme: first }), "theme");
    expect(atFirst.actions.map((a) => a.label)).toEqual(["Auto", "Prev", "Next"]);
    expect(atFirst.actions[1]!.command).toBe(`/theme ${last}`);
    expect(atFirst.actions[2]!.command).toBe(`/theme ${second}`);
    const atLast = rowOf(buildSettingsRows({ ...BASE, theme: last }), "theme");
    expect(atLast.actions[2]!.command).toBe(`/theme ${first}`);
    expect(rowOf(rows, "theme").actions[0]).toEqual({ label: "Auto", command: "/theme auto", active: true, confirm: false });
  });

  test("external providers: a project override is named, the default is flagged", () => {
    expect(rowOf(buildSettingsRows({ ...BASE, externalPrivacy: { value: "off", source: "project" } }), "external").detail).toBe(
      "this project overrides the per-user setting",
    );
    expect(rowOf(buildSettingsRows({ ...BASE, externalPrivacy: { value: "on", source: "default" } }), "external").detail).toBe(
      "default",
    );
    expect(rowOf(rows, "external").detail).toBeUndefined();
  });

  test("external agents: the reason it is off shows, an enabled runtime shows none", () => {
    expect(rowOf(rows, "external-agents").detail).toBe("not enabled");
    expect(rowOf(buildSettingsRows({ ...BASE, externalAgents: { on: true } }), "external-agents").detail).toBeUndefined();
  });

  test("edit guard says it is per project", () => {
    expect(rowOf(rows, "editguard").detail).toBe("this project");
  });

  test("the Jev profile has no single value, so it is read-only and names the command to run", () => {
    const jev = rowOf(rows, "jevprofile");
    expect(jev.actions).toEqual([]);
    expect(jev.usage).toBe("/jevprofile");
    expect(jev.value).toBe("3 of 9 keys on");
    expect(rowOf(buildSettingsRows({ ...BASE, jevProfile: { on: 9, total: 9 } }), "jevprofile").value).toBe("9 of 9 keys on");
  });
});

describe("formatSettingsTable", () => {
  const table = formatSettingsTable(buildSettingsRows(BASE));

  test("prints every group once, with its rows under it", () => {
    const lines = table.split("\n");
    for (const group of SETTING_GROUPS) expect(lines.filter((line) => line === group)).toHaveLength(1);
    expect(table).toContain("Permission mode");
    expect(table).toContain("[session]");
    expect(table).toContain("[saved]");
    expect(table).toContain("/mode [ask|trust|auto]");
    expect(table.endsWith("\n")).toBe(true);
  });

  test("shows the detail in brackets and the read-only row's command", () => {
    expect(table).toContain("(this project)");
    expect(table).not.toContain("(TUI only)");
    const jevLine = table.split("\n").find((line) => line.includes("Jev review profile"))!;
    expect(jevLine).toContain("3 of 9 keys on");
    expect(jevLine).toContain("/jevprofile");
  });

  test("marks the rows whose command the surface lacks as TUI only", () => {
    const readline = formatSettingsTable(buildSettingsRows(BASE), { available: new Set(["/mode", "/plan", "/reasoning", "/theme"]) });
    const line = (label: string): string => readline.split("\n").find((l) => l.includes(label))!;
    expect(line("Permission mode")).not.toContain("(TUI only)");
    expect(line("Theme")).not.toContain("(TUI only)");
    expect(line("Turn guard")).toContain("(TUI only)");
    expect(line("Reasoning display")).toContain("(TUI only)");
    expect(line("External agents")).toContain("(TUI only)");
  });

  test("aligns the value column across rows", () => {
    const rowsText = table.split("\n").filter((line) => line.startsWith("  "));
    const cols = new Set(rowsText.map((line) => line.indexOf("[s")));
    expect(cols.size).toBe(1);
  });
});
