// AC10: a restart of serve loses nothing. The session registry, the name to
// topic binding, queued inbound lines, the poller's offset and unsent outbound
// text all live on disk and are picked up by the next hub on the same directory.

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { FakeBotApi } from "./fake-bot-api";
import { INBOUND_DIRNAME, remoteDirPath } from "./paths";
import type { BotApi } from "./types";
import { type Harness, fileMode, makeHarness, OWNER_ID, STALE_MS, until } from "./remote.test-helpers";

let h: Harness;
afterEach(async () => {
  await h.cleanup();
});

describe("restart", () => {
  test("the registry and the name to topic binding survive", async () => {
    h = makeHarness();
    const first = h.makeHub();
    const reg = await first.register({ sessionId: "sess-one-0001", project: "/w/app", name: "release" });
    if (!reg.ok) throw new Error("register failed");
    await first.stop();

    const second = h.makeHub();
    expect(second.list().map((s) => [s.name, s.sessionId, s.threadId])).toEqual([["release", "sess-one-0001", reg.threadId]]);

    // The old session is gone by the time the new hub looks again; the new one gets the same topic.
    await h.clock.advance(STALE_MS + 1);
    const again = await second.register({ sessionId: "sess-two-0002", project: "/w/app", name: "release" });
    expect(again).toEqual({ ok: true, name: "release", threadId: reg.threadId, reused: true });
    expect(h.api.topics()).toHaveLength(1);
  });

  test("records that belong to another group are dropped, so a reconnect to a new group does not reuse their topics", async () => {
    h = makeHarness();
    const first = h.makeHub();
    const reg = await first.register({ sessionId: "sess-one-0001", project: "/w/app", name: "release" });
    if (!reg.ok) throw new Error("register failed");
    await first.stop();

    const otherChat = h.config.chatId - 1;
    const otherApi = new FakeBotApi({ chatId: otherChat, now: h.clock.now });
    const otherGroup = h.makeHub({ api: otherApi, config: { ...h.config, chatId: otherChat } });
    expect(otherGroup.list()).toEqual([]);

    await h.clock.advance(STALE_MS + 1);
    const again = await otherGroup.register({ sessionId: "sess-two-0002", project: "/w/app", name: "release" });
    if (!again.ok) throw new Error("register failed");
    expect(again.reused).toBe(false);
    expect(otherApi.topics()).toHaveLength(1);
  });

  test("a session that was live gets a fresh lease period instead of being declared dead off an old stamp", async () => {
    h = makeHarness();
    const first = h.makeHub();
    await first.register({ sessionId: "sess-one-0001", project: "/w/app", name: "release" });
    await first.stop();
    await h.clock.advance(60 * 60_000);

    const second = h.makeHub();
    expect(second.list()[0]?.status).toBe("live");
    await second.start();
    await h.clock.advance(STALE_MS);
    await until(() => second.list()[0]?.status === "unavailable", "unavailable after one silent lease period");
  });

  test("a line that was received but not taken is delivered by the next hub", async () => {
    h = makeHarness();
    const first = h.makeHub();
    const reg = await first.register({ sessionId: "sess-one-0001", project: "/w/app", name: "release" });
    if (!reg.ok) throw new Error("register failed");
    h.refuseDeliveries = true;
    await first.start();
    h.api.pushMessage({ fromId: OWNER_ID, text: "do not lose me", threadId: reg.threadId });
    await until(() => first.events().some((e) => e.type === "delivery-failed"), "failed delivery");
    await first.stop();
    expect(h.deliveries).toEqual([]);

    h.refuseDeliveries = false;
    const second = h.makeHub();
    await second.start();
    await until(() => h.deliveries.length === 1, "delivery by the new hub");
    expect(h.deliveries[0]?.line).toBe("do not lose me");
  });

  test("a crash after delivery and before the ack redelivers once, with the same update id", async () => {
    h = makeHarness();
    const first = h.makeHub({
      beforeAck: () => {
        throw new Error("simulated crash before ack");
      },
    });
    const reg = await first.register({ sessionId: "sess-one-0001", project: "/w/app", name: "release" });
    if (!reg.ok) throw new Error("register failed");
    await first.start();
    const sent = h.api.pushMessage({ fromId: OWNER_ID, text: "once please", threadId: reg.threadId });
    await until(() => h.deliveries.length === 1, "first delivery");
    await first.stop();

    const second = h.makeHub();
    await second.start();
    await until(() => h.deliveries.length === 2, "redelivery");
    expect(h.deliveries.map((d) => d.meta.updateId)).toEqual([sent.update_id, sent.update_id]);

    await h.clock.advance(5_000);
    await second.stop();
    const third = h.makeHub();
    await third.start();
    await h.clock.advance(5_000);
    await until(() => third.pollerStatus().state === "running", "third hub polling");
    expect(h.deliveries).toHaveLength(2);
  });

  test("messages sent while serve was down arrive after it starts", async () => {
    h = makeHarness();
    const first = h.makeHub();
    const reg = await first.register({ sessionId: "sess-one-0001", project: "/w/app", name: "release" });
    if (!reg.ok) throw new Error("register failed");
    await first.stop();

    h.api.pushMessage({ fromId: OWNER_ID, text: "first while away", threadId: reg.threadId });
    h.api.pushMessage({ fromId: OWNER_ID, text: "second while away", threadId: reg.threadId });
    const second = h.makeHub();
    await second.start();
    await until(() => h.deliveries.length === 2, "both delivered");
    expect(h.deliveries.map((d) => d.line)).toEqual(["first while away", "second while away"]);
  });

  test("an update id seen before the restart that Telegram serves again is not delivered twice", async () => {
    h = makeHarness();
    const first = h.makeHub();
    const reg = await first.register({ sessionId: "sess-one-0001", project: "/w/app", name: "release" });
    if (!reg.ok) throw new Error("register failed");
    await first.start();
    const update = h.api.pushMessage({ fromId: OWNER_ID, text: "just once", threadId: reg.threadId });
    await until(() => h.deliveries.length === 1, "delivery");
    await first.stop();

    const second = h.makeHub();
    await second.receive([update]);
    await h.clock.advance(1_000);
    await second.idle();
    expect(h.deliveries).toHaveLength(1);
  });

  test("the poller asks for whatever is unconfirmed after a restart: it sends no offset, because a stored one would be a guess about Telegram numbering", async () => {
    h = makeHarness();
    const offsets: (number | undefined)[] = [];
    const client = h.api.connect("recorder");
    const recording: BotApi = {
      ...client,
      getUpdates: (params) => {
        offsets.push(params.offset);
        return client.getUpdates(params);
      },
    };
    const first = h.makeHub({ api: recording });
    const reg = await first.register({ sessionId: "sess-one-0001", project: "/w/app", name: "release" });
    if (!reg.ok) throw new Error("register failed");
    await first.start();
    const update = h.api.pushMessage({ fromId: OWNER_ID, text: "advance the offset", threadId: reg.threadId });
    await until(() => h.deliveries.length === 1, "delivery");
    await first.stop();

    offsets.length = 0;
    const second = h.makeHub({ api: recording });
    await second.start();
    await until(() => offsets.length > 0, "first poll after restart");
    expect(update.update_id).toBeGreaterThan(0);
    expect(offsets[0]).toBeUndefined();
  });

  test("Telegram restarts its numbering below what was seen: the new lower ids are delivered, not swallowed", async () => {
    h = makeHarness();
    const first = h.makeHub();
    const reg = await first.register({ sessionId: "sess-one-0001", project: "/w/app", name: "release" });
    if (!reg.ok) throw new Error("register failed");
    await first.start();
    const high = h.api.pushMessage({ fromId: OWNER_ID, text: "before the reset", threadId: reg.threadId });
    await until(() => h.deliveries.length === 1, "delivery");
    await first.stop();

    // A new bot token, a restored bot or a Telegram-side reset: the next ids start low again.
    const second = h.makeHub();
    const low = { ...high, update_id: 1 };
    await second.receive([low]);
    await h.clock.advance(1_000);
    await second.idle();
    expect(h.deliveries.map((d) => d.line)).toEqual(["before the reset", "before the reset"]);
    expect(second.events().some((e) => e.type === "poller-status")).toBe(true);
    // The same low id again is a redelivery now, and is dropped.
    await second.receive([low]);
    await second.idle();
    expect(h.deliveries).toHaveLength(2);
  });

  test("unsent outbound text survives a restart and is sent by the next hub", async () => {
    h = makeHarness();
    const first = h.makeHub();
    const reg = await first.register({ sessionId: "sess-one-0001", project: "/w/app", name: "release" });
    if (!reg.ok) throw new Error("register failed");
    h.api.setDown(true);
    expect(await first.send("sess-one-0001", "queued while offline")).toBe(true);
    expect(first.outboundPending()).toBe(1);
    await first.stop();

    h.api.setDown(false);
    const second = h.makeHub();
    expect(second.outboundPending()).toBe(1);
    await second.start();
    await until(() => h.api.sentTo(reg.threadId).some((m) => m.text === "queued while offline"), "outbound flushed");
    expect(second.outboundPending()).toBe(0);
  });

  test("every state file is owner-only", async () => {
    h = makeHarness();
    const hub = h.makeHub();
    const reg = await hub.register({ sessionId: "sess-one-0001", project: "/w/app", name: "release" });
    if (!reg.ok) throw new Error("register failed");
    h.refuseDeliveries = true;
    await hub.start();
    h.api.pushMessage({ fromId: OWNER_ID, text: "queued", threadId: reg.threadId });
    h.api.pushMessage({ fromId: 31337, text: "stranger", threadId: reg.threadId });
    await until(() => hub.events().some((e) => e.type === "delivery-failed"), "queued inbound");
    h.api.setDown(true);
    await hub.send("sess-one-0001", "unsent");
    await hub.stop();

    const root = remoteDirPath(h.dir);
    const inbound = path.join(root, INBOUND_DIRNAME);
    const files = [
      path.join(root, "sessions.json"),
      path.join(root, "poller-state.json"),
      path.join(root, "outbound.jsonl"),
      path.join(root, "rejected.jsonl"),
      ...readdirSync(inbound).map((name) => path.join(inbound, name)),
    ];
    expect(files.length).toBeGreaterThanOrEqual(5);
    for (const file of files) {
      expect(existsSync(file)).toBe(true);
      expect(fileMode(file)).toBe(0o600);
    }
  });
});
