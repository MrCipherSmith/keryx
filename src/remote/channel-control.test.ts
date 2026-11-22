import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ChannelControl } from "./channel-control";
import { stageChannelToken } from "./channel-staging";
import { FakeBotApi } from "./fake-bot-api";

function request(body: object): Request { return new Request("http://localhost", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); }
test("staged pairing uses an owned revision and cannot activate while gated", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "channel-control-"));
  const api = new FakeBotApi();
  const control = new ChannelControl({ dir, hasActiveHub: () => false, openCandidate: () => api, pairing: { code: "ABCDEFGH", pollTimeoutSec: 0 } });
  try {
    const staged = stageChannelToken("123456:abcdefghijklmnopqrstuv", dir);
    if (!staged.ok) throw new Error("staging failed");
    const response = await control.handle(request({ version: 1, action: "begin", expectedRevision: null, stagingId: staged.value }));
    expect(response.status).toBe(200);
    const result = await response.json() as { operationId: string; pairing: { code: string } };
    expect(result.pairing.code).toBe("ABCDEFGH");
    expect((await control.handle(request({ version: 1, action: "status", expectedRevision: 1, operationId: result.operationId }))).status).toBe(409);
    expect((await control.handle(request({ version: 1, action: "confirm", expectedRevision: null, operationId: result.operationId }))).status).toBe(503);
    expect((await control.handle(request({ version: 1, action: "cancel", expectedRevision: null, operationId: result.operationId }))).status).toBe(200);
    expect((await control.handle(request({ version: 1, action: "status", expectedRevision: null, operationId: result.operationId }))).status).toBe(409);
  } finally { await control.stop(); rmSync(dir, { recursive: true, force: true }); }
});

test("same-bot preparation does not start another poller", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "channel-same-bot-"));
  const api = new FakeBotApi({ botId: 123456, chatId: -42 });
  const control = new ChannelControl({ dir, hasActiveHub: () => true, openCandidate: () => api });
  try {
    const { commitChannelRecord } = await import("./channel-record");
    const token = "123456:abcdefghijklmnopqrstuv";
    const config = { schemaVersion: 1 as const, chatId: -42, allowedUserIds: [12], orphanMs: 1234, runTimeoutMs: 0, permissionMode: "ask" as const, approvalTimeoutMs: 30000 };
    expect((await commitChannelRecord(null, { token, bot: { id: 123456 }, config }, dir)).ok).toBe(true);
    const staged = stageChannelToken(token, dir);
    if (!staged.ok) throw new Error("staging failed");
    const response = await control.handle(request({ version: 1, action: "begin", expectedRevision: 1, stagingId: staged.value }));
    expect(response.status).toBe(200);
    expect((await response.json() as { state: string }).state).toBe("same-bot-ready");
    expect(api.activePollers()).toBe(0);
  } finally { await control.stop(); rmSync(dir, { recursive: true, force: true }); }
});

test("a distinct verified bot pairs in isolation without interrupting the active bot", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "channel-distinct-"));
  const api = new FakeBotApi({ botId: 987654 });
  const control = new ChannelControl({ dir, hasActiveHub: () => true, openCandidate: () => api, pairing: { code: "ABCD2345", pollTimeoutSec: 0 } });
  try {
    const { commitChannelRecord, loadChannelRecord } = await import("./channel-record");
    const token = "123456:abcdefghijklmnopqrstuv";
    const config = { schemaVersion: 1 as const, chatId: -42, allowedUserIds: [12], orphanMs: 1234, runTimeoutMs: 0, permissionMode: "ask" as const, approvalTimeoutMs: 30000 };
    expect((await commitChannelRecord(null, { token, bot: { id: 123456 }, config }, dir)).ok).toBe(true);
    const staged = stageChannelToken("987654:zyxwvutsrqponmlkjihgfe", dir);
    if (!staged.ok) throw new Error("staging failed");
    const response = await control.handle(request({ version: 1, action: "begin", expectedRevision: 1, stagingId: staged.value }));
    expect(response.status).toBe(200);
    const result = await response.json() as { operationId: string; pairing: { code: string } };
    expect(result.pairing.code).toBe("ABCD2345");
    api.pushPrivateMessage({ fromId: 42, text: "/start ABCD2345" });
    const { until } = await import("./remote.test-helpers");
    const status = () => control.handle(request({ version: 1, action: "status", expectedRevision: 1, operationId: result.operationId }));
    await until(async () => (await (await status()).json() as { pairing: { state: string } }).pairing.state === "waiting-for-confirmation", "candidate pairing claim");
    const current = loadChannelRecord(dir);
    expect(current.ok && current.value?.revision).toBe(1);
    expect(current.ok && current.value?.state === "connected" && current.value.bot?.id).toBe(123456);
  } finally { await control.stop(); rmSync(dir, { recursive: true, force: true }); }
});

test("account claim must be confirmed before group events are accepted", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "channel-confirm-"));
  const api = new FakeBotApi();
  const control = new ChannelControl({ dir, hasActiveHub: () => false, openCandidate: () => api, pairing: { code: "ABCD2345", pollTimeoutSec: 0, pollSleep: async () => { await new Promise((resolve) => setTimeout(resolve, 1)); } } });
  try {
    const staged = stageChannelToken("123456:abcdefghijklmnopqrstuv", dir);
    if (!staged.ok) throw new Error("staging failed");
    const begun = await control.handle(request({ version: 1, action: "begin", expectedRevision: null, stagingId: staged.value }));
    const { operationId } = await begun.json() as { operationId: string };
    const status = () => control.handle(request({ version: 1, action: "status", expectedRevision: null, operationId }));
    const { until, settle } = await import("./remote.test-helpers");
    api.pushPrivateMessage({ fromId: 42, text: "/start ABCD2345" });
    await until(async () => (await (await status()).json() as { pairing: { state: string } }).pairing.state === "waiting-for-confirmation", "account claim");
    api.pushMyChatMember({ fromId: 42 });
    await settle();
    const before = await (await status()).json() as { pairing: { state: string; code?: string; userId: number } };
    expect(before.pairing).toMatchObject({ state: "waiting-for-confirmation", userId: 42 });
    expect(before.pairing.code).toBeUndefined();
    expect(api.callCount("getChat", "default")).toBe(0);
    expect((await control.handle(request({ version: 1, action: "confirm-account", expectedRevision: null, operationId }))).status).toBe(200);
    expect((await (await status()).json() as { pairing: { state: string } }).pairing.state).toBe("waiting-for-group");
  } finally { await control.stop(); rmSync(dir, { recursive: true, force: true }); }
});

test("legacy migration wins against a stale revisioned begin", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "channel-migrate-race-"));
  const api = new FakeBotApi();
  const control = new ChannelControl({ dir, hasActiveHub: () => false, openCandidate: () => api });
  try {
    const { saveBotToken, saveRemoteConfig } = await import("./config");
    const { migrateLegacyChannelRecord, loadChannelRecord } = await import("./channel-record");
    expect(saveBotToken("123456:abcdefghijklmnopqrstuv", dir).ok).toBe(true);
    expect(saveRemoteConfig({ schemaVersion: 1, chatId: -42, allowedUserIds: [12], orphanMs: 1234, runTimeoutMs: 0, permissionMode: "ask", approvalTimeoutMs: 30000, rendering: "plain" }, dir).ok).toBe(true);
    const staged = stageChannelToken("987654:zyxwvutsrqponmlkjihgfe", dir);
    if (!staged.ok) throw new Error("staging failed");
    const [migration, begin] = await Promise.all([migrateLegacyChannelRecord(dir), control.handle(request({ version: 1, action: "begin", expectedRevision: null, stagingId: staged.value }))]);
    expect(migration.ok).toBe(true);
    expect(begin.status).toBe(409);
    const current = loadChannelRecord(dir);
    expect(current.ok && current.value?.revision).toBe(1);
    expect(current.ok && current.value?.state === "connected" && current.value.config).toMatchObject({ allowedUserIds: [12], permissionMode: "ask", rendering: "plain" });
  } finally { await control.stop(); rmSync(dir, { recursive: true, force: true }); }
});

test("same-bot preflight rejects lost forum rights before polling", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "channel-same-rights-"));
  const api = new FakeBotApi({ botId: 123456, chatId: -42 });
  api.setBotRights({ canManageTopics: false });
  const control = new ChannelControl({ dir, hasActiveHub: () => true, openCandidate: () => api });
  try {
    const { commitChannelRecord } = await import("./channel-record");
    const config = { schemaVersion: 1 as const, chatId: -42, allowedUserIds: [12], orphanMs: 1234, runTimeoutMs: 0, permissionMode: "ask" as const, approvalTimeoutMs: 30000 };
    expect((await commitChannelRecord(null, { token: "123456:abcdefghijklmnopqrstuv", bot: { id: 123456 }, config }, dir)).ok).toBe(true);
    const staged = stageChannelToken("123456:zyxwvutsrqponmlkjihgfe", dir);
    if (!staged.ok) throw new Error("staging failed");
    const response = await control.handle(request({ version: 1, action: "begin", expectedRevision: 1, stagingId: staged.value }));
    expect(response.status).toBe(422);
    expect(api.callCount("getUpdates", "default")).toBe(0);
  } finally { await control.stop(); rmSync(dir, { recursive: true, force: true }); }
});
