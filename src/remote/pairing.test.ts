// AC2, AC3 (flow 377): the only thing the operator types is the bot token; every id comes
// from what Telegram reports. A one-time code, ten minutes, single use: the first PRIVATE
// message that carries it adds its sender to the allowlist, nobody else does.
//
// Everything runs on the in-process fake Bot API and a manual clock: no socket, no outside host.

import { afterEach, describe, expect, test } from "bun:test";
import { FakeBotApi } from "./fake-bot-api";
import { newPairingCode, Pairing, PAIRING_CODE_TTL_MS, type PairingOptions } from "./pairing";
import { ManualClock, settle, until } from "./remote.test-helpers";

const CODE = "K7M2QX9P";
// Ids no fixture shares: if pairing ever fell back on a constant, these would expose it.
const OPERATOR = 90_113_377;
const STRANGER = 31_337_001;

const open: Pairing[] = [];
afterEach(async () => {
  for (const pairing of open.splice(0)) {
    await pairing.cancel();
  }
});

async function openPairing(api: FakeBotApi, clock: ManualClock, extra: Partial<PairingOptions> = {}): Promise<Pairing> {
  const result = await Pairing.open({
    api,
    now: clock.now,
    timers: clock,
    code: CODE,
    pollTimeoutSec: 1,
    pollSleep: () => new Promise<void>((resolve) => setTimeout(resolve, 1)),
    ...extra,
  });
  if (!result.ok) {
    throw new Error(`pairing did not open: ${result.reason}`);
  }
  open.push(result.pairing);
  return result.pairing;
}

describe("opening a pairing needs only the token (the api that holds it)", () => {
  test("a token Telegram does not know is refused before anything is listened to", async () => {
    const api = new FakeBotApi();
    api.setTokenRejected(true);
    const result = await Pairing.open({ api, code: CODE });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe("rejected");
      expect(result.reason).toContain("BotFather");
    }
    expect(api.callCount("getUpdates")).toBe(0);
  });

  test("Telegram unreachable is reported as unreachable, not as a bad token", async () => {
    const api = new FakeBotApi();
    api.setDown(true);
    const result = await Pairing.open({ api, code: CODE });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe("unreachable");
    }
  });

  test("the snapshot names the bot (from getMe), the code and a ten-minute expiry", async () => {
    const api = new FakeBotApi({ botUsername: "somebody_elses_bot" });
    const clock = new ManualClock();
    const pairing = await openPairing(api, clock);
    const snapshot = pairing.snapshot();
    expect(snapshot.state).toBe("waiting-for-user");
    expect(snapshot.code).toBe(CODE);
    expect(snapshot.botUsername).toBe("somebody_elses_bot");
    expect(PAIRING_CODE_TTL_MS).toBe(10 * 60_000);
    expect(snapshot.expiresAt - clock.now()).toBe(10 * 60_000);
    expect(snapshot.userId).toBeUndefined();
    expect(snapshot.chatId).toBeUndefined();
  });

  test("a generated code is eight characters from an unambiguous alphabet and differs between pairings", () => {
    const codes = new Set(Array.from({ length: 50 }, () => newPairingCode()));
    for (const code of codes) {
      expect(code).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$/);
    }
    expect(codes.size).toBeGreaterThan(45);
  });
});

describe("the first private message that carries the code adds its sender", () => {
  test("the sender's id comes from the event, whatever it is", async () => {
    const api = new FakeBotApi();
    const pairing = await openPairing(api, new ManualClock());
    api.pushPrivateMessage({ fromId: OPERATOR, text: CODE });
    await until(() => pairing.snapshot().state === "waiting-for-group", "the code to be taken");
    const snapshot = pairing.snapshot();
    expect(snapshot.userId).toBe(OPERATOR);
    expect(snapshot.code).toBeUndefined();
    // The only reply goes to the sender's own private chat.
    await until(() => api.sent.length === 1, "the confirmation");
    expect(api.sent[0]?.chatId).toBe(OPERATOR);
    expect(api.sent[0]?.messageThreadId).toBeUndefined();
  });

  test("the code is read forgivingly when it is the whole message (case, spaces, a /start prefix)", async () => {
    const api = new FakeBotApi();
    const pairing = await openPairing(api, new ManualClock());
    api.pushPrivateMessage({ fromId: OPERATOR, text: "/start k7m2 qx9p" });
    await until(() => pairing.snapshot().userId === OPERATOR, "a sloppily typed code to be accepted");
  });

  test("a message that merely CONTAINS the code among other words does not pair", async () => {
    const api = new FakeBotApi();
    const pairing = await openPairing(api, new ManualClock());
    api.pushPrivateMessage({ fromId: STRANGER, text: `my code is ${CODE}, let me in` });
    await until(() => api.pendingUpdates().length === 0 || api.callCount("getUpdates") > 2, "the update to be read");
    await settle();
    expect(pairing.snapshot().state).toBe("waiting-for-user");
    expect(pairing.snapshot().userId).toBeUndefined();
    expect(api.sent).toEqual([]);
  });

  test("a FORWARDED message that carries the code does not pair; the operator's own message still does", async () => {
    const api = new FakeBotApi();
    const pairing = await openPairing(api, new ManualClock());
    api.pushPrivateMessage({ fromId: STRANGER, text: CODE, forwarded: true });
    await until(() => api.pendingUpdates().length === 0 || api.callCount("getUpdates") > 2, "the forwarded update to be read");
    await settle();
    expect(pairing.snapshot().userId).toBeUndefined();
    api.pushPrivateMessage({ fromId: OPERATOR, text: CODE });
    await until(() => pairing.snapshot().userId === OPERATOR, "the operator's own message to pair");
  });

  test("a wrong code is ignored without a reply: a stranger learns nothing, not even that a pairing is open", async () => {
    const api = new FakeBotApi();
    const pairing = await openPairing(api, new ManualClock());
    api.pushPrivateMessage({ fromId: STRANGER, text: "ZZZZZZZZ" });
    api.pushPrivateMessage({ fromId: STRANGER, text: "hello" });
    await until(() => api.pendingUpdates().length === 0 || api.callCount("getUpdates") > 2, "the updates to be read");
    await settle();
    expect(pairing.snapshot().state).toBe("waiting-for-user");
    expect(pairing.snapshot().userId).toBeUndefined();
    expect(api.sent).toEqual([]);
  });

  test("a message with the right code in a GROUP does not pair: only a private chat counts", async () => {
    const api = new FakeBotApi();
    const pairing = await openPairing(api, new ManualClock());
    api.pushMessage({ fromId: STRANGER, text: CODE });
    await settle();
    await settle();
    expect(pairing.snapshot().state).toBe("waiting-for-user");
    expect(pairing.snapshot().userId).toBeUndefined();
    expect(api.sent).toEqual([]);
  });

  test("a stranger who messages first with a wrong code does not displace the operator who follows with the right one", async () => {
    const api = new FakeBotApi();
    const pairing = await openPairing(api, new ManualClock());
    api.pushPrivateMessage({ fromId: STRANGER, text: "let me in" });
    api.pushPrivateMessage({ fromId: OPERATOR, text: CODE });
    await until(() => pairing.snapshot().userId === OPERATOR, "the operator to be paired");
  });

  test("the code is single-use: once taken, the same code from anyone else adds nobody", async () => {
    const api = new FakeBotApi();
    const pairing = await openPairing(api, new ManualClock());
    api.pushPrivateMessage({ fromId: OPERATOR, text: CODE });
    await until(() => pairing.snapshot().userId === OPERATOR, "the operator to be paired");
    api.pushPrivateMessage({ fromId: STRANGER, text: CODE });
    await settle();
    await settle();
    expect(pairing.snapshot().userId).toBe(OPERATOR);
    expect(pairing.snapshot().code).toBeUndefined();
    // Only the operator ever got a reply.
    expect(api.sent.every((message) => message.chatId === OPERATOR)).toBe(true);
  });

  test("two messages with the code in one batch: the first sender wins, the second is not added", async () => {
    const api = new FakeBotApi();
    const pairing = await openPairing(api, new ManualClock());
    api.pushPrivateMessage({ fromId: OPERATOR, text: CODE });
    api.pushPrivateMessage({ fromId: STRANGER, text: CODE });
    await until(() => pairing.snapshot().userId !== undefined, "somebody to be paired");
    await settle();
    expect(pairing.snapshot().userId).toBe(OPERATOR);
  });
});

describe("the code lives ten minutes", () => {
  test("just inside the window the code still works", async () => {
    const api = new FakeBotApi();
    const clock = new ManualClock();
    const pairing = await openPairing(api, clock);
    await clock.advance(PAIRING_CODE_TTL_MS - 1_000);
    expect(pairing.snapshot().state).toBe("waiting-for-user");
    api.pushPrivateMessage({ fromId: OPERATOR, text: CODE });
    await until(() => pairing.snapshot().userId === OPERATOR, "a code inside ten minutes to be accepted");
  });

  test("past ten minutes the pairing expires, the code is gone and a late message pairs nobody", async () => {
    const api = new FakeBotApi();
    const clock = new ManualClock();
    const finished: string[] = [];
    const pairing = await openPairing(api, clock, { onFinished: (snapshot) => finished.push(snapshot.state) });
    await clock.advance(PAIRING_CODE_TTL_MS + 1_000);
    expect(pairing.isFinal()).toBe(true);
    expect(pairing.snapshot().state).toBe("expired");
    expect(pairing.snapshot().code).toBeUndefined();
    expect(finished).toEqual(["expired"]);

    api.pushPrivateMessage({ fromId: OPERATOR, text: CODE });
    await settle();
    await settle();
    expect(pairing.snapshot().userId).toBeUndefined();
    expect(api.sent).toEqual([]);
  });

  test("expiry is also seen without the timer: a snapshot taken after the deadline says expired", async () => {
    const api = new FakeBotApi();
    const clock = new ManualClock();
    const pairing = await openPairing(api, clock);
    clock.set(clock.now() + PAIRING_CODE_TTL_MS + 5);
    expect(pairing.snapshot().state).toBe("expired");
  });

  test("an expired pairing stops polling: no poller is left parked on Telegram", async () => {
    const api = new FakeBotApi();
    const clock = new ManualClock();
    const pairing = await openPairing(api, clock);
    await until(() => api.activePollers() === 1, "the pairing to poll");
    await clock.advance(PAIRING_CODE_TTL_MS + 1_000);
    await pairing.stop();
    expect(api.activePollers()).toBe(0);
  });
});

describe("cancel and conflict", () => {
  test("cancelling ends the pairing, drops the code and stops polling", async () => {
    const api = new FakeBotApi();
    const pairing = await openPairing(api, new ManualClock());
    await until(() => api.activePollers() === 1, "the pairing to poll");
    await pairing.cancel();
    expect(pairing.snapshot().state).toBe("cancelled");
    expect(pairing.snapshot().code).toBeUndefined();
    expect(api.activePollers()).toBe(0);
  });

  test("another poller on the same token ends the pairing as failed, with a reason", async () => {
    const api = new FakeBotApi();
    const intruder = api.connect("another-machine");
    const abort = new AbortController();
    const parked = intruder.getUpdates({ timeoutSec: 5, signal: abort.signal }).catch(() => undefined);
    await until(() => api.activePollers() === 1, "the other poller to park");
    const pairing = await openPairing(api, new ManualClock());
    await until(() => pairing.snapshot().state === "failed", "the conflict to be noticed");
    expect(pairing.snapshot().reason).toBeDefined();
    abort.abort();
    await parked;
  });
});
