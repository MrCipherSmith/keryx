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
  const api = new FakeBotApi({ botId: 123456 });
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
    await until(async () => (await (await status()).json() as { pairing: { state: string } }).pairing.state === "waiting-for-group", "candidate pairing claim");
    const current = loadChannelRecord(dir);
    expect(current.ok && current.value?.revision).toBe(1);
    expect(current.ok && current.value?.state === "connected" && current.value.bot?.id).toBe(123456);
  } finally { await control.stop(); rmSync(dir, { recursive: true, force: true }); }
});
