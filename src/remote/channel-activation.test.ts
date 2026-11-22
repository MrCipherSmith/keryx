import { expect, test } from "bun:test";
import { makeRig } from "./remote.http.test-helpers";
import { stageChannelToken } from "./channel-staging";
import { loadChannelRecord } from "./channel-record";
import { BotApiError } from "./types";
import { until } from "./remote.test-helpers";

const code = "ABCD2345";
function request(body: object): Request { return new Request("http://localhost", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); }
test("first setup commits only after candidate runtime readiness", async () => {
  const rig = makeRig({ configured: false });
  try {
    const serve = await rig.startServe({ service: { experimentalChannelControl: true, pairing: { code, pollTimeoutSec: 0 }, pollTimeoutSec: 0 } });
    const staged = stageChannelToken("123456:abcdefghijklmnopqrstuv", rig.dir);
    if (!staged.ok) throw new Error("staging failed");
    const call = (body: object) => serve.service.surface.handle("channels-control", request(body), { untimed: () => {} });
    const started = await call({ version: 1, action: "begin", expectedRevision: null, stagingId: staged.value });
    expect(started.status).toBe(200);
    const { operationId } = await started.json() as { operationId: string };
    const state = async () => (await (await call({ version: 1, action: "status", expectedRevision: null, operationId })).json() as { pairing: { state: string } }).pairing.state;
    rig.api.pushPrivateMessage({ fromId: 42, text: `/start ${code}` });
    await until(async () => await state() === "waiting-for-group", "pairing claim");
    rig.api.pushMyChatMember({ fromId: 42 });
    await until(async () => await state() === "ready", "pairing ready");
    expect(loadChannelRecord(rig.dir)).toEqual({ ok: true, value: null });
    const confirmed = await call({ version: 1, action: "confirm", expectedRevision: null, operationId });
    expect(confirmed.status).toBe(200);
    const record = loadChannelRecord(rig.dir);
    expect(record.ok && record.value?.state).toBe("connected");
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
    await until(async () => await state() === "waiting-for-group", "pairing claim");
    rig.api.pushMyChatMember({ fromId: 42 });
    await until(async () => await state() === "ready", "pairing ready");
    rig.api.failNext("getUpdates", new BotApiError("network", "fixture failure"));
    expect((await call({ version: 1, action: "confirm", expectedRevision: null, operationId })).status).toBe(503);
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
    const config = { schemaVersion: 1 as const, chatId: -10012345, allowedUserIds: [42], orphanMs: 2345, runTimeoutMs: 0, permissionMode: "ask" as const, approvalTimeoutMs: 30000, rendering: "plain" as const };
    expect((await commitChannelRecord(null, { token, bot: identity, config }, rig.dir)).ok).toBe(true);
    const serve = await rig.startServe({ service: { experimentalChannelControl: true, pollTimeoutSec: 0 } });
    const original = serve.service.hub();
    expect(original).toBeDefined();
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
    await until(async () => await state() === "waiting-for-group", "candidate pairing claim");
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
    await until(async () => await state() === "waiting-for-group", "pairing claim");
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
    await until(async () => await state() === "waiting-for-group", "pairing claim");
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
    await until(async () => await state() === "waiting-for-group", "pairing claim");
    rig.api.pushMyChatMember({ fromId: 42 });
    await until(async () => await state() === "ready", "pairing ready");
    expect((await call({ version: 1, action: "confirm", expectedRevision: null, operationId })).status).toBe(503);
    expect(loadChannelRecord(rig.dir)).toEqual({ ok: true, value: { schemaVersion: 1, revision: 2, state: "disconnected" } });
    expect(serve.service.hub()).toBeUndefined();
  } finally { await rig.cleanup(); }
});
