// AC7 (flow 377): Test sends one message to General and reports delivered, or the reason;
// it says so when serve is down.
//
// Real loopback serve, fake Bot API, real shell client. No live network.

import { afterEach, describe, expect, test } from "bun:test";
import { BOT_TOKEN, connectFully, makeChannelsRig, pairFully, type ChannelsRig } from "./channels.test-helpers";
import { localMachineName } from "./naming";
import { BotApiError } from "./types";

let r: ChannelsRig | undefined;
afterEach(async () => {
  await r?.rig.cleanup();
  r = undefined;
});

/** What the bot has said to the General topic: messages with no thread, in the group. */
function generalMessages(rig: ChannelsRig): string[] {
  return rig.rig.api.sent.filter((entry) => entry.chatId === rig.rig.api.chatId && entry.messageThreadId === undefined).map((entry) => entry.text);
}

describe("Test while connected", () => {
  test("sends exactly one message to General, names this machine and reports it delivered", async () => {
    r = await makeChannelsRig();
    await connectFully(r);
    expect(generalMessages(r)).toEqual([]);

    const result = await r.client.test();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.delivered).toBe(true);
      expect(result.value.machine).toBe(localMachineName());
    }
    const sent = generalMessages(r);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain(localMachineName());
    expect(sent[0]).toContain("test");
    // It went to the group's own chat, not to a session topic.
    expect(r.rig.api.topics()).toEqual([]);
  });

  test("each press sends one message: two tests, two messages", async () => {
    r = await makeChannelsRig();
    await connectFully(r);
    await r.client.test();
    await r.client.test();
    expect(generalMessages(r)).toHaveLength(2);
  });

  test("Telegram refusing the message is reported with a reason, not as delivered", async () => {
    r = await makeChannelsRig();
    await connectFully(r);
    r.rig.api.failNext("sendMessage", new BotApiError("rejected", "sendMessage: 400 Bad Request: not enough rights to send text messages", { status: 400 }));
    const result = await r.client.test();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("send-failed");
      expect(result.reason).toContain("not enough rights");
      expect(result.reason).not.toContain(BOT_TOKEN);
    }
    expect(generalMessages(r)).toEqual([]);
  });

  test("Telegram unreachable is reported with a reason", async () => {
    r = await makeChannelsRig();
    await connectFully(r);
    r.rig.api.setDown(true);
    const result = await r.client.test();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("send-failed");
      expect(result.reason.length).toBeGreaterThan(10);
    }
  });
});

describe("Test while not connected", () => {
  test("nothing is connected: it says so and sends nothing", async () => {
    r = await makeChannelsRig();
    const result = await r.client.test();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("not-connected");
      expect(result.reason).toContain("Telegram");
    }
    expect(r.rig.api.sent).toEqual([]);
  });

  test("a Connect that has not finished yet counts as not connected", async () => {
    r = await makeChannelsRig();
    await pairFully(r);
    const result = await r.client.test();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("not-connected");
    }
    expect(generalMessages(r)).toEqual([]);
  });
});

describe("Test while serve is down", () => {
  test("it says that serve is not running, and nothing is sent", async () => {
    r = await makeChannelsRig();
    await connectFully(r);
    const before = r.rig.api.sent.length;
    await r.serve.stop();

    const result = await r.client.test();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("serve-down");
      expect(result.reason).toContain("keryx serve");
    }
    expect(r.rig.api.sent.length).toBe(before);
  });

  test("a serve that never ran on this machine gives the same answer", async () => {
    r = await makeChannelsRig();
    await r.serve.stop();
    const result = await r.client.test();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("serve-down");
    }
  });
});
