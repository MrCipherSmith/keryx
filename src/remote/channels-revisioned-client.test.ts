import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { ChannelsClient } from "./channels-client";
import { makeRig } from "./remote.http.test-helpers";
import { derivedBearerNonce, serveResponseProof, SERVE_PROOF_HEADER } from "./shell-token";
import { commitChannelRecord } from "./channel-record";
import { botTokenPath } from "./paths";
import { testConfig } from "./remote.test-helpers";

test("revisioned begin checks capability and sends only the scoped staging id", async () => {
  const rig = makeRig({ configured: false });
  try {
    const serve = await rig.startServe();
    const requests: Record<string, unknown>[] = [];
    const credential = "123456:abcdefghijklmnopqrstuv";
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input, init);
      const route = new URL(req.url).pathname.split("/").pop() as "channels-status" | "channels-control";
      const body = route === "channels-status" ? { schemaVersion: "1.0.0", machine: "test", telegram: { state: "not-connected", sessions: 0 }, capabilities: { desktopTelegram: 1 } } : { schemaVersion: "1.0.0", operationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", revision: null, state: "same-bot-ready" };
      if (route === "channels-control") requests.push(await req.json() as Record<string, unknown>);
      const text = JSON.stringify(body);
      const nonce = derivedBearerNonce((req.headers.get("authorization") ?? "").slice(7));
      if (nonce === undefined) throw new Error("missing nonce");
      return new Response(text, { headers: { [SERVE_PROOF_HEADER]: serveResponseProof(serve.shellToken, nonce, route, 200, text) } });
    }) as typeof fetch;
    const client = new ChannelsClient({ dir: rig.dir, fetchImpl });
    expect((await client.beginRevisioned(credential, null)).ok).toBe(true);
    expect(JSON.stringify(requests)).not.toContain(credential);
    expect(requests[0]).toMatchObject({ action: "begin", version: 1, expectedRevision: null });
    expect(typeof requests[0]?.stagingId).toBe("string");
    expect((await client.beginRevisioned(credential, 1))).toMatchObject({ ok: false, code: "conflict" });
    expect(requests).toHaveLength(1);
  } finally { await rig.cleanup(); }
});

test("legacy mutation refuses a migrated record before writing legacy credentials", async () => {
  const rig = makeRig({ configured: false });
  try {
    const credential = "123456:abcdefghijklmnopqrstuv";
    expect((await commitChannelRecord(null, { token: credential, bot: null, config: testConfig() }, rig.dir)).ok).toBe(true);
    const result = await new ChannelsClient({ dir: rig.dir }).startPairing(credential);
    expect(result).toMatchObject({ ok: false, code: "upgrade-required" });
    expect(existsSync(botTokenPath(rig.dir))).toBe(false);
  } finally { await rig.cleanup(); }
});

test("a failed reload preserves another shell's newer config", async () => {
  const { saveRemoteConfig } = await import("./config");
  const { remoteConfigPath } = await import("./paths");
  const { readFileSync } = await import("node:fs");
  const rig = makeRig({ configured: false });
  try {
    const serve = await rig.startServe();
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input, init);
      expect(saveRemoteConfig(testConfig({ chatId: -999 }), rig.dir).ok).toBe(true);
      const nonce = derivedBearerNonce((req.headers.get("authorization") ?? "").slice(7));
      if (nonce === undefined) throw new Error("missing nonce");
      const text = JSON.stringify({ error: { code: "refused", message: "refused" } });
      return new Response(text, { status: 409, headers: { [SERVE_PROOF_HEADER]: serveResponseProof(serve.shellToken, nonce, "channels-reload", 409, text) } });
    }) as typeof fetch;
    const client = new ChannelsClient({ dir: rig.dir, fetchImpl });
    expect((await client.connectFinish({ userId: 42, chatId: -123 })).ok).toBe(false);
    expect(JSON.parse(readFileSync(remoteConfigPath(rig.dir), "utf8")).chatId).toBe(-999);
  } finally { await rig.cleanup(); }
});

test("disconnect attempts config removal even when token removal fails", async () => {
  const { mkdirSync } = await import("node:fs");
  const { saveRemoteConfig } = await import("./config");
  const { remoteConfigPath } = await import("./paths");
  const rig = makeRig({ configured: false });
  try {
    expect(saveRemoteConfig(testConfig(), rig.dir).ok).toBe(true);
    mkdirSync(botTokenPath(rig.dir));
    const result = await new ChannelsClient({ dir: rig.dir }).disconnect();
    expect(result.ok && result.value.erased).toBe(false);
    expect(existsSync(remoteConfigPath(rig.dir))).toBe(false);
  } finally { await rig.cleanup(); }
});
