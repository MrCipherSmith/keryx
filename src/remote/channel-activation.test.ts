import { expect, test } from "bun:test";
import { makeRig } from "./remote.http.test-helpers";
import { stageChannelToken } from "./channel-staging";
import { loadChannelRecord } from "./channel-record";
import { BotApiError } from "./types";
import { createHttpBotApi } from "./bot-api-http";
import { FAKE_CHAT_ID, until } from "./remote.test-helpers";

const code = "ABCD2345";
function request(body: object): Request { return new Request("http://localhost", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); }
test("first setup commits only after candidate runtime readiness", async () => {
  const rig = makeRig({ configured: false });
  try {
    const identity = await rig.api.getMe();
    const http = createHttpBotApi({
      token: "fixture",
      fetchImpl: Object.assign(async () => Response.json({ ok: true, result: { ...identity, is_bot: true, first_name: "Fixture bot", can_join_groups: true } }), { preconnect: () => {} }),
    });
    rig.api.getMe = http.getMe;
    const serve = await rig.startServe({ service: { experimentalChannelControl: true, pairing: { code, pollTimeoutSec: 0 }, pollTimeoutSec: 0 } });
    const staged = stageChannelToken("123456:abcdefghijklmnopqrstuv", rig.dir);
    if (!staged.ok) throw new Error("staging failed");
    const call = (body: object) => serve.service.surface.handle("channels-control", request(body), { untimed: () => {} });
    const started = await call({ version: 1, action: "begin", expectedRevision: null, stagingId: staged.value });
    expect(started.status).toBe(200);
    const { operationId } = await started.json() as { operationId: string };
    const state = async () => (await (await call({ version: 1, action: "status", expectedRevision: null, operationId })).json() as { pairing: { state: string } }).pairing.state;
    rig.api.pushPrivateMessage({ fromId: 42, text: `/start ${code}` });
    await until(async () => await state() === "waiting-for-confirmation", "pairing claim");
    expect((await call({ version: 1, action: "confirm-account", expectedRevision: null, operationId })).status).toBe(200);
    rig.api.pushMyChatMember({ fromId: 42 });
    await until(async () => await state() === "ready", "pairing ready");
    expect(loadChannelRecord(rig.dir)).toEqual({ ok: true, value: null });
    const confirmed = await call({ version: 1, action: "confirm", expectedRevision: null, operationId });
    expect(confirmed.status).toBe(200);
    const record = loadChannelRecord(rig.dir);
    expect(record.ok && record.value?.state).toBe("connected");
    expect(record.ok && record.value?.state === "connected" && record.value.bot).toEqual(identity);
    expect(serve.service.hub()).toBeDefined();
  } finally { await rig.cleanup(); }
});

test("candidate poll failure leaves the committed record absent", async () => {
  const rig = makeRig({ configured: false });
  try {
    const serve = await rig.startServe({ service: { experimentalChannelControl: true, pairing: { code, pollTimeoutSec: 0 }, pollTimeoutSec: 0 } });
    const staged = stageChannelToken("123456:abcdefghijklmnopqrstuv", rig.dir);
    if (!staged.ok) throw new Error("staging failed");
    const call = (body: object) => serve.service.surface.handle("channels-control", request(body), { untimed: () => {} });
    const begun = await call({ version: 1, action: "begin", expectedRevision: null, stagingId: staged.value });
    const { operationId } = await begun.json() as { operationId: string };
    const state = async () => (await (await call({ version: 1, action: "status", expectedRevision: null, operationId })).json() as { pairing: { state: string } }).pairing.state;
    rig.api.pushPrivateMessage({ fromId: 42, text: code });
    await until(async () => await state() === "waiting-for-confirmation", "pairing claim");
    expect((await call({ version: 1, action: "confirm-account", expectedRevision: null, operationId })).status).toBe(200);
    rig.api.pushMyChatMember({ fromId: 42 });
    await until(async () => await state() === "ready", "pairing ready");
    rig.api.failNext("getUpdates", new BotApiError("network", "fixture failure"));
    expect((await call({ version: 1, action: "confirm", expectedRevision: null, operationId })).status).toBe(503);
    const status = await serve.service.surface.handle("channels-status", new Request("http://localhost"), { untimed: () => {} });
    const channel = await status.json();
    expect(channel.pendingOperation).toBeUndefined();
    expect(channel.lastActivationFailure).toEqual({ at: expect.any(Number), reason: "Candidate poller readiness could not be confirmed." });
    expect(loadChannelRecord(rig.dir)).toEqual({ ok: true, value: null });
    expect(serve.service.hub()).toBeUndefined();
  } finally { await rig.cleanup(); }
});

test("same-bot confirmation commits a new revision while preserving the live hub", async () => {
  const rig = makeRig({ configured: false });
  try {
    const { commitChannelRecord } = await import("./channel-record");
    const identity = await rig.api.getMe();
    const token = "123456:abcdefghijklmnopqrstuv";
    const config = { schemaVersion: 1 as const, chatId: FAKE_CHAT_ID, allowedUserIds: [42], orphanMs: 2345, runTimeoutMs: 0, permissionMode: "ask" as const, approvalTimeoutMs: 30000, rendering: "plain" as const };
    expect((await commitChannelRecord(null, { token, bot: identity, config }, rig.dir)).ok).toBe(true);
    const serve = await rig.startServe({ service: { experimentalChannelControl: true, pollTimeoutSec: 0 } });
    const original = serve.service.hub();
    expect(original).toBeDefined();
    let revoked = false;
    const client = rig.makeClient({ sessionId: "desktop-same-bot", project: "/project", owner: { kind: "desktop", incarnation: "owner1", generation: "gen1" }, onLine: () => {}, onChannelRevoked: () => { revoked = true; return true; } });
    expect((await client.start()).ok).toBe(true);
    const staged = stageChannelToken("123456:zyxwvutsrqponmlkjihgfe", rig.dir);
    if (!staged.ok) throw new Error("staging failed");
    const call = (body: object) => serve.service.surface.handle("channels-control", request(body), { untimed: () => {} });
    const begun = await call({ version: 1, action: "begin", expectedRevision: 1, stagingId: staged.value });
    expect(begun.status).toBe(200);
    const { operationId, state } = await begun.json() as { operationId: string; state: string };
    expect(state).toBe("same-bot-ready");
    const confirmed = await call({ version: 1, action: "confirm", expectedRevision: 1, operationId });
    expect(confirmed.status).toBe(200);
    expect(serve.service.hub()).toBe(original);
    expect(client.connected).toBe(true);
    expect(revoked).toBe(false);
    const record = loadChannelRecord(rig.dir);
    expect(record.ok && record.value?.revision).toBe(2);
    expect(record.ok && record.value?.state === "connected" && record.value.config).toEqual(config);
  } finally { await rig.cleanup(); }
});

test("distinct bot pairing leaves the active hub and committed channel running", async () => {
  const rig = makeRig({ configured: false });
  const { FakeBotApi } = await import("./fake-bot-api");
  const candidate = new FakeBotApi({ botId: 987654 });
  try {
    const { commitChannelRecord } = await import("./channel-record");
    const identity = await rig.api.getMe();
    const token = "123456:abcdefghijklmnopqrstuv";
    const config = { schemaVersion: 1 as const, chatId: -10012345, allowedUserIds: [42], orphanMs: 2345, runTimeoutMs: 0, permissionMode: "ask" as const, approvalTimeoutMs: 30000 };
    expect((await commitChannelRecord(null, { token, bot: identity, config }, rig.dir)).ok).toBe(true);
    const serve = await rig.startServe({ service: { experimentalChannelControl: true, candidateApi: () => candidate, pairing: { code, pollTimeoutSec: 0 }, pollTimeoutSec: 0 } });
    const original = serve.service.hub();
    const staged = stageChannelToken("987654:zyxwvutsrqponmlkjihgfe", rig.dir);
    if (!staged.ok) throw new Error("staging failed");
    const call = (body: object) => serve.service.surface.handle("channels-control", request(body), { untimed: () => {} });
    const started = await call({ version: 1, action: "begin", expectedRevision: 1, stagingId: staged.value });
    expect(started.status).toBe(200);
    const { operationId } = await started.json() as { operationId: string };
    candidate.pushPrivateMessage({ fromId: 42, text: code });
    const state = async () => (await (await call({ version: 1, action: "status", expectedRevision: 1, operationId })).json() as { pairing: { state: string } }).pairing.state;
    await until(async () => await state() === "waiting-for-confirmation", "candidate pairing claim");
    expect((await call({ version: 1, action: "confirm-account", expectedRevision: 1, operationId })).status).toBe(200);
    expect(serve.service.hub()).toBe(original);
    expect(original?.pollerStatus().state).toBe("running");
    const current = loadChannelRecord(rig.dir);
    expect(current.ok && current.value?.revision).toBe(1);
  } finally { await rig.cleanup(); }
});

test("signed status exposes the current revision and pending operation", async () => {
  const rig = makeRig({ configured: false });
  try {
    const serve = await rig.startServe({ service: { experimentalChannelControl: true, pairing: { code, pollTimeoutSec: 0 } } });
    const { shellRequestCredential, verifyServeResponseProof, SERVE_PROOF_HEADER } = await import("./shell-token");
    const status = async () => {
      const { bearer, nonce } = shellRequestCredential(serve.shellToken);
      const response = await fetch(`${serve.origin}/v1/remote/channels-status`, { headers: { authorization: `Bearer ${bearer}` } });
      const body = await response.text();
      expect(verifyServeResponseProof(serve.shellToken, nonce, "channels-status", response.status, body, response.headers.get(SERVE_PROOF_HEADER))).toBe(true);
      return JSON.parse(body) as { revision: number | null; pendingOperation?: { operationId: string; revision: number | null } };
    };
    expect((await status()).revision).toBeNull();
    const staged = stageChannelToken("123456:abcdefghijklmnopqrstuv", rig.dir);
    if (!staged.ok) throw new Error("staging failed");
    const begun = await serve.service.surface.handle("channels-control", request({ version: 1, action: "begin", expectedRevision: null, stagingId: staged.value }), { untimed: () => {} });
    const { operationId } = await begun.json() as { operationId: string };
    expect((await status()).pendingOperation).toEqual({ operationId, revision: null });
  } finally { await rig.cleanup(); }
});

test("a disconnected tombstone permits fresh pairing without importing legacy state", async () => {
  const rig = makeRig({ configured: false });
  try {
    const { disconnectChannelRecord } = await import("./channel-record");
    const { saveBotToken, saveRemoteConfig } = await import("./config");
    expect((await disconnectChannelRecord(null, rig.dir)).ok).toBe(true);
    expect(saveBotToken("123456:abcdefghijklmnopqrstuv", rig.dir).ok).toBe(true);
    expect(saveRemoteConfig({ schemaVersion: 1, chatId: -123, allowedUserIds: [99], orphanMs: 1234, runTimeoutMs: 0 }, rig.dir).ok).toBe(true);
    const serve = await rig.startServe({ service: { experimentalChannelControl: true, pairing: { code, pollTimeoutSec: 0 }, pollTimeoutSec: 0 } });
    expect(serve.service.hub()).toBeUndefined();
    const staged = stageChannelToken("123456:zyxwvutsrqponmlkjihgfe", rig.dir);
    if (!staged.ok) throw new Error("staging failed");
    const call = (body: object) => serve.service.surface.handle("channels-control", request(body), { untimed: () => {} });
    const begun = await call({ version: 1, action: "begin", expectedRevision: 1, stagingId: staged.value });
    const { operationId } = await begun.json() as { operationId: string };
    const state = async () => (await (await call({ version: 1, action: "status", expectedRevision: 1, operationId })).json() as { pairing: { state: string } }).pairing.state;
    rig.api.pushPrivateMessage({ fromId: 42, text: code });
    await until(async () => await state() === "waiting-for-confirmation", "pairing claim");
    expect((await call({ version: 1, action: "confirm-account", expectedRevision: 1, operationId })).status).toBe(200);
    rig.api.pushMyChatMember({ fromId: 42 });
    await until(async () => await state() === "ready", "pairing ready");
    const confirmed = await call({ version: 1, action: "confirm", expectedRevision: 1, operationId });
    expect(confirmed.status).toBe(200);
    const record = loadChannelRecord(rig.dir);
    expect(record.ok && record.value?.revision).toBe(2);
    expect(record.ok && record.value?.state === "connected" && record.value.config.allowedUserIds).toEqual([42]);
    expect(record.ok && record.value?.state === "connected" && record.value.bindingId).toMatch(/^[0-9a-f]{32}$/);
    await serve.stop();
    const restarted = await rig.startServe({ service: { experimentalChannelControl: true, pollTimeoutSec: 0 } });
    expect(restarted.service.hub()).toBeDefined();
    expect(restarted.service.hub()?.list()).toEqual([]);
  } finally { await rig.cleanup(); }
});

test("post-commit activation failure leaves a newer disconnected tombstone", async () => {
  const rig = makeRig({ configured: false });
  try {
    const serve = await rig.startServe({ service: { experimentalChannelControl: true, pairing: { code, pollTimeoutSec: 0 }, pollTimeoutSec: 0, afterCandidateCommit: async () => { throw new Error("fixture"); } } });
    const staged = stageChannelToken("123456:abcdefghijklmnopqrstuv", rig.dir);
    if (!staged.ok) throw new Error("staging failed");
    const call = (body: object) => serve.service.surface.handle("channels-control", request(body), { untimed: () => {} });
    const begun = await call({ version: 1, action: "begin", expectedRevision: null, stagingId: staged.value });
    const { operationId } = await begun.json() as { operationId: string };
    const state = async () => (await (await call({ version: 1, action: "status", expectedRevision: null, operationId })).json() as { pairing: { state: string } }).pairing.state;
    rig.api.pushPrivateMessage({ fromId: 42, text: code });
    await until(async () => await state() === "waiting-for-confirmation", "pairing claim");
    expect((await call({ version: 1, action: "confirm-account", expectedRevision: null, operationId })).status).toBe(200);
    rig.api.pushMyChatMember({ fromId: 42 });
    await until(async () => await state() === "ready", "pairing ready");
    expect((await call({ version: 1, action: "confirm", expectedRevision: null, operationId })).status).toBe(503);
    expect(loadChannelRecord(rig.dir)).toEqual({ ok: true, value: { schemaVersion: 1, revision: 2, state: "disconnected" } });
    expect(serve.service.hub()).toBeUndefined();
  } finally { await rig.cleanup(); }
});

test("post-commit recovery does not overwrite a newer channel revision", async () => {
  const rig = makeRig({ configured: false });
  try {
    const { disconnectChannelRecord } = await import("./channel-record");
    const serve = await rig.startServe({ service: { experimentalChannelControl: true, pairing: { code, pollTimeoutSec: 0 }, pollTimeoutSec: 0, afterCandidateCommit: async () => { await disconnectChannelRecord(1, rig.dir); throw new Error("fixture"); } } });
    const staged = stageChannelToken("123456:abcdefghijklmnopqrstuv", rig.dir);
    if (!staged.ok) throw new Error("staging failed");
    const call = (body: object) => serve.service.surface.handle("channels-control", request(body), { untimed: () => {} });
    const begun = await call({ version: 1, action: "begin", expectedRevision: null, stagingId: staged.value });
    const { operationId } = await begun.json() as { operationId: string };
    const state = async () => (await (await call({ version: 1, action: "status", expectedRevision: null, operationId })).json() as { pairing: { state: string } }).pairing.state;
    rig.api.pushPrivateMessage({ fromId: 42, text: code });
    await until(async () => await state() === "waiting-for-confirmation", "pairing claim");
    expect((await call({ version: 1, action: "confirm-account", expectedRevision: null, operationId })).status).toBe(200);
    rig.api.pushMyChatMember({ fromId: 42 });
    await until(async () => await state() === "ready", "pairing ready");
    expect((await call({ version: 1, action: "confirm", expectedRevision: null, operationId })).status).toBe(503);
    expect(loadChannelRecord(rig.dir)).toEqual({ ok: true, value: { schemaVersion: 1, revision: 2, state: "disconnected" } });
    expect(serve.service.hub()).toBeUndefined();
  } finally { await rig.cleanup(); }
});

test("revisioned test and disconnect refuse stale state and disconnect without resurrection", async () => {
  const rig = makeRig({ configured: false });
  try {
    const { commitChannelRecord } = await import("./channel-record");
    const config = { schemaVersion: 1 as const, chatId: FAKE_CHAT_ID, allowedUserIds: [42], orphanMs: 2345, runTimeoutMs: 0, permissionMode: "ask" as const, approvalTimeoutMs: 30000 };
    expect((await commitChannelRecord(null, { token: "123456:abcdefghijklmnopqrstuv", bot: await rig.api.getMe(), config }, rig.dir)).ok).toBe(true);
    const serve = await rig.startServe({ service: { experimentalChannelControl: true, pollTimeoutSec: 0 } });
    const call = (body: object) => serve.service.surface.handle("channels-control", request(body), { untimed: () => {} });
    expect((await call({ version: 1, action: "test", expectedRevision: null })).status).toBe(409);
    expect((await call({ version: 1, action: "disconnect", expectedRevision: null })).status).toBe(409);
    expect((await call({ version: 1, action: "test", expectedRevision: 1 })).status).toBe(200);
    const disconnected = await call({ version: 1, action: "disconnect", expectedRevision: 1 });
    expect(disconnected.status).toBe(200);
    expect((await disconnected.json() as { revision: number }).revision).toBe(2);
    expect(loadChannelRecord(rig.dir)).toEqual({ ok: true, value: { schemaVersion: 1, revision: 2, state: "disconnected" } });
    expect(serve.service.hub()).toBeUndefined();
  } finally { await rig.cleanup(); }
});

test("revisioned policy and rendering updates change live hub settings without touching other fields", async () => {
  const rig = makeRig({ configured: false });
  try {
    const { commitChannelRecord } = await import("./channel-record");
    const config = { schemaVersion: 1 as const, chatId: FAKE_CHAT_ID, allowedUserIds: [42], orphanMs: 2345, runTimeoutMs: 0, permissionMode: "ask" as const, approvalTimeoutMs: 30000, rendering: "plain" as const };
    expect((await commitChannelRecord(null, { token: "123456:abcdefghijklmnopqrstuv", bot: await rig.api.getMe(), config }, rig.dir)).ok).toBe(true);
    const serve = await rig.startServe({ service: { experimentalChannelControl: true, pollTimeoutSec: 0 } });
    const call = (body: object) => serve.service.surface.handle("channels-control", request(body), { untimed: () => {} });
    expect((await call({ version: 1, action: "policy", expectedRevision: 1, patch: { permissionMode: "trust", runTimeoutMs: 12000 } })).status).toBe(200);
    expect(serve.service.hub()?.limits()).toMatchObject({ permissionMode: "trust", runTimeoutMs: 12000, approvalTimeoutMs: 30000 });
    expect((await call({ version: 1, action: "rendering", expectedRevision: 1, mode: "html" })).status).toBe(409);
    expect((await call({ version: 1, action: "rendering", expectedRevision: 2, mode: "html" })).status).toBe(200);
    expect(serve.service.hub()?.renderingStatus().mode).toBe("html");
    const current = loadChannelRecord(rig.dir);
    expect(current.ok && current.value?.state === "connected" && current.value.config.allowedUserIds).toEqual([42]);
  } finally { await rig.cleanup(); }
});

test("distinct-bot cutover requires confirmation and starts an isolated empty binding generation", async () => {
  const rig = makeRig({ configured: false });
  const { FakeBotApi } = await import("./fake-bot-api");
  const candidate = new FakeBotApi({ botId: 987654 });
  try {
    const { commitChannelRecord } = await import("./channel-record");
    const oldConfig = { schemaVersion: 1 as const, chatId: FAKE_CHAT_ID, allowedUserIds: [42], orphanMs: 2345, runTimeoutMs: 12000, permissionMode: "ask" as const, approvalTimeoutMs: 30000, rendering: "plain" as const };
    expect((await commitChannelRecord(null, { token: "123456:abcdefghijklmnopqrstuv", bot: await rig.api.getMe(), config: oldConfig }, rig.dir)).ok).toBe(true);
    const serve = await rig.startServe({ service: { experimentalChannelControl: true, candidateApi: () => candidate, pairing: { code, pollTimeoutSec: 0 }, pollTimeoutSec: 0 } });
    const original = serve.service.hub();
    let revoked = false;
    const client = rig.makeClient({ sessionId: "desktop-cutover", project: "/project", owner: { kind: "desktop", incarnation: "owner1", generation: "gen1" }, onLine: () => {}, onChannelRevoked: () => { revoked = true; return true; } });
    expect((await client.start()).ok).toBe(true);
    const staged = stageChannelToken("987654:zyxwvutsrqponmlkjihgfe", rig.dir);
    if (!staged.ok) throw new Error("staging failed");
    const call = (body: object) => serve.service.surface.handle("channels-control", request(body), { untimed: () => {} });
    const begun = await call({ version: 1, action: "begin", expectedRevision: 1, stagingId: staged.value });
    const { operationId } = await begun.json() as { operationId: string };
    const state = async () => (await (await call({ version: 1, action: "status", expectedRevision: 1, operationId })).json() as { pairing: { state: string } }).pairing.state;
    candidate.pushPrivateMessage({ fromId: 42, text: code });
    await until(async () => await state() === "waiting-for-confirmation", "candidate claim");
    expect((await call({ version: 1, action: "confirm-account", expectedRevision: 1, operationId })).status).toBe(200);
    candidate.pushMyChatMember({ fromId: 42 });
    await until(async () => await state() === "ready", "candidate group");
    expect(serve.service.hub()).toBe(original);
    const response = await call({ version: 1, action: "confirm", expectedRevision: 1, operationId });
    expect(response.status).toBe(200);
    expect(revoked).toBe(true);
    expect(rig.api.callCount("closeForumTopic", "default")).toBe(1);
    expect(serve.service.hub()).not.toBe(original);
    expect(serve.service.hub()?.list()).toEqual([]);
    const record = loadChannelRecord(rig.dir);
    expect(record.ok && record.value?.state === "connected" && record.value.bot?.id).toBe(987654);
    expect(record.ok && record.value?.state === "connected" && record.value.config).toMatchObject({ orphanMs: 2345, runTimeoutMs: 12000, permissionMode: "ask", rendering: "plain" });
  } finally { await rig.cleanup(); }
});

test("distinct cutover never publishes a candidate without every owner acknowledgement", async () => {
  const rig = makeRig({ configured: false });
  const { FakeBotApi } = await import("./fake-bot-api");
  const candidate = new FakeBotApi({ botId: 987654 });
  try {
    const { commitChannelRecord } = await import("./channel-record");
    const config = { schemaVersion: 1 as const, chatId: FAKE_CHAT_ID, allowedUserIds: [42], orphanMs: 2345, runTimeoutMs: 0, permissionMode: "ask" as const, approvalTimeoutMs: 30000 };
    expect((await commitChannelRecord(null, { token: "123456:abcdefghijklmnopqrstuv", bot: await rig.api.getMe(), config }, rig.dir)).ok).toBe(true);
    const serve = await rig.startServe({ service: { experimentalChannelControl: true, candidateApi: () => candidate, revocationTimeoutMs: 20, pairing: { code, pollTimeoutSec: 0 }, pollTimeoutSec: 0 } });
    const client = rig.makeClient({ sessionId: "desktop-unacked", project: "/project", owner: { kind: "desktop", incarnation: "owner1", generation: "gen1" }, onLine: () => {}, onChannelRevoked: () => false });
    expect((await client.start()).ok).toBe(true);
    const staged = stageChannelToken("987654:zyxwvutsrqponmlkjihgfe", rig.dir);
    if (!staged.ok) throw new Error("staging failed");
    const call = (body: object) => serve.service.surface.handle("channels-control", request(body), { untimed: () => {} });
    const begun = await call({ version: 1, action: "begin", expectedRevision: 1, stagingId: staged.value });
    const { operationId } = await begun.json() as { operationId: string };
    const state = async () => (await (await call({ version: 1, action: "status", expectedRevision: 1, operationId })).json() as { pairing: { state: string } }).pairing.state;
    candidate.pushPrivateMessage({ fromId: 42, text: code });
    await until(async () => await state() === "waiting-for-confirmation", "candidate claim");
    expect((await call({ version: 1, action: "confirm-account", expectedRevision: 1, operationId })).status).toBe(200);
    candidate.pushMyChatMember({ fromId: 42 });
    await until(async () => await state() === "ready", "candidate group");
    expect((await call({ version: 1, action: "confirm", expectedRevision: 1, operationId })).status).toBe(503);
    expect(serve.service.hub()?.pollerStatus().state).toBe("running");
    expect(serve.service.hub()?.list()).toEqual([]);
    const recovered = loadChannelRecord(rig.dir);
    expect(recovered.ok && recovered.value?.state === "connected" && recovered.value.bot?.id).toBe((await rig.api.getMe()).id);
    expect(recovered.ok && recovered.value?.revision).toBe(2);
    expect(recovered.ok && recovered.value?.state === "connected" && recovered.value.bindingId).toMatch(/^[0-9a-f]{32}$/);
  } finally { await rig.cleanup(); }
});

test("gated startup migrates legacy policy and verifies bot identity before starting", async () => {
  const rig = makeRig({ configured: false });
  try {
    const { saveBotToken, saveRemoteConfig } = await import("./config");
    expect(saveBotToken("123456:abcdefghijklmnopqrstuv", rig.dir).ok).toBe(true);
    expect(saveRemoteConfig({ schemaVersion: 1, chatId: FAKE_CHAT_ID, allowedUserIds: [42], orphanMs: 2345, runTimeoutMs: 12000, permissionMode: "ask", approvalTimeoutMs: 30000, rendering: "plain" }, rig.dir).ok).toBe(true);
    const serve = await rig.startServe({ service: { experimentalChannelControl: true, pollTimeoutSec: 0 } });
    const record = loadChannelRecord(rig.dir);
    expect(record.ok && record.value?.state === "connected" && record.value.bot?.id).toBe((await rig.api.getMe()).id);
    expect(record.ok && record.value?.state === "connected" && record.value.config).toMatchObject({ orphanMs: 2345, runTimeoutMs: 12000, permissionMode: "ask", rendering: "plain" });
    expect(serve.service.hub()).toBeDefined();
    const blocked = await serve.service.surface.handle("channels-reload", request({}), { untimed: () => {} });
    expect(blocked.status).toBe(409);
  } finally { await rig.cleanup(); }
});

test("revisioned disconnect waits for Desktop revocation before removing the channel", async () => {
  const rig = makeRig({ configured: false });
  try {
    const { commitChannelRecord } = await import("./channel-record");
    const config = { schemaVersion: 1 as const, chatId: FAKE_CHAT_ID, allowedUserIds: [42], orphanMs: 2345, runTimeoutMs: 0, permissionMode: "ask" as const, approvalTimeoutMs: 30000 };
    expect((await commitChannelRecord(null, { token: "123456:abcdefghijklmnopqrstuv", bot: await rig.api.getMe(), config }, rig.dir)).ok).toBe(true);
    const serve = await rig.startServe({ service: { experimentalChannelControl: true, pollTimeoutSec: 0 } });
    let revoked = false;
    const client = rig.makeClient({ sessionId: "desktop-disconnect", project: "/project", owner: { kind: "desktop", incarnation: "owner1", generation: "gen1" }, onLine: () => {}, onChannelRevoked: () => { revoked = true; return true; } });
    expect((await client.start()).ok).toBe(true);
    const response = await serve.service.surface.handle("channels-control", request({ version: 1, action: "disconnect", expectedRevision: 1 }), { untimed: () => {} });
    expect(response.status).toBe(200);
    expect(revoked).toBe(true);
    expect(loadChannelRecord(rig.dir)).toEqual({ ok: true, value: { schemaVersion: 1, revision: 2, state: "disconnected" } });
    expect(serve.service.hub()).toBeUndefined();
  } finally { await rig.cleanup(); }
});

test("distinct cutover cannot overwrite a newer revision after revocation", async () => {
  const rig = makeRig({ configured: false });
  const { FakeBotApi } = await import("./fake-bot-api");
  const candidate = new FakeBotApi({ botId: 987654 });
  try {
    const { commitChannelRecord, disconnectChannelRecord } = await import("./channel-record");
    const config = { schemaVersion: 1 as const, chatId: FAKE_CHAT_ID, allowedUserIds: [42], orphanMs: 2345, runTimeoutMs: 0, permissionMode: "ask" as const, approvalTimeoutMs: 30000 };
    expect((await commitChannelRecord(null, { token: "123456:abcdefghijklmnopqrstuv", bot: await rig.api.getMe(), config }, rig.dir)).ok).toBe(true);
    const serve = await rig.startServe({ service: { experimentalChannelControl: true, candidateApi: () => candidate, afterBindingRevocation: async () => { await disconnectChannelRecord(1, rig.dir); }, pairing: { code, pollTimeoutSec: 0 }, pollTimeoutSec: 0 } });
    const staged = stageChannelToken("987654:zyxwvutsrqponmlkjihgfe", rig.dir);
    if (!staged.ok) throw new Error("staging failed");
    const call = (body: object) => serve.service.surface.handle("channels-control", request(body), { untimed: () => {} });
    const begun = await call({ version: 1, action: "begin", expectedRevision: 1, stagingId: staged.value });
    const { operationId } = await begun.json() as { operationId: string };
    const state = async () => (await (await call({ version: 1, action: "status", expectedRevision: 1, operationId })).json() as { pairing: { state: string } }).pairing.state;
    candidate.pushPrivateMessage({ fromId: 42, text: code });
    await until(async () => await state() === "waiting-for-confirmation", "candidate claim");
    expect((await call({ version: 1, action: "confirm-account", expectedRevision: 1, operationId })).status).toBe(200);
    candidate.pushMyChatMember({ fromId: 42 });
    await until(async () => await state() === "ready", "candidate group");
    expect((await call({ version: 1, action: "confirm", expectedRevision: 1, operationId })).status).toBe(503);
    expect(loadChannelRecord(rig.dir)).toEqual({ ok: true, value: { schemaVersion: 1, revision: 2, state: "disconnected" } });
    expect(serve.service.hub()).toBeUndefined();
  } finally { await rig.cleanup(); }
});

test("a re-paired replacement activates when a committed channel has no running hub", async () => {
  const rig = makeRig({ configured: false });
  const { FakeBotApi } = await import("./fake-bot-api");
  const candidate = new FakeBotApi({ botId: 987654 });
  try {
    const { commitChannelRecord } = await import("./channel-record");
    const config = { schemaVersion: 1 as const, chatId: FAKE_CHAT_ID, allowedUserIds: [42], orphanMs: 2345, runTimeoutMs: 12000, permissionMode: "ask" as const, approvalTimeoutMs: 30000, rendering: "plain" as const };
    expect((await commitChannelRecord(null, { token: "123456:abcdefghijklmnopqrstuv", bot: await rig.api.getMe(), config }, rig.dir)).ok).toBe(true);
    rig.api.failNext("getUpdates", new BotApiError("rejected", "fixture rejected"));
    const serve = await rig.startServe({ service: { experimentalChannelControl: true, candidateApi: () => candidate, pairing: { code, pollTimeoutSec: 0 }, pollTimeoutSec: 0 } });
    expect(serve.service.hub()).toBeUndefined();
    const staged = stageChannelToken("987654:zyxwvutsrqponmlkjihgfe", rig.dir);
    if (!staged.ok) throw new Error("staging failed");
    const call = (body: object) => serve.service.surface.handle("channels-control", request(body), { untimed: () => {} });
    const begun = await call({ version: 1, action: "begin", expectedRevision: 1, stagingId: staged.value });
    expect(begun.status).toBe(200);
    const { operationId } = await begun.json() as { operationId: string };
    const state = async () => (await (await call({ version: 1, action: "status", expectedRevision: 1, operationId })).json() as { pairing: { state: string } }).pairing.state;
    candidate.pushPrivateMessage({ fromId: 77, text: code });
    await until(async () => await state() === "waiting-for-confirmation", "candidate claim");
    expect((await call({ version: 1, action: "confirm-account", expectedRevision: 1, operationId })).status).toBe(200);
    candidate.pushMyChatMember({ fromId: 77 });
    await until(async () => await state() === "ready", "candidate group");
    expect((await call({ version: 1, action: "confirm", expectedRevision: 1, operationId })).status).toBe(200);
    const current = loadChannelRecord(rig.dir);
    expect(current.ok && current.value?.state === "connected" && current.value.bot?.id).toBe(987654);
    expect(current.ok && current.value?.revision).toBe(2);
    expect(current.ok && current.value?.state === "connected" && current.value.config).toMatchObject({ allowedUserIds: [77], permissionMode: "ask", rendering: "plain", runTimeoutMs: 12000 });
    expect(serve.service.hub()?.list()).toEqual([]);
  } finally { await rig.cleanup(); }
});

test("offline replacement failure recovers the previous valid bot without old bindings", async () => {
  const rig = makeRig({ configured: false });
  const { FakeBotApi } = await import("./fake-bot-api");
  const candidate = new FakeBotApi({ botId: 987654 });
  try {
    const { commitChannelRecord } = await import("./channel-record");
    const oldBot = await rig.api.getMe();
    const config = { schemaVersion: 1 as const, chatId: FAKE_CHAT_ID, allowedUserIds: [42], orphanMs: 2345, runTimeoutMs: 0, permissionMode: "ask" as const, approvalTimeoutMs: 30000 };
    expect((await commitChannelRecord(null, { token: "123456:abcdefghijklmnopqrstuv", bot: oldBot, config }, rig.dir)).ok).toBe(true);
    rig.api.failNext("getUpdates", new BotApiError("rejected", "fixture rejected"));
    const serve = await rig.startServe({ service: { experimentalChannelControl: true, candidateApi: () => candidate, afterCandidateCommit: async () => { throw new Error("fixture"); }, pairing: { code, pollTimeoutSec: 0 }, pollTimeoutSec: 0 } });
    expect(serve.service.hub()).toBeUndefined();
    const staged = stageChannelToken("987654:zyxwvutsrqponmlkjihgfe", rig.dir);
    if (!staged.ok) throw new Error("staging failed");
    const call = (body: object) => serve.service.surface.handle("channels-control", request(body), { untimed: () => {} });
    const begun = await call({ version: 1, action: "begin", expectedRevision: 1, stagingId: staged.value });
    const { operationId } = await begun.json() as { operationId: string };
    const state = async () => (await (await call({ version: 1, action: "status", expectedRevision: 1, operationId })).json() as { pairing: { state: string } }).pairing.state;
    candidate.pushPrivateMessage({ fromId: 77, text: code });
    await until(async () => await state() === "waiting-for-confirmation", "candidate claim");
    expect((await call({ version: 1, action: "confirm-account", expectedRevision: 1, operationId })).status).toBe(200);
    candidate.pushMyChatMember({ fromId: 77 });
    await until(async () => await state() === "ready", "candidate group");
    expect((await call({ version: 1, action: "confirm", expectedRevision: 1, operationId })).status).toBe(503);
    const current = loadChannelRecord(rig.dir);
    expect(current.ok && current.value?.state === "connected" && current.value.bot?.id).toBe(oldBot.id);
    expect(current.ok && current.value?.revision).toBe(3);
    expect(serve.service.hub()?.pollerStatus().state).toBe("running");
    expect(serve.service.hub()?.list()).toEqual([]);
  } finally { await rig.cleanup(); }
});

test("a failed distinct candidate leaves the proven old poller and bindings in place", async () => {
  const rig = makeRig({ configured: false });
  const { FakeBotApi } = await import("./fake-bot-api");
  const candidate = new FakeBotApi({ botId: 987654 });
  try {
    const { commitChannelRecord } = await import("./channel-record");
    const config = { schemaVersion: 1 as const, chatId: FAKE_CHAT_ID, allowedUserIds: [42], orphanMs: 2345, runTimeoutMs: 0, permissionMode: "ask" as const, approvalTimeoutMs: 30000 };
    expect((await commitChannelRecord(null, { token: "123456:abcdefghijklmnopqrstuv", bot: await rig.api.getMe(), config }, rig.dir)).ok).toBe(true);
    const serve = await rig.startServe({ service: { experimentalChannelControl: true, candidateApi: () => candidate, pairing: { code, pollTimeoutSec: 0 }, pollTimeoutSec: 0 } });
    const original = serve.service.hub();
    const client = rig.makeClient({ sessionId: "desktop-safe", project: "/project", owner: { kind: "desktop", incarnation: "owner1", generation: "gen1" }, onLine: () => {}, onChannelRevoked: () => true });
    expect((await client.start()).ok).toBe(true);
    const staged = stageChannelToken("987654:zyxwvutsrqponmlkjihgfe", rig.dir);
    if (!staged.ok) throw new Error("staging failed");
    const call = (body: object) => serve.service.surface.handle("channels-control", request(body), { untimed: () => {} });
    const begun = await call({ version: 1, action: "begin", expectedRevision: 1, stagingId: staged.value });
    const { operationId } = await begun.json() as { operationId: string };
    const state = async () => (await (await call({ version: 1, action: "status", expectedRevision: 1, operationId })).json() as { pairing: { state: string } }).pairing.state;
    candidate.pushPrivateMessage({ fromId: 77, text: code });
    await until(async () => await state() === "waiting-for-confirmation", "candidate claim");
    expect((await call({ version: 1, action: "confirm-account", expectedRevision: 1, operationId })).status).toBe(200);
    candidate.pushMyChatMember({ fromId: 77 });
    await until(async () => await state() === "ready", "candidate group");
    candidate.failNext("getUpdates", new BotApiError("conflict", "fixture conflict"));
    expect((await call({ version: 1, action: "confirm", expectedRevision: 1, operationId })).status).toBe(503);
    expect(serve.service.hub()).toBe(original);
    expect(original?.pollerStatus().state).toBe("running");
    expect(original?.list()).toHaveLength(1);
    expect(client.connected).toBe(true);
    const record = loadChannelRecord(rig.dir);
    expect(record.ok && record.value?.revision).toBe(1);
  } finally { await rig.cleanup(); }
});

test("unverified old credential leaves admission closed after a failed cutover", async () => {
  const rig = makeRig({ configured: false });
  const { FakeBotApi } = await import("./fake-bot-api");
  const candidate = new FakeBotApi({ botId: 987654 });
  try {
    const { commitChannelRecord } = await import("./channel-record");
    const config = { schemaVersion: 1 as const, chatId: FAKE_CHAT_ID, allowedUserIds: [42], orphanMs: 2345, runTimeoutMs: 0, permissionMode: "ask" as const, approvalTimeoutMs: 30000 };
    expect((await commitChannelRecord(null, { token: "123456:abcdefghijklmnopqrstuv", bot: await rig.api.getMe(), config }, rig.dir)).ok).toBe(true);
    const serve = await rig.startServe({ service: { experimentalChannelControl: true, candidateApi: () => candidate, afterBindingRevocation: async () => { rig.api.failNext("getUpdates", new BotApiError("rejected", "fixture revoked")); throw new Error("fixture"); }, pairing: { code, pollTimeoutSec: 0 }, pollTimeoutSec: 0 } });
    const staged = stageChannelToken("987654:zyxwvutsrqponmlkjihgfe", rig.dir);
    if (!staged.ok) throw new Error("staging failed");
    const call = (body: object) => serve.service.surface.handle("channels-control", request(body), { untimed: () => {} });
    const begun = await call({ version: 1, action: "begin", expectedRevision: 1, stagingId: staged.value });
    const { operationId } = await begun.json() as { operationId: string };
    const state = async () => (await (await call({ version: 1, action: "status", expectedRevision: 1, operationId })).json() as { pairing: { state: string } }).pairing.state;
    candidate.pushPrivateMessage({ fromId: 77, text: code });
    await until(async () => await state() === "waiting-for-confirmation", "candidate claim");
    expect((await call({ version: 1, action: "confirm-account", expectedRevision: 1, operationId })).status).toBe(200);
    candidate.pushMyChatMember({ fromId: 77 });
    await until(async () => await state() === "ready", "candidate group");
    expect((await call({ version: 1, action: "confirm", expectedRevision: 1, operationId })).status).toBe(503);
    expect(serve.service.hub()).toBeUndefined();
  } finally { await rig.cleanup(); }
});
