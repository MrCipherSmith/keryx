// Flow 387 review L-3: in a group with several bots a command carries the bot it is for
// (`/model@otherbot`). The hub learns its own username from getMe and does not route a command
// addressed to another bot to the session; this bot's own suffix, no suffix and plain text still go through.

import { afterEach, describe, expect, test } from "bun:test";
import { FakeBotApi } from "./fake-bot-api";
import { type Harness, makeHarness, ManualClock, OWNER_ID, until } from "./remote.test-helpers";
import { BotApiError } from "./types";

let h: Harness;
afterEach(async () => {
  await h.cleanup();
});

async function setup(api?: FakeBotApi) {
  const clock = new ManualClock();
  h = makeHarness({ clock, api: api ?? new FakeBotApi({ now: clock.now, botUsername: "keryx_test_bot" }) });
  const hub = h.makeHub();
  const reg = await hub.register({ sessionId: "sess-addr-0001", project: "/w/app", name: "release" });
  if (!reg.ok) throw new Error("register failed");
  await hub.start();
  return { hub, threadId: reg.threadId };
}

async function consumed(): Promise<void> {
  await until(() => h.api.pendingUpdates().length === 0, "every update to be consumed");
}

describe("a command addressed to another bot (L-3)", () => {
  test("is not routed to the session, and the event says why", async () => {
    const { hub, threadId } = await setup();
    h.api.pushMessage({ fromId: OWNER_ID, text: "/model@someotherbot", threadId });
    h.api.pushMessage({ fromId: OWNER_ID, text: "/status", threadId });
    await until(() => h.deliveries.length === 1, "the plain command");
    await consumed();
    expect(h.deliveries.map((d) => d.line)).toEqual(["/status"]);
    expect(hub.events().some((event) => event.type === "update-unrouted" && (event.detail ?? "").includes("another bot"))).toBe(true);
  });

  test("this bot's own suffix, in any case, still runs", async () => {
    const { threadId } = await setup();
    h.api.pushMessage({ fromId: OWNER_ID, text: "/status@Keryx_Test_Bot", threadId });
    h.api.pushMessage({ fromId: OWNER_ID, text: "/doctor@keryx_test_bot now", threadId });
    await until(() => h.deliveries.length === 2, "both commands");
    expect(h.deliveries.map((d) => d.line)).toEqual(["/status@Keryx_Test_Bot", "/doctor@keryx_test_bot now"]);
  });

  test("when getMe fails the bot's name is unknown and no command is dropped", async () => {
    const clock = new ManualClock();
    const api = new FakeBotApi({ now: clock.now, botUsername: "keryx_test_bot" });
    api.failNext("getMe", new BotApiError("network", "connection reset"));
    const { threadId } = await setup(api);
    h.api.pushMessage({ fromId: OWNER_ID, text: "/model@someotherbot", threadId });
    await until(() => h.deliveries.length === 1, "the command, delivered because the name is unknown");
  });
});
