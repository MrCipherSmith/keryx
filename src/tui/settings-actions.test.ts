// Flow 374: which handler each `/settings` button reaches, and when the modal may open.
// `runSettingsCommand` is the shell's own dispatcher, run here against recording handlers;
// the modal drives it the way the shell wires it.

import { expect, test } from "bun:test";
import { getProjectPermissionMode } from "../lib/permission-mode-config";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSettingsCommand, settingsOpenDecision, type SettingsActionHandlers } from "./settings-actions";
import { buildSettingsRows, type SettingRow, type SettingsSnapshot } from "./settings-model";
import { CONFIRM_MIN_GAP_MS, openSettings } from "./settings-modal";
import { clickNode, findById, keypressSource, loadOpenTui, mountChrome, settle } from "./ops-sidebar.test-helpers";

const OTUI = await loadOpenTui();
const otuiTest = test.skipIf(OTUI === undefined);

const STATE: SettingsSnapshot = {
  permissionMode: "ask",
  plan: false,
  guard: false,
  editGuard: false,
  routing: false,
  externalPrivacy: { value: "on", source: "user" },
  reasoning: { effort: "off", source: "global" },
  thinkDisplay: "auto",
  theme: "auto",
  jevProfile: { on: 0, total: 9 },
  externalAgents: { on: false, reason: "not enabled" },
  rendering: { mode: "auto", saveable: true },
};

function recorder(overrides: Partial<SettingsActionHandlers> = {}) {
  const calls: string[] = [];
  const system: string[] = [];
  const handlers: SettingsActionHandlers = {
    mode: (line) => void calls.push(`mode:${line}`),
    commitMode: (mode) => void calls.push(`commit:${mode}`),
    plan: (line) => void calls.push(`plan:${line}`),
    guard: (on) => void calls.push(`guard:${on}`),
    editGuard: async (on) => void calls.push(`editguard:${on}`),
    route: (on) => void calls.push(`route:${on}`),
    external: async (value) => void calls.push(`external:${value}`),
    externalAgents: async (arg) => {
      calls.push(`external-agents:${arg}`);
      return "External agents: enabled\n";
    },
    rendering: (arg) => {
      calls.push(`rendering:${arg}`);
      return "Telegram rendering: ok\n";
    },
    reasoning: (arg) => void calls.push(`reasoning:${arg}`),
    think: (arg) => void calls.push(`think:${arg}`),
    theme: (arg) => void calls.push(`theme:${arg}`),
    onSystem: (text) => void system.push(text),
    ...overrides,
  };
  return { calls, system, handlers };
}

test("every line the rows can produce reaches exactly one handler", async () => {
  const r = recorder();
  const lines = buildSettingsRows(STATE).flatMap((row) => row.actions.map((a) => a.command));
  for (const line of lines) await runSettingsCommand(line, r.handlers);
  expect(r.calls).toContain("mode:/mode ask");
  expect(r.calls).toContain("mode:/mode trust");
  expect(r.calls).toContain("commit:auto");
  expect(r.calls).toContain("plan:/plan on");
  expect(r.calls).toContain("guard:true");
  expect(r.calls).toContain("editguard:false");
  expect(r.calls).toContain("route:false");
  expect(r.calls).toContain("external:on");
  expect(r.calls).toContain("external-agents:on");
  expect(r.calls).toContain("reasoning:high");
  for (const mode of ["auto", "rich", "html", "plain"]) expect(r.calls).toContain(`rendering:${mode}`);
  expect(r.calls).toContain("think:hide");
  expect(r.calls).toContain("theme:auto");
  // One handler per line: nothing ran twice.
  expect(r.calls).toHaveLength(lines.length);
});

test("/mode auto is committed without /mode's own dialog; every other mode goes through the command", async () => {
  const r = recorder();
  await runSettingsCommand("/mode auto", r.handlers);
  expect(r.calls).toEqual(["commit:auto"]);
  await runSettingsCommand("/mode trust", r.handlers);
  await runSettingsCommand("/mode ask", r.handlers);
  expect(r.calls).toEqual(["commit:auto", "mode:/mode trust", "mode:/mode ask"]);
});

test("the mode and plan rows never carry a line that writes the project's permission-mode default", () => {
  const rows = buildSettingsRows({ ...STATE, projectPermissionMode: "trust" });
  for (const id of ["mode", "plan"]) {
    const row = rows.find((candidate) => candidate.id === id)!;
    for (const action of row.actions) expect(action.command).not.toMatch(/\b(save|clear)\b/);
  }
});

test("pressing mode and plan buttons leaves the project's permission-mode default untouched on disk", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "settings-actions-cwd-"));
  const configDir = mkdtempSync(join(tmpdir(), "settings-actions-cfg-"));
  try {
    const r = recorder();
    for (const row of buildSettingsRows(STATE).filter((candidate) => candidate.id === "mode" || candidate.id === "plan")) {
      for (const action of row.actions) await runSettingsCommand(action.command, r.handlers);
    }
    // The only writer of that default is `/mode <m> save` / `/mode clear`; none was issued.
    expect(r.calls.filter((call) => /save|clear/.test(call))).toEqual([]);
    expect(getProjectPermissionMode(cwd, configDir)).toBeUndefined();
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(configDir, { recursive: true, force: true });
  }
});

test("/external runs for both values, including when the project overrides (the handler reports the override)", async () => {
  const r = recorder({
    external: async (value) => {
      r.calls.push(`external:${value}`);
      r.handlers.onSystem(`External: on (this project overrides the per-user setting)\n`);
    },
  });
  await runSettingsCommand("/external off", r.handlers);
  expect(r.calls).toEqual(["external:off"]);
  expect(r.system).toEqual(["External: on (this project overrides the per-user setting)\n"]);
  // The row says the same, so the operator sees it before pressing.
  const row = buildSettingsRows({ ...STATE, externalPrivacy: { value: "on", source: "project" } }).find((x) => x.id === "external")!;
  expect(row.detail).toBe("this project overrides the per-user setting");
});

test("/external-agents prints the command's own text", async () => {
  const r = recorder();
  await runSettingsCommand("/external-agents on", r.handlers);
  expect(r.system).toEqual(["External agents: enabled\n"]);
});

test("/rendering prints the command's own text (flow 395)", async () => {
  const r = recorder();
  await runSettingsCommand("/rendering rich", r.handlers);
  expect(r.calls).toEqual(["rendering:rich"]);
  expect(r.system).toEqual(["Telegram rendering: ok\n"]);
});

test("a rejecting handler is reported through onSystem and never escapes", async () => {
  const r = recorder({
    externalAgents: async () => {
      throw new Error("no runtime");
    },
    editGuard: async () => {
      throw new Error("read-only file system");
    },
    guard: () => {
      throw new Error("config locked");
    },
  });
  await runSettingsCommand("/external-agents on", r.handlers);
  await runSettingsCommand("/editguard on", r.handlers);
  await runSettingsCommand("/guard on", r.handlers);
  expect(r.system).toEqual(["/external-agents: no runtime\n", "/editguard: read-only file system\n", "/guard: config locked\n"]);
});

test("every Telegram button reaches /remote-policy with its own arguments, and the text it returns is shown", async () => {
  const seen: string[] = [];
  const r = recorder({
    remotePolicy: (arg) => {
      seen.push(arg);
      return `policy: ${arg}\n`;
    },
  });
  const connected: SettingsSnapshot = {
    ...STATE,
    telegram: { posture: { defaultMode: "trust", runTimeoutMs: 0, approvalTimeoutMs: 900_000, savedRules: 0 } },
  };
  const lines = buildSettingsRows(connected)
    .filter((row) => row.group === "Telegram")
    .flatMap((row) => row.actions.map((a) => a.command));
  expect(lines.length).toBeGreaterThan(0);
  for (const line of lines) await runSettingsCommand(line, r.handlers);
  expect(seen).toEqual(lines.map((line) => line.replace("/remote-policy ", "")));
  expect(r.system).toEqual(seen.map((arg) => `policy: ${arg}\n`));
  expect(r.calls).toEqual([]);
});

test("a Telegram button never touches the shell's mode handlers", async () => {
  const r = recorder({ remotePolicy: () => "ok\n" });
  await runSettingsCommand("/remote-policy mode ask", r.handlers);
  await runSettingsCommand("/remote-policy mode trust", r.handlers);
  expect(r.calls.filter((call) => call.startsWith("mode:") || call.startsWith("commit:"))).toEqual([]);
});

test("/remote-policy without a handler (readline-less surfaces) does nothing and does not throw", async () => {
  const r = recorder();
  await runSettingsCommand("/remote-policy mode ask", r.handlers);
  expect(r.system).toEqual([]);
});

test("an unknown line does nothing", async () => {
  const r = recorder();
  await runSettingsCommand("/nope x", r.handlers);
  expect(r.calls).toEqual([]);
  expect(r.system).toEqual([]);
});

test("settingsOpenDecision: an open overlay refuses silently, a busy turn refuses with a message, otherwise it opens", () => {
  expect(settingsOpenDecision({ overlayActive: false, busy: false })).toEqual({ open: true });
  expect(settingsOpenDecision({ overlayActive: true, busy: false })).toEqual({ open: false });
  expect(settingsOpenDecision({ overlayActive: true, busy: true })).toEqual({ open: false });
  const busy = settingsOpenDecision({ overlayActive: false, busy: true });
  expect(busy.open).toBe(false);
  expect(busy.open === false ? busy.message : undefined).toContain("/settings");
});

// The modal and the shell's dispatcher together: what the operator's key presses reach.
function wired(): { calls: string[]; rows: () => SettingRow[] } {
  const r = recorder();
  return { calls: r.calls, rows: () => buildSettingsRows(STATE) };
}

otuiTest("the dialog-skipping /mode auto path is reached only by the confirmed second Enter", async () => {
  const otui = OTUI!;
  const h = await mountChrome(otui, { height: 50 });
  const r = recorder();
  let clock = 1000;
  const modal = openSettings(otui.core, h.chrome, {
    rows: wired().rows(),
    load: async () => buildSettingsRows(STATE),
    run: (command) => runSettingsCommand(command, r.handlers),
    renderer: h.renderer,
    onKeypress: keypressSource(h.renderer),
    now: () => clock,
  });
  try {
    await settle(h);
    await h.mockInput.pressKey("ARROW_RIGHT");
    await h.mockInput.pressKey("ARROW_RIGHT");
    await h.mockInput.pressEnter(); // arms
    await settle(h);
    expect(r.calls).toEqual([]);
    clock += CONFIRM_MIN_GAP_MS - 1;
    await h.mockInput.pressEnter(); // too fast: auto-repeat
    await settle(h);
    expect(r.calls).toEqual([]);
    clock += 1;
    await h.mockInput.pressEnter(); // deliberate
    await settle(h);
    expect(r.calls).toEqual(["commit:auto"]);
  } finally {
    modal?.close();
    h.destroy();
  }
});

otuiTest("a non-auto mode press goes through the command's own handler, not the direct commit", async () => {
  const otui = OTUI!;
  const h = await mountChrome(otui, { height: 50 });
  const r = recorder();
  const modal = openSettings(otui.core, h.chrome, {
    rows: wired().rows(),
    load: async () => buildSettingsRows(STATE),
    run: (command) => runSettingsCommand(command, r.handlers),
    renderer: h.renderer,
    onKeypress: keypressSource(h.renderer),
  });
  try {
    await settle(h);
    await clickNode(h, findById(h.renderer.root, "st-mode-1"));
    await settle(h);
    expect(r.calls).toEqual(["mode:/mode trust"]);
  } finally {
    modal?.close();
    h.destroy();
  }
});
