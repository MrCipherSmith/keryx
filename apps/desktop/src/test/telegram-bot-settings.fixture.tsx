import assert from "node:assert/strict";
import { registerDom, unregisterDom } from "./dom";
registerDom();
const { mockIPC, clearMocks } = await import("@tauri-apps/api/mocks");
let capability = false;
let pending = false;
const calls: Array<{ command: string; args: unknown }> = [];
let pairing: Record<string, unknown> = { state: "waiting-for-user", code: "ABCDEFGH", botUsername: "example_bot", expiresAt: Date.now() + 600_000, problems: [] };
const operationId = "00000000-0000-4000-8000-000000000001";
mockIPC((command, args) => {
  calls.push({ command, args });
  if (command === "telegram_channel_status") return { ok: true, value: { capabilities: capability ? { desktopTelegram: 1 } : {}, revision: null, ...(pending ? { pendingOperation: { operationId, revision: null } } : {}), telegram: { state: "not-connected", sessions: 0 } } };
  if (command === "telegram_channel_action") { pending = true; return { ok: true, value: { schemaVersion: "1", operationId, revision: null, pairing } }; }
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
  capability = true;
  await mount();
  const input = host.querySelector<HTMLInputElement>('input[type="password"]');
  assert.ok(input);
  await act(() => { input.value = "test-token"; input.dispatchEvent(new Event("input", { bubbles: true })); });
  await act(async () => { button("Connect bot")?.click(); });
  assert.equal(input.value, "");
  assert.ok(host.querySelector('svg[aria-label="Pairing QR code"]'));
  assert.match(host.textContent ?? "", /ABCDEFGH/);
  pairing = { state: "ready", userId: 42, chatId: -100, chatTitle: "Forum", expiresAt: Date.now() + 600_000, problems: [] };
  await act(async () => { button("Check pairing")?.click(); });
  assert.equal(host.querySelector('svg[aria-label="Pairing QR code"]'), null);
  assert.equal(button("Confirm connection"), undefined);
  await act(() => button("This is my account")?.click());
  assert.ok(button("Confirm connection"));
} finally { await act(() => root.unmount()); clearMocks(); await unregisterDom(); }
