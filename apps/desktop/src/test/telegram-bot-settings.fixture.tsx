import assert from "node:assert/strict";
import { registerDom, unregisterDom } from "./dom";
registerDom();
const { mockIPC, clearMocks } = await import("@tauri-apps/api/mocks");
let capability = false;
let pending = false;
let connected = false;
let nextError: string | null = null;
let copyFails = true;
let openFails = true;
const originalClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
Object.defineProperty(navigator, "clipboard", {
  configurable: true,
  value: { writeText: async () => {
    if (copyFails) throw new Error("Clipboard unavailable");
  } },
});
const calls: Array<{ command: string; args: unknown }> = [];
let pairing: Record<string, unknown> = { state: "waiting-for-user", code: "ABCDEFGH", botUsername: "example_bot", expiresAt: Date.now() + 600_000, problems: [] };
const operationId = "00000000-0000-4000-8000-000000000001";
function currentChannelStatus() {
  return { ok: true, value: { capabilities: capability ? { desktopTelegram: 1 } : {}, revision: connected ? 1 : null, ...(pending ? { pendingOperation: { operationId, revision: null } } : {}), telegram: { state: connected ? "connected" : "not-connected", sessions: 0 } } };
}
let nextStatus: Promise<ReturnType<typeof currentChannelStatus>> | undefined;
mockIPC((command, args) => {
  calls.push({ command, args });
  if (command === "plugin:opener|open_url") {
    if (openFails) throw new Error("Opener unavailable");
    return;
  }
  if (command === "telegram_channel_status") {
    const result = nextStatus ?? currentChannelStatus();
    nextStatus = undefined;
    return result;
  }
  if (command === "telegram_channel_action") {
    const request = (args as { request: { action: string } }).request;
    if (nextError) { const code = nextError; nextError = null; return { ok: false, code }; }
    if (request.action === "test") return { ok: true, value: { delivered: true } };
    if (request.action === "disconnect") { connected = false; return { ok: true, value: { deleted: 1, remaining: 0, revision: 2 } }; }
    if (request.action === "cancel") { pending = false; return { ok: true, value: { schemaVersion: "1", operationId, revision: null, state: "cancelled" } }; }
    if (request.action === "confirm-account") pairing = { state: "waiting-for-group", userId: 42, expiresAt: Date.now() + 600_000, problems: [] };
    pending = true;
    return { ok: true, value: { schemaVersion: "1", operationId, revision: null, pairing } };
  }
  throw new Error("Unexpected command");
});
const React = await import("react");
const { createRoot } = await import("react-dom/client");
const { TelegramBotSettings } = await import("../project/TelegramBotSettings");
const { telegramChannelStatus } = await import("../platform/telegramChannel");
const host = document.body.appendChild(document.createElement("div"));
const root = createRoot(host);
const { act } = React;
function button(label: string) { return [...host.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent?.trim() === label); }
async function mount() { await act(() => root.render(null)); await act(async () => { root.render(<TelegramBotSettings />); }); await act(async () => { await telegramChannelStatus(); }); }
try {
  await mount();
  assert.equal(host.querySelector('input[type="password"]'), null);
  const oldStatus = currentChannelStatus();
  let resolveStatus!: (value: typeof oldStatus) => void;
  nextStatus = new Promise((resolve) => { resolveStatus = resolve; });
  await act(() => button("Retry channel status")?.click());
  capability = true;
  await act(() => root.render(<TelegramBotSettings refreshKey={1} />));
  assert.equal(host.querySelector('input[type="password"]'), null);
  await act(async () => { resolveStatus(oldStatus); });
  const input = host.querySelector<HTMLInputElement>('input[type="password"]');
  assert.ok(input, "the service-triggered refresh must run after the stale response");
  await act(() => { input.value = "test-token"; input.dispatchEvent(new Event("input", { bubbles: true })); });
  await act(async () => { button("Connect bot")?.click(); });
  assert.equal(input.value, "");
  assert.ok(host.querySelector('svg[aria-label="Pairing QR code"]'));
  assert.match(host.textContent ?? "", /ABCDEFGH/);
  const copy = button("Copy code");
  const open = button("Open in Telegram");
  assert.ok(copy);
  assert.ok(open);
  await act(async () => { copy.click(); });
  assert.match(host.textContent ?? "", /Could not copy the code/);
  await act(async () => { open.click(); });
  assert.match(host.textContent ?? "", /Could not open Telegram/);
  assert.match(host.textContent ?? "", /Could not copy the code/);
  copyFails = false;
  await act(async () => { copy.click(); });
  assert.doesNotMatch(host.textContent ?? "", /Could not copy the code/);
  assert.match(host.textContent ?? "", /Could not open Telegram/);
  openFails = false;
  await act(async () => { open.click(); });
  assert.doesNotMatch(host.textContent ?? "", /Could not open Telegram/);
  await mount();
  assert.ok(host.querySelector('svg[aria-label="Pairing QR code"]'), "pending pairing resumes after reopening Settings");
  const beforeCheck = calls.filter(({ command }) => command === "telegram_channel_status").length;
  const pendingStatus = currentChannelStatus();
  let resolvePendingStatus!: (value: typeof pendingStatus) => void;
  nextStatus = new Promise((resolve) => { resolvePendingStatus = resolve; });
  await act(() => root.render(<TelegramBotSettings refreshKey={1} />));
  await act(async () => { button("Check pairing")?.click(); });
  assert.equal(calls.filter(({ command }) => command === "telegram_channel_status").length, beforeCheck + 1);
  await act(async () => { resolvePendingStatus(pendingStatus); });
  assert.equal(calls.filter(({ command }) => command === "telegram_channel_status").length, beforeCheck + 2);
  pairing = { state: "waiting-for-confirmation", userId: 42, expiresAt: Date.now() + 600_000, problems: [] };
  await act(async () => { button("Check pairing")?.click(); });
  assert.equal(host.querySelector('svg[aria-label="Pairing QR code"]'), null);
  assert.equal(button("Confirm connection"), undefined);
  await act(async () => { button("This is my account")?.click(); });
  const accountRequest = calls.find(({ command, args }) => command === "telegram_channel_action" && (args as { request: { action: string } }).request.action === "confirm-account");
  assert.deepEqual(accountRequest?.args, { request: { action: "confirm-account", operationId, expectedRevision: null } });
  pairing = { state: "ready", userId: 42, chatId: -100, chatTitle: "Forum", expiresAt: Date.now() + 600_000, problems: [] };
  await act(async () => { button("Check pairing")?.click(); });
  assert.ok(button("Confirm connection"));
  await act(async () => { button("Cancel pairing")?.click(); });
  assert.equal(host.querySelector('svg[aria-label="Pairing QR code"]'), null);
  connected = true;
  await mount();
  await act(async () => { button("Test connection")?.click(); });
  assert.match(host.textContent ?? "", /test message sent/i);
  const testRequest = calls.find(({ command, args }) => command === "telegram_channel_action" && (args as { request: { action: string } }).request.action === "test");
  assert.deepEqual(testRequest?.args, { request: { action: "test", expectedRevision: 1 } });
  await act(() => button("Disconnect")?.click());
  assert.match(host.textContent ?? "", /all.*topics/i);
  await act(async () => { button("Disconnect bot")?.click(); });
  const disconnectRequest = calls.find(({ command, args }) => command === "telegram_channel_action" && (args as { request: { action: string } }).request.action === "disconnect");
  assert.deepEqual(disconnectRequest?.args, { request: { action: "disconnect", expectedRevision: 1 } });
  pending = true;
  pairing = { state: "expired", code: "ABCDEFGH", expiresAt: 0, problems: [] };
  await mount();
  assert.equal(host.querySelector('svg[aria-label="Pairing QR code"]'), null);
  assert.doesNotMatch(host.textContent ?? "", /ABCDEFGH/);
  assert.match(host.textContent ?? "", /expired/i);
  await act(async () => { button("Cancel pairing")?.click(); });
  const retryInput = host.querySelector<HTMLInputElement>('input[type="password"]');
  assert.ok(retryInput);
  nextError = "conflict";
  await act(() => { retryInput.value = "test-token"; retryInput.dispatchEvent(new Event("input", { bubbles: true })); });
  await act(async () => { button("Connect bot")?.click(); });
  assert.equal(retryInput.value, "");
  assert.match(host.textContent ?? "", /channel changed/i);
  assert.doesNotMatch(host.textContent ?? "", /test-token/);
  nextError = "rejected";
  await act(() => { retryInput.value = "test-token"; retryInput.dispatchEvent(new Event("input", { bubbles: true })); });
  await act(async () => { button("Connect bot")?.click(); });
  assert.equal(retryInput.value, "");
  assert.match(host.textContent ?? "", /could not accept the bot token/i);
  await act(async () => { root.render(<TelegramBotSettings refreshKey={2} />); });
  assert.match(host.textContent ?? "", /could not accept the bot token/i);
} finally {
  await act(() => root.unmount());
  clearMocks();
  if (originalClipboard) Object.defineProperty(navigator, "clipboard", originalClipboard);
  else Reflect.deleteProperty(navigator, "clipboard");
  await unregisterDom();
}
