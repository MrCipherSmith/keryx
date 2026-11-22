import assert from "node:assert/strict";
import { registerDom, unregisterDom } from "./dom";

registerDom();
const { mockIPC, clearMocks } = await import("@tauri-apps/api/mocks");
type State = { state: string; ownership?: string; reason?: string; activeSessions?: number };
let status: State = { state: "not_configured" };
let nextStatus: Promise<State> | null = null;
let nextStart: Promise<State> | null = null;
const calls: Array<{ command: string; args: unknown }> = [];
mockIPC((command, args) => {
  calls.push({ command, args });
  if (command === "settings_get") return { keryxSource: "auto", customPath: null, recentProjects: [] };
  if (command === "telegram_serve_status") { const result = nextStatus ?? status; nextStatus = null; return result; }
  if (command === "telegram_serve_start") { const result = nextStart ?? status; nextStart = null; return result; }
  if (command === "telegram_serve_stop") { status = { state: "stopped" }; return status; }
  if (command === "telegram_serve_restart") return status;
  throw new Error(`Unexpected command ${command}`);
});
const React = await import("react");
const { createRoot } = await import("react-dom/client");
const { TelegramServeSettings } = await import("../project/TelegramServeSettings");
const { SettingsView } = await import("../shell/SettingsView");
const { telegramServeStatus } = await import("../platform/commands");
const { act } = React;
const host = document.body.appendChild(document.createElement("div"));
const root = createRoot(host);
async function mount(next: State) {
  status = next;
  await act(() => root.render(null));
  await act(async () => { root.render(<TelegramServeSettings />); });
  await act(async () => { await telegramServeStatus(); });
}
function button(label: string): HTMLButtonElement | undefined {
  return [...host.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent?.trim() === label);
}
try {
  await mount({ state: "not_configured" });
  assert.ok(button("Set up and start"));
  await mount({ state: "needs_setup" });
  assert.ok(button("Complete setup and start"));
  assert.equal(calls.filter(({ command }) => command === "telegram_serve_start").length, 0);
  await act(async () => { button("Complete setup and start")?.click(); });
  assert.deepEqual(calls.filter(({ command }) => command === "telegram_serve_start").at(-1)?.args, { completeSetup: true });
  status = { state: "stopped" };
  await act(async () => { button("Refresh")?.click(); await telegramServeStatus(); });
  assert.ok(button("Complete setup and start"), "polling must not discard pending setup consent");
  await mount({ state: "running", ownership: "external" });
  assert.match(host.textContent ?? "", /external/i);
  assert.equal(button("Stop"), undefined);
  assert.equal(button("Restart"), undefined);
  await mount({ state: "failed", ownership: "desktop", reason: "Startup timed out" });
  assert.ok(button("Stop"));
  assert.match(host.textContent ?? "", /may interrupt/i);
  await act(async () => { button("Stop")?.click(); });
  assert.equal(calls.filter(({ command }) => command === "telegram_serve_stop").length, 0);
  await act(async () => { button("Stop service")?.click(); });
  assert.equal(calls.filter(({ command }) => command === "telegram_serve_stop").length, 1);

  await mount({ state: "running", ownership: "desktop", activeSessions: 0 });
  status = { state: "running", ownership: "desktop", activeSessions: 1 };
  await act(async () => { button("Stop")?.click(); });
  assert.equal(calls.filter(({ command }) => command === "telegram_serve_stop").length, 1);
  assert.ok(host.querySelector('[role="dialog"]'));
  await act(async () => { button("Stop service")?.click(); });
  assert.equal(calls.filter(({ command }) => command === "telegram_serve_stop").length, 2);
  assert.equal(host.querySelector('[role="dialog"]'), null);
  await mount({ state: "running", ownership: "desktop", activeSessions: 2 });
  await act(() => button("Restart")?.click());
  assert.match(host.textContent ?? "", /interrupt/i);
  assert.equal(calls.filter(({ command }) => command === "telegram_serve_restart").length, 0);
  await act(async () => { button("Restart service")?.click(); });
  assert.equal(calls.filter(({ command }) => command === "telegram_serve_restart").length, 1);

  await act(() => root.render(null));
  const beforeHidden = calls.filter(({ command }) => command === "telegram_serve_status").length;
  await act(async () => { root.render(<SettingsView integrations={<p>GitHub</p>} telegramIntegration={<TelegramServeSettings />} />); });
  assert.equal(calls.filter(({ command }) => command === "telegram_serve_status").length, beforeHidden);
  const integrationTab = [...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((el) => el.textContent === "Integrations");
  await act(async () => { integrationTab?.click(); await telegramServeStatus(); });
  assert.ok(calls.filter(({ command }) => command === "telegram_serve_status").length > beforeHidden);
  const appearanceTab = [...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((el) => el.textContent === "Appearance");
  await act(() => appearanceTab?.click());
  assert.equal(host.querySelector('#telegram-service-title'), null);

  await mount({ state: "not_configured" });
  let resolveOld: (value: State) => void = () => {};
  nextStatus = new Promise<State>((resolve) => { resolveOld = resolve; });
  await act(() => button("Refresh")?.click());
  status = { state: "running", ownership: "desktop" };
  await act(async () => { button("Set up and start")?.click(); });
  await act(async () => { resolveOld({ state: "not_configured" }); });
  assert.match(host.textContent ?? "", /Running · Desktop managed/);

  await mount({ state: "not_configured" });
  let resolveStart: (value: State) => void = () => {};
  nextStart = new Promise<State>((resolve) => { resolveStart = resolve; });
  const startsBefore = calls.filter(({ command }) => command === "telegram_serve_start").length;
  await act(() => button("Set up and start")?.click());
  assert.ok(button("Set up and start")?.disabled);
  await act(() => button("Set up and start")?.click());
  assert.equal(calls.filter(({ command }) => command === "telegram_serve_start").length, startsBefore + 1);
  await act(() => root.render(null));
  await act(async () => { resolveStart({ state: "running", ownership: "desktop" }); });
  await mount({ state: "stopped" });
  assert.match(host.textContent ?? "", /Stopped/);
} finally {
  await act(() => root.unmount());
  clearMocks();
  await unregisterDom();
}
