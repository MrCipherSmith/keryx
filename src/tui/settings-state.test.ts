// Flow 374: the read side of `/settings`. Every setting is read from the place its
// own command reads it, against a temp project directory and a temp config dir so
// nothing of the operator's own configuration leaks in or out.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeProjectExternalSetting } from "../lib/external-switch";
import { setProjectPermissionMode } from "../lib/permission-mode-config";
import { saveShellConfig } from "../lib/shell-config";
import { saveRemoteConfig } from "../remote/config";
import { testConfig } from "../remote/remote.test-helpers";
import { writeJevEditGuardEnabled } from "../review/jev-edit-guard-config";
import { loadSettingsSnapshot } from "./settings-state";

let cwd: string;
let configDir: string;
let savedEffort: string | undefined;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "settings-state-cwd-"));
  configDir = mkdtempSync(join(tmpdir(), "settings-state-cfg-"));
  savedEffort = process.env.KERYX_REASONING_EFFORT;
  delete process.env.KERYX_REASONING_EFFORT;
});

afterEach(() => {
  if (savedEffort === undefined) delete process.env.KERYX_REASONING_EFFORT;
  else process.env.KERYX_REASONING_EFFORT = savedEffort;
  rmSync(cwd, { recursive: true, force: true });
  rmSync(configDir, { recursive: true, force: true });
});

test("nothing saved: every setting reads as its default", async () => {
  const snapshot = await loadSettingsSnapshot(cwd, { permissionMode: "ask", plan: false }, configDir);
  expect(snapshot.permissionMode).toBe("ask");
  expect(snapshot.projectPermissionMode).toBeUndefined();
  expect(snapshot.plan).toBe(false);
  expect(snapshot.guard).toBe(false);
  expect(snapshot.editGuard).toBe(false);
  expect(snapshot.routing).toBe(false);
  expect(snapshot.reasoning).toEqual({ effort: "off", source: "default" });
  expect(snapshot.jevProfile.total).toBeGreaterThan(0);
});

test("saved guard, routing and reasoning are read from the shell config", async () => {
  saveShellConfig({ turnGuard: { enabled: true }, routingClassifier: { enabled: true }, reasoningEffort: "high" }, configDir);
  const snapshot = await loadSettingsSnapshot(cwd, { permissionMode: "ask", plan: false }, configDir);
  expect(snapshot.guard).toBe(true);
  expect(snapshot.routing).toBe(true);
  expect(snapshot.reasoning).toEqual({ effort: "high", source: "global" });
});

test("what the running session holds wins over what was saved", async () => {
  saveShellConfig({ turnGuard: { enabled: true }, routingClassifier: { enabled: true }, reasoningEffort: "high" }, configDir);
  const snapshot = await loadSettingsSnapshot(
    cwd,
    { permissionMode: "trust", plan: true, guard: false, routing: false, thinkDisplay: "hide", reasoningOverride: "low" },
    configDir,
  );
  expect(snapshot.permissionMode).toBe("trust");
  expect(snapshot.plan).toBe(true);
  expect(snapshot.guard).toBe(false);
  expect(snapshot.routing).toBe(false);
  expect(snapshot.thinkDisplay).toBe("hide");
  expect(snapshot.reasoning).toEqual({ effort: "low", source: "session" });
});

test("the environment's reasoning effort beats the saved one and is named as such", async () => {
  saveShellConfig({ reasoningEffort: "high" }, configDir);
  process.env.KERYX_REASONING_EFFORT = "medium";
  const snapshot = await loadSettingsSnapshot(cwd, { permissionMode: "ask", plan: false }, configDir);
  expect(snapshot.reasoning).toEqual({ effort: "medium", source: "env" });
});

test("the project's permission mode default is reported next to the session's", async () => {
  setProjectPermissionMode(cwd, "trust", configDir);
  const snapshot = await loadSettingsSnapshot(cwd, { permissionMode: "ask", plan: false }, configDir);
  expect(snapshot.permissionMode).toBe("ask");
  expect(snapshot.projectPermissionMode).toBe("trust");
});

test("the edit guard is read from the project", async () => {
  await writeJevEditGuardEnabled(cwd, true);
  const snapshot = await loadSettingsSnapshot(cwd, { permissionMode: "ask", plan: false }, configDir);
  expect(snapshot.editGuard).toBe(true);
});

test("a project's external-provider override is reported with its source", async () => {
  await writeProjectExternalSetting(cwd, "off");
  const snapshot = await loadSettingsSnapshot(cwd, { permissionMode: "ask", plan: false }, configDir);
  expect(snapshot.externalPrivacy).toEqual({ value: "off", source: "project" });
});

test("a session choice with the variable set is flagged: the variable wins again after a restart", async () => {
  saveShellConfig({ reasoningEffort: "high" }, configDir);
  process.env.KERYX_REASONING_EFFORT = "medium";
  const pinned = await loadSettingsSnapshot(cwd, { permissionMode: "ask", plan: false, reasoningOverride: "low" }, configDir);
  expect(pinned.reasoning).toEqual({ effort: "low", source: "session", envWinsOnRestart: true });
  delete process.env.KERYX_REASONING_EFFORT;
  const saved = await loadSettingsSnapshot(cwd, { permissionMode: "ask", plan: false, reasoningOverride: "low" }, configDir);
  expect(saved.reasoning).toEqual({ effort: "low", source: "session" });
});

// ---- flow 395: the Telegram rendering row reads the remote config ---------------------------

test("no remote config: rendering reads as auto and cannot be saved yet", async () => {
  const snapshot = await loadSettingsSnapshot(cwd, { permissionMode: "ask", plan: false }, configDir);
  expect(snapshot.rendering).toEqual({ mode: "auto", saveable: false });
});

test("a remote config without the key: auto, and saveable", async () => {
  saveRemoteConfig(testConfig(), configDir);
  const snapshot = await loadSettingsSnapshot(cwd, { permissionMode: "ask", plan: false }, configDir);
  expect(snapshot.rendering).toEqual({ mode: "auto", saveable: true });
});

test("a saved mode is what the row shows", async () => {
  saveRemoteConfig(testConfig({ rendering: "html" }), configDir);
  const snapshot = await loadSettingsSnapshot(cwd, { permissionMode: "ask", plan: false }, configDir);
  expect(snapshot.rendering).toEqual({ mode: "html", saveable: true });
});

function seedRemote(extra: Record<string, unknown> = {}): void {
  mkdirSync(join(configDir, "remote"), { recursive: true });
  writeFileSync(join(configDir, "remote", "config.json"), JSON.stringify({ schemaVersion: 1, chatId: -1001, allowedUserIds: [1], ...extra }), { mode: 0o600 });
}

test("flow 396: with no Telegram config the snapshot carries a telegram field without a posture (shown as not connected)", async () => {
  const snapshot = await loadSettingsSnapshot(cwd, { permissionMode: "ask", plan: false }, configDir);
  expect(snapshot.telegram).toEqual({});
});

test("flow 396: a saved config is read as the defaults when no shell holds its own copy", async () => {
  seedRemote({ permissionMode: "ask", runTimeoutMs: 1_800_000 });
  const snapshot = await loadSettingsSnapshot(cwd, { permissionMode: "trust", plan: false }, configDir);
  expect(snapshot.telegram?.posture).toMatchObject({ defaultMode: "ask", runTimeoutMs: 1_800_000, approvalTimeoutMs: 900_000, savedRules: 0 });
  expect(snapshot.telegram?.posture?.inForce).toBeUndefined();
});

test("flow 396: the running shell's copy and the mode in force with its source win over the file", async () => {
  seedRemote({ permissionMode: "ask" });
  const snapshot = await loadSettingsSnapshot(
    cwd,
    {
      permissionMode: "trust",
      plan: false,
      telegram: { defaultMode: "trust", runTimeoutMs: 0, approvalTimeoutMs: 120_000, inForce: "trust (Telegram default)" },
    },
    configDir,
  );
  expect(snapshot.telegram?.posture).toMatchObject({ defaultMode: "trust", approvalTimeoutMs: 120_000, inForce: "trust (Telegram default)" });
  // The shell's own mode row is not the Telegram default: they are separate rows.
  expect(snapshot.permissionMode).toBe("trust");
});
