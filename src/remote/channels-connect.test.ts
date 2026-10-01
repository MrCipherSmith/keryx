// AC6 (flow 377): Connect with serve running turns Telegram on without a restart. Invalid
// data leaves nothing on disk and shows a reason.
//
// A real loopback serve that started with NO Telegram configured, the fake Bot API and the real
// shell client. Only the token is typed; the user and group ids come from Telegram's events.

import { readFileSync } from "node:fs";
import { afterEach, describe, expect, test } from "bun:test";
import { botTokenPath, remoteConfigPath } from "./paths";
import { BOT_TOKEN, connectFully, makeChannelsRig, pairFully, type ChannelsRig } from "./channels.test-helpers";
import { OWNER_ID, until } from "./remote.test-helpers";

let r: ChannelsRig | undefined;
afterEach(async () => {
  await r?.rig.cleanup();
  r = undefined;
});

describe("a serve that started with Telegram unconfigured", () => {
  test("starts quietly, is not connected, runs no poller, and still answers the channels plane", async () => {
    r = await makeChannelsRig();
    expect(r.rig.notices).toEqual([]);
    expect(r.serve.service.hub()).toBeUndefined();
    expect(r.rig.api.activePollers()).toBe(0);
    expect(r.rig.api.callCount("getUpdates")).toBe(0);

    const status = await r.client.status();
    expect(status.ok).toBe(true);
    if (status.ok) {
      expect(status.value.telegram.state).toBe("not-connected");
      expect(status.value.telegram.sessions).toBe(0);
    }
    expect(r.client.localFiles()).toEqual({ tokenFile: false, configFile: false });
  });
});

describe("Connect, with serve left running", () => {
  test("token, a code in a private chat, the bot added to a group: Telegram is on, and serve was never restarted", async () => {
    r = await makeChannelsRig();
    const serveBefore = r.serve.service;
    const ready = await pairFully(r);
    expect(ready.userId).toBe(OWNER_ID);
    expect(ready.chatId).toBe(r.rig.api.chatId);
    // Still not connected: nothing polls for the hub until Connect finishes.
    expect(r.serve.service.hub()).toBeUndefined();

    const done = await r.client.connectFinish({ userId: ready.userId as number, chatId: ready.chatId as number });
    expect(done.ok).toBe(true);
    if (done.ok) {
      expect(done.value.state).toBe("connected");
    }

    expect(r.serve.service).toBe(serveBefore);
    expect(r.serve.service.hub()).toBeDefined();
    await until(() => r?.rig.api.activePollers() === 1, "the hub to poll");
    const status = await r.client.status();
    expect(status.ok && status.value.telegram.state).toBe("connected");
    expect(r.rig.notices).toEqual([]);
  });

  test("the config on disk holds the ids Telegram reported, and nothing hard-coded", async () => {
    r = await makeChannelsRig();
    await connectFully(r);
    const config = JSON.parse(readFileSync(remoteConfigPath(r.rig.dir), "utf8")) as { chatId: number; allowedUserIds: number[] };
    expect(config.allowedUserIds).toEqual([OWNER_ID]);
    expect(config.chatId).toBe(r.rig.api.chatId);
  });

  test("the hub that Connect started is the real one: a shell session gets its topic and only the paired user may write", async () => {
    r = await makeChannelsRig();
    await connectFully(r);
    const lines: string[] = [];
    const shell = r.rig.makeClient({ sessionId: "sess-conn-0001", project: "/work/app", name: "release", onLine: (line) => {
        lines.push(line);
      },
    });
    const started = await shell.start();
    expect(started.ok).toBe(true);
    await until(() => r?.rig.api.topics().length === 1, "the session's topic");
    const thread = r.rig.api.topics()[0]?.messageThreadId as number;

    r.rig.api.pushMessage({ fromId: 666_001, text: "intruder", threadId: thread });
    r.rig.api.pushMessage({ fromId: OWNER_ID, text: "hello from the phone", threadId: thread });
    await until(() => lines.length > 0, "the operator's line to arrive");
    expect(lines.join("\n")).toContain("hello from the phone");
    expect(lines.join("\n")).not.toContain("intruder");
  });

  test("a second Connect while connected is refused with a reason and changes nothing", async () => {
    r = await makeChannelsRig();
    await connectFully(r);
    const tokenFile = botTokenPath(r.rig.dir);
    const before = readFileSync(tokenFile, "utf8");

    const again = await r.client.startPairing("111111111:BBBBBBBBBBBBBBBBBBBBBBBBBBBB");
    expect(again.ok).toBe(false);
    if (!again.ok) {
      expect(again.code).toBe("already-connected");
      expect(again.reason).toContain("disconnect");
    }
    expect(readFileSync(tokenFile, "utf8")).toBe(before);
    expect(readFileSync(tokenFile, "utf8").trim()).toBe(BOT_TOKEN);
    expect(r.serve.service.hub()).toBeDefined();
  });
});

describe("invalid data leaves nothing on disk and says why", () => {
  test("a token with the wrong shape is refused before anything is written", async () => {
    r = await makeChannelsRig();
    const result = await r.client.startPairing("not a token");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("invalid");
      expect(result.reason.length).toBeGreaterThan(10);
    }
    expect(r.client.localFiles()).toEqual({ tokenFile: false, configFile: false });
    expect(r.rig.api.callCount("getMe")).toBe(0);
  });

  test("a token Telegram does not know is refused and the file it was written to is taken back", async () => {
    r = await makeChannelsRig();
    r.rig.api.setTokenRejected(true);
    const result = await r.client.startPairing(BOT_TOKEN);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("token-rejected");
      expect(result.reason).toContain("BotFather");
    }
    expect(r.client.localFiles()).toEqual({ tokenFile: false, configFile: false });
  });

  test("Telegram unreachable is reported as such and nothing is left behind", async () => {
    r = await makeChannelsRig();
    r.rig.api.setDown(true);
    const result = await r.client.startPairing(BOT_TOKEN);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("telegram-unreachable");
    }
    expect(r.client.localFiles()).toEqual({ tokenFile: false, configFile: false });
  });

  test("ids that make no valid config are refused locally: no config is written", async () => {
    r = await makeChannelsRig();
    const ready = await pairFully(r);
    const bad = await r.client.connectFinish({ userId: -5, chatId: ready.chatId as number });
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.code).toBe("invalid");
      expect(bad.reason.length).toBeGreaterThan(10);
    }
    expect(r.client.localFiles().configFile).toBe(false);
    expect(r.serve.service.hub()).toBeUndefined();
  });

  test("abandoning Connect erases the token that never became a connection and stops polling", async () => {
    r = await makeChannelsRig();
    await pairFully(r);
    const cancelled = await r.client.cancelPairing();
    expect(cancelled.ok && cancelled.value.cancelled).toBe(true);
    expect(r.client.localFiles()).toEqual({ tokenFile: false, configFile: false });
    expect(r.rig.api.activePollers()).toBe(0);
    const status = await r.client.status();
    expect(status.ok && status.value.telegram.state).toBe("not-connected");
    const pairing = await r.client.pairingStatus();
    expect(pairing.ok).toBe(false);
    if (!pairing.ok) {
      expect(pairing.code).toBe("no-pairing");
    }
  });

  test("with serve not running, Connect says so and writes nothing", async () => {
    r = await makeChannelsRig();
    await r.serve.stop();
    const result = await r.client.startPairing(BOT_TOKEN);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("serve-down");
      expect(result.reason).toContain("keryx serve");
    }
    expect(r.client.localFiles()).toEqual({ tokenFile: false, configFile: false });
  });
});
