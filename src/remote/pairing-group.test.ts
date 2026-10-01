// AC4 (flow 377): adding the bot to a group gives the chat id from the event. Serve checks
// that the group is a forum and that the bot may manage topics, and names what is missing.
//
// Unit level on the fake Bot API, then once through the real serve plane and the shell client.

import { afterEach, describe, expect, test } from "bun:test";
import { FakeBotApi } from "./fake-bot-api";
import { Pairing } from "./pairing";
import { makeChannelsRig, pairingState, PAIR_CODE, BOT_TOKEN } from "./channels.test-helpers";
import { ManualClock, OWNER_ID, STRANGER_ID, settle, until } from "./remote.test-helpers";
import type { Rig } from "./remote.http.test-helpers";
import { BotApiError } from "./types";

const CODE = "K7M2QX9P";
const OPERATOR = 90_113_377;
// A group id and a bot id nothing else in the suite uses.
const GROUP = -1_009_876_543_210;
const BOT_ID = 555_000_222;

const open: Pairing[] = [];
let rigToClean: Rig | undefined;
afterEach(async () => {
  for (const pairing of open.splice(0)) {
    await pairing.cancel();
  }
  await rigToClean?.cleanup();
  rigToClean = undefined;
});

async function pairedOperator(api: FakeBotApi): Promise<Pairing> {
  const result = await Pairing.open({
    api,
    timers: new ManualClock(),
    code: CODE,
    pollTimeoutSec: 1,
    pollSleep: () => new Promise<void>((resolve) => setTimeout(resolve, 1)),
  });
  if (!result.ok) {
    throw new Error(result.reason);
  }
  open.push(result.pairing);
  api.pushPrivateMessage({ fromId: OPERATOR, text: CODE });
  await until(() => result.pairing.snapshot().state === "waiting-for-group", "the operator to be paired");
  return result.pairing;
}

describe("the group id comes from the event", () => {
  test("the operator adds the bot to a group: its id and title are taken from Telegram", async () => {
    const api = new FakeBotApi({ chatId: GROUP, botId: BOT_ID });
    const pairing = await pairedOperator(api);
    api.pushMyChatMember({ fromId: OPERATOR, title: "Release room" });
    await until(() => pairing.snapshot().state === "ready", "the group to be accepted");
    const snapshot = pairing.snapshot();
    expect(snapshot.chatId).toBe(GROUP);
    // Telegram's own answer about the chat wins over the title carried in the event.
    expect(snapshot.chatTitle).toBe("Keryx");
    expect(snapshot.problems).toEqual([]);
    expect(snapshot.userId).toBe(OPERATOR);
  });

  test("a group where the bot became an administrator counts as well as one where it became a member", async () => {
    const api = new FakeBotApi({ chatId: GROUP, botId: BOT_ID });
    const pairing = await pairedOperator(api);
    api.pushMyChatMember({ fromId: OPERATOR, status: "administrator" });
    await until(() => pairing.snapshot().state === "ready", "the group to be accepted");
    expect(pairing.snapshot().chatId).toBe(GROUP);
  });
});

describe("what is missing is named", () => {
  test("Topics off: the group is not accepted and the operator is told to turn Topics on", async () => {
    const api = new FakeBotApi({ chatId: GROUP, botId: BOT_ID });
    api.setForum(false);
    const pairing = await pairedOperator(api);
    api.pushMyChatMember({ fromId: OPERATOR });
    await until(() => pairing.snapshot().problems.length > 0, "the problem to be named");
    const snapshot = pairing.snapshot();
    expect(snapshot.state).toBe("waiting-for-group");
    expect(snapshot.chatId).toBeUndefined();
    expect(snapshot.problems).toHaveLength(1);
    expect(snapshot.problems[0]).toContain("Topics");
  });

  test("the bot is only a member: the operator is told to make it an administrator", async () => {
    const api = new FakeBotApi({ chatId: GROUP, botId: BOT_ID });
    api.setBotRights({ canManageTopics: false, status: "member" });
    const pairing = await pairedOperator(api);
    api.pushMyChatMember({ fromId: OPERATOR });
    await until(() => pairing.snapshot().problems.length > 0, "the problem to be named");
    expect(pairing.snapshot().problems).toEqual([expect.stringContaining("administrator")]);
  });

  test("an administrator without the Manage Topics right: the right is named", async () => {
    const api = new FakeBotApi({ chatId: GROUP, botId: BOT_ID });
    api.setBotRights({ canManageTopics: false });
    const pairing = await pairedOperator(api);
    api.pushMyChatMember({ fromId: OPERATOR });
    await until(() => pairing.snapshot().problems.length > 0, "the problem to be named");
    expect(pairing.snapshot().problems).toEqual([expect.stringContaining("Manage Topics")]);
  });

  test("two things wrong are both named at once", async () => {
    const api = new FakeBotApi({ chatId: GROUP, botId: BOT_ID });
    api.setForum(false);
    api.setBotRights({ canManageTopics: false });
    const pairing = await pairedOperator(api);
    api.pushMyChatMember({ fromId: OPERATOR });
    await until(() => pairing.snapshot().problems.length === 2, "both problems to be named");
    const text = pairing.snapshot().problems.join(" ");
    expect(text).toContain("Topics");
    expect(text).toContain("Manage Topics");
  });

  test("the check repeats: after the operator fixes the group, a recheck accepts it", async () => {
    const api = new FakeBotApi({ chatId: GROUP, botId: BOT_ID });
    api.setForum(false);
    api.setBotRights({ canManageTopics: false });
    const pairing = await pairedOperator(api);
    api.pushMyChatMember({ fromId: OPERATOR });
    await until(() => pairing.snapshot().problems.length === 2, "both problems to be named");

    api.setForum(true);
    await pairing.recheck();
    expect(pairing.snapshot().state).toBe("waiting-for-group");
    expect(pairing.snapshot().problems).toHaveLength(1);

    api.setBotRights({ canManageTopics: true });
    await pairing.recheck();
    expect(pairing.snapshot().state).toBe("ready");
    expect(pairing.snapshot().problems).toEqual([]);
    expect(pairing.snapshot().chatId).toBe(GROUP);
  });

  test("a group Telegram cannot be asked about is reported, not accepted", async () => {
    const api = new FakeBotApi({ chatId: GROUP, botId: BOT_ID });
    const pairing = await pairedOperator(api);
    api.failNext("getChat", new BotApiError("network", "getChat: request failed"));
    api.pushMyChatMember({ fromId: OPERATOR });
    await until(() => pairing.snapshot().problems.length > 0, "the failure to be named");
    expect(pairing.snapshot().state).toBe("waiting-for-group");
    expect(pairing.snapshot().problems[0]).toContain("could not inspect the group");
  });
});

describe("a basic group that Topics turn into a supergroup (F-102)", () => {
  // The bot was added to a basic group (old id); turning Topics on gives it a new supergroup id (GROUP).
  const OLD_GROUP = -4_455_667_788;

  test("migrate_to_chat_id on the old chat moves the candidate to the new id", async () => {
    const api = new FakeBotApi({ chatId: GROUP, botId: BOT_ID });
    const pairing = await pairedOperator(api);
    api.pushMyChatMember({ fromId: OPERATOR, chatId: OLD_GROUP, type: "group", title: "Basic" });
    await until(() => pairing.snapshot().problems.length > 0, "the old id to be reported as not inspectable");
    expect(pairing.snapshot().state).toBe("waiting-for-group");

    api.pushMigration({ fromId: OPERATOR, oldChatId: OLD_GROUP, newChatId: GROUP });
    await until(() => pairing.snapshot().state === "ready", "the new supergroup to be accepted");
    expect(pairing.snapshot().chatId).toBe(GROUP);
    expect(pairing.snapshot().problems).toEqual([]);
  });

  test("migrate_from_chat_id on the new chat does the same", async () => {
    const api = new FakeBotApi({ chatId: GROUP, botId: BOT_ID });
    const pairing = await pairedOperator(api);
    api.pushMyChatMember({ fromId: OPERATOR, chatId: OLD_GROUP, type: "group" });
    await until(() => pairing.snapshot().problems.length > 0, "the old id to be reported as not inspectable");

    api.pushMigration({ fromId: OPERATOR, oldChatId: OLD_GROUP, newChatId: GROUP, side: "from" });
    await until(() => pairing.snapshot().state === "ready", "the new supergroup to be accepted");
    expect(pairing.snapshot().chatId).toBe(GROUP);
  });

  test("the group event and the migration both arrive before the code: the candidate ends on the new id", async () => {
    const api = new FakeBotApi({ chatId: GROUP, botId: BOT_ID });
    const pairing = await openPairing(api);
    api.pushMyChatMember({ fromId: OPERATOR, chatId: OLD_GROUP, type: "group", title: "Basic" });
    api.pushMigration({ fromId: OPERATOR, oldChatId: OLD_GROUP, newChatId: GROUP });
    await settle();
    await settle();
    expect(pairing.snapshot().state).toBe("waiting-for-user");
    expect(api.callCount("getChat")).toBe(0);

    api.pushPrivateMessage({ fromId: OPERATOR, text: CODE });
    await until(() => pairing.snapshot().state === "ready", "the new supergroup to be accepted after the replay");
    expect(pairing.snapshot().chatId).toBe(GROUP);
    expect(pairing.snapshot().problems).toEqual([]);
  });

  test("a migration of some other chat does not move the candidate", async () => {
    const api = new FakeBotApi({ chatId: GROUP, botId: BOT_ID });
    const pairing = await pairedOperator(api);
    api.pushMyChatMember({ fromId: OPERATOR, chatId: OLD_GROUP, type: "group" });
    await until(() => pairing.snapshot().problems.length > 0, "the old id to be reported as not inspectable");
    const inspected = api.callCount("getChat");

    api.pushMigration({ fromId: STRANGER_ID, oldChatId: -999_000_111, newChatId: GROUP });
    api.pushMigration({ fromId: STRANGER_ID, oldChatId: -999_000_111, newChatId: GROUP, side: "from" });
    await settle();
    await settle();
    expect(api.callCount("getChat")).toBe(inspected);
    expect(pairing.snapshot().state).toBe("waiting-for-group");
    expect(pairing.snapshot().chatId).toBeUndefined();
  });
});

describe("only the paired operator can nominate a group", () => {
  test("a stranger adding the bot to a group is ignored", async () => {
    const api = new FakeBotApi({ chatId: GROUP, botId: BOT_ID });
    const pairing = await pairedOperator(api);
    api.pushMyChatMember({ fromId: STRANGER_ID });
    await settle();
    await settle();
    expect(pairing.snapshot().state).toBe("waiting-for-group");
    expect(pairing.snapshot().chatId).toBeUndefined();
    expect(pairing.snapshot().problems).toEqual([]);
    expect(api.callCount("getChat")).toBe(0);
  });

  test("before anybody is paired, a group event nominates nothing yet", async () => {
    const api = new FakeBotApi({ chatId: GROUP, botId: BOT_ID });
    const pairing = await openPairing(api);
    api.pushMyChatMember({ fromId: OPERATOR });
    await settle();
    await settle();
    expect(pairing.snapshot().state).toBe("waiting-for-user");
    expect(api.callCount("getChat")).toBe(0);
  });

  test("the bot leaving a group, or being added to a private chat, nominates nothing", async () => {
    const api = new FakeBotApi({ chatId: GROUP, botId: BOT_ID });
    const pairing = await pairedOperator(api);
    api.pushMyChatMember({ fromId: OPERATOR, status: "left" });
    api.pushMyChatMember({ fromId: OPERATOR, type: "private" });
    await settle();
    await settle();
    expect(pairing.snapshot().state).toBe("waiting-for-group");
    expect(api.callCount("getChat")).toBe(0);
  });
});

async function openPairing(api: FakeBotApi, extra: { clock?: ManualClock; ttlMs?: number } = {}): Promise<Pairing> {
  const clock = extra.clock ?? new ManualClock();
  const result = await Pairing.open({
    api,
    timers: clock,
    now: clock.now,
    code: CODE,
    ...(extra.ttlMs === undefined ? {} : { ttlMs: extra.ttlMs }),
    pollTimeoutSec: 1,
    pollSleep: () => new Promise<void>((resolve) => setTimeout(resolve, 1)),
  });
  if (!result.ok) {
    throw new Error(result.reason);
  }
  open.push(result.pairing);
  return result.pairing;
}

/** The same fake, except that getChat waits until `release` is called. */
function slowGetChat(api: FakeBotApi): { wrapped: FakeBotApi; release: () => void; entered: () => boolean } {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered = false;
  const wrapped = new Proxy(api, {
    get(target, prop) {
      if (prop === "getChat") {
        return async (params: { chatId: number }) => {
          entered = true;
          await gate;
          return target.getChat(params);
        };
      }
      const value = Reflect.get(target, prop, target) as unknown;
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
  return { wrapped, release, entered: () => entered };
}

describe("a bot that was added to the group before the code was sent", () => {
  test("the paired operator's earlier event is used: no second event is needed", async () => {
    const api = new FakeBotApi({ chatId: GROUP, botId: BOT_ID });
    const pairing = await openPairing(api);
    api.pushMyChatMember({ fromId: OPERATOR, title: "Early group" });
    await settle();
    api.pushPrivateMessage({ fromId: OPERATOR, text: CODE });
    await until(() => pairing.snapshot().state === "ready", "the early group event to be replayed");
    expect(pairing.snapshot().chatId).toBe(GROUP);
    expect(pairing.snapshot().userId).toBe(OPERATOR);
  });

  test("an earlier event from somebody else is still ignored", async () => {
    const api = new FakeBotApi({ chatId: GROUP, botId: BOT_ID });
    const pairing = await openPairing(api);
    api.pushMyChatMember({ fromId: STRANGER_ID });
    await settle();
    api.pushPrivateMessage({ fromId: OPERATOR, text: CODE });
    await until(() => pairing.snapshot().state === "waiting-for-group", "the operator to be paired");
    await settle();
    expect(pairing.snapshot().state).toBe("waiting-for-group");
    expect(api.callCount("getChat")).toBe(0);
  });
});

describe("a pairing that has ended does not come back", () => {
  test("cancelled while Telegram is still answering about the group: it stays cancelled", async () => {
    const api = new FakeBotApi({ chatId: GROUP, botId: BOT_ID });
    const slow = slowGetChat(api);
    const pairing = await openPairing(slow.wrapped);
    api.pushPrivateMessage({ fromId: OPERATOR, text: CODE });
    await until(() => pairing.snapshot().state === "waiting-for-group", "the operator to be paired");
    api.pushMyChatMember({ fromId: OPERATOR });
    await until(() => slow.entered(), "the group check to start");
    const cancelling = pairing.cancel();
    await settle();
    expect(pairing.snapshot().state).toBe("cancelled");
    slow.release();
    await cancelling;
    await settle();
    expect(pairing.snapshot().state).toBe("cancelled");
    expect(pairing.snapshot().chatId).toBeUndefined();
  });

  test("expired while Telegram is still answering about the group: it stays expired", async () => {
    const api = new FakeBotApi({ chatId: GROUP, botId: BOT_ID });
    const slow = slowGetChat(api);
    const clock = new ManualClock();
    const pairing = await openPairing(slow.wrapped, { clock, ttlMs: 60_000 });
    api.pushPrivateMessage({ fromId: OPERATOR, text: CODE });
    await until(() => pairing.snapshot().state === "waiting-for-group", "the operator to be paired");
    api.pushMyChatMember({ fromId: OPERATOR });
    await until(() => slow.entered(), "the group check to start");
    await clock.advance(61_000);
    expect(pairing.snapshot().state).toBe("expired");
    slow.release();
    await settle();
    await settle();
    expect(pairing.snapshot().state).toBe("expired");
    expect(pairing.snapshot().chatId).toBeUndefined();
  });
});

describe("the group step has its own time", () => {
  test("a code sent late in its life still leaves the whole group step", async () => {
    const api = new FakeBotApi({ chatId: GROUP, botId: BOT_ID });
    const clock = new ManualClock();
    const pairing = await openPairing(api, { clock, ttlMs: 60_000 });
    await clock.advance(50_000);
    api.pushPrivateMessage({ fromId: OPERATOR, text: CODE });
    await until(() => pairing.snapshot().state === "waiting-for-group", "the operator to be paired");
    await clock.advance(50_000);
    expect(pairing.snapshot().state).toBe("waiting-for-group");
    await clock.advance(20_000);
    expect(pairing.snapshot().state).toBe("expired");
  });
});

describe("through serve and the shell client", () => {
  test("a group that is not a forum is reported by serve with the problem named; fixing it and asking again finishes", async () => {
    const r = await makeChannelsRig();
    rigToClean = r.rig;
    r.rig.api.setForum(false);

    const started = await r.client.startPairing(BOT_TOKEN);
    expect(started.ok).toBe(true);
    r.rig.api.pushPrivateMessage({ fromId: OWNER_ID, text: PAIR_CODE });
    await until(async () => (await pairingState(r.client)).state === "waiting-for-group", "the operator to be paired");

    r.rig.api.pushMyChatMember({ fromId: OWNER_ID, title: "Keryx" });
    await until(async () => (await pairingState(r.client)).problems.length > 0, "serve to name what is missing");
    const blocked = await pairingState(r.client);
    expect(blocked.state).toBe("waiting-for-group");
    expect(blocked.problems.join(" ")).toContain("Topics");
    expect(blocked.chatId).toBeUndefined();

    // The id of the group is whatever Telegram reported, not something typed.
    r.rig.api.setForum(true);
    const ready = await pairingState(r.client);
    expect(ready.state).toBe("ready");
    expect(ready.chatId).toBe(r.rig.api.chatId);
    expect(ready.userId).toBe(OWNER_ID);
  });
});
