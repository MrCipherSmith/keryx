// AC5: exactly one getUpdates poller per bot token. A second poller learns of
// it through 409, stops, makes no further call, and says why without the token.

import { afterEach, describe, expect, test } from "bun:test";
import { createHttpBotApi } from "./bot-api-http";
import { FakeBotApi } from "./fake-bot-api";
import { type PollerStatus, POLLER_CONFLICT_REASON, UpdatePoller } from "./poller";
import { BotApiError, type BotUpdate } from "./types";
import { type Harness, makeHarness, OWNER_ID, settle, until } from "./remote.test-helpers";

const FAKE_TOKEN = "7123456789:AAFakeTokenForPollerTests_abcdefghij";

const harnesses: Harness[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) {
    await h.cleanup();
  }
});

function track(h: Harness): Harness {
  harnesses.push(h);
  return h;
}

describe("single poller per token", () => {
  test("a second serve on the same token stops on 409 and never polls again", async () => {
    const first = track(makeHarness());
    const second = track(makeHarness({ api: first.api, clock: first.clock }));
    const secondClient = first.api.connect("second-serve");

    const owner = first.makeHub({ pollTimeoutSec: 30 });
    await owner.start();
    await until(() => first.api.activePollers() === 1, "owner parked in getUpdates");

    const statuses: PollerStatus[] = [];
    const intruder = second.makeHub({ api: secondClient, onPollerStatus: (s) => statuses.push(s) });
    await intruder.start();
    await until(() => intruder.pollerStatus().state === "conflict", "conflict detected");

    const status = intruder.pollerStatus();
    expect(status.reason).toBe(POLLER_CONFLICT_REASON);
    expect(status.reason).toContain("409");
    expect(status.reason).toContain("only one `keryx serve`");
    expect(statuses.at(-1)?.state).toBe("conflict");

    const callsAtConflict = first.api.callCount("getUpdates", "second-serve");
    expect(callsAtConflict).toBe(1);
    await settle();
    await first.clock.advance(120_000);
    expect(first.api.callCount("getUpdates", "second-serve")).toBe(callsAtConflict);
    expect(second.sleeps).toEqual([]);
  });

  test("the owner keeps receiving while the intruder is refused", async () => {
    const first = track(makeHarness());
    const second = track(makeHarness({ api: first.api, clock: first.clock }));
    const owner = first.makeHub({ pollTimeoutSec: 30 });
    const reg = await owner.register({ sessionId: "sess-one-0001", project: "/w/app" });
    if (!reg.ok) throw new Error("register failed");
    await owner.start();
    await until(() => first.api.activePollers() === 1, "owner parked");
    const intruder = second.makeHub({ api: first.api.connect("second-serve") });
    await intruder.start();
    await until(() => intruder.pollerStatus().state === "conflict", "conflict");

    first.api.pushMessage({ fromId: OWNER_ID, text: "still here", threadId: reg.threadId });
    await until(() => first.deliveries.length === 1, "owner delivery");
    expect(second.deliveries).toEqual([]);
    expect(owner.pollerStatus().state).toBe("running");
  });

  test("a conflict is terminal: restarting the poller does not resume it", async () => {
    const api = new FakeBotApi();
    const rival = api.connect("rival");
    const controller = new AbortController();
    const parked = rival.getUpdates({ timeoutSec: 30, signal: controller.signal });
    await until(() => api.activePollers() === 1, "rival parked");

    const poller = new UpdatePoller({
      api,
      sink: { highWater: () => 0, accept: async () => undefined },
    });
    poller.start();
    await poller.whenStopped();
    expect(poller.status().state).toBe("conflict");
    poller.start();
    await settle();
    expect(api.callCount("getUpdates", "default")).toBe(1);

    controller.abort();
    await parked.catch(() => undefined);
  });

  test("the conflict reason is built from the HTTP client's 409 and carries no token", async () => {
    const calls: string[] = [];
    const stub = async (input: Parameters<typeof fetch>[0]): Promise<Response> => {
      calls.push(String(input));
      return new Response(
        JSON.stringify({
          ok: false,
          error_code: 409,
          description: `Conflict: terminated by other getUpdates request (bot${FAKE_TOKEN})`,
        }),
        { status: 409 },
      );
    };
    const api = createHttpBotApi({ token: FAKE_TOKEN, baseUrl: "http://bot-api.invalid", fetchImpl: stub as typeof fetch });
    const poller = new UpdatePoller({ api, sink: { highWater: () => 0, accept: async () => undefined } });
    poller.start();
    await poller.whenStopped();

    expect(calls).toHaveLength(1);
    const status = poller.status();
    expect(status.state).toBe("conflict");
    expect(JSON.stringify(status)).not.toContain(FAKE_TOKEN);
    expect(JSON.stringify(status)).not.toContain("AAFakeTokenForPollerTests");
  });
});

describe("poller loop", () => {
  const update = (id: number): BotUpdate => ({ update_id: id });

  test("asks for the offset after the sink's high-water mark and advances only after accept", async () => {
    const offsets: (number | undefined)[] = [];
    let mark = 10;
    let served = 0;
    const controller = { stop: undefined as undefined | (() => Promise<void>) };
    const api = {
      getUpdates: async (params: { offset?: number }) => {
        offsets.push(params.offset);
        served += 1;
        if (served === 1) return [update(11), update(12)];
        // Abort from inside the call (stop() aborts first); do not await it, the loop is awaiting us.
        void controller.stop?.();
        return [];
      },
    } as unknown as ConstructorParameters<typeof UpdatePoller>[0]["api"];
    const poller = new UpdatePoller({
      api,
      sink: {
        highWater: () => mark,
        accept: async (updates) => {
          mark = Math.max(...updates.map((u) => u.update_id));
        },
      },
    });
    controller.stop = () => poller.stop();
    poller.start();
    await poller.whenStopped();
    expect(offsets.slice(0, 2)).toEqual([11, 13]);
  });

  test("a sink that throws does not advance the offset: the same updates are served again", async () => {
    const api = new FakeBotApi();
    api.pushMessage({ fromId: OWNER_ID, text: "one", threadId: 1 });
    let attempts = 0;
    const seen: number[][] = [];
    let mark = 0;
    const sleeps: number[] = [];
    const poller = new UpdatePoller({
      api,
      timeoutSec: 0,
      sleep: async (ms) => {
        sleeps.push(ms);
        await settle();
      },
      backoffMs: [7],
      sink: {
        highWater: () => mark,
        accept: async (updates) => {
          attempts += 1;
          seen.push(updates.map((u) => u.update_id));
          if (attempts === 1) throw new Error("disk full");
          mark = Math.max(...updates.map((u) => u.update_id));
        },
      },
    });
    poller.start();
    await until(() => attempts >= 2, "second attempt");
    await poller.stop();
    expect(seen[0]).toEqual(seen[1] ?? []);
    expect(sleeps[0]).toBe(7);
  });

  test("429 waits retry_after seconds, then carries on", async () => {
    const api = new FakeBotApi();
    api.rateLimitNext("getUpdates", 3);
    const sleeps: number[] = [];
    const poller = new UpdatePoller({
      api,
      timeoutSec: 0,
      sleep: async (ms) => {
        sleeps.push(ms);
        await settle();
      },
      sink: { highWater: () => 0, accept: async () => undefined },
    });
    poller.start();
    await until(() => api.callCount("getUpdates") >= 2, "second call after the wait");
    await poller.stop();
    expect(sleeps[0]).toBe(3_000);
    expect(poller.status().state).not.toBe("conflict");
  });

  test("a network error backs off and recovers", async () => {
    const api = new FakeBotApi();
    api.failNext("getUpdates", new BotApiError("network", "getUpdates: request failed"), 2);
    const sleeps: number[] = [];
    const poller = new UpdatePoller({
      api,
      timeoutSec: 0,
      backoffMs: [5, 10],
      sleep: async (ms) => {
        sleeps.push(ms);
        await settle();
      },
      sink: { highWater: () => 0, accept: async () => undefined },
    });
    poller.start();
    await until(() => api.callCount("getUpdates") >= 4, "recovery");
    await poller.stop();
    expect(sleeps.slice(0, 2)).toEqual([5, 10]);
  });
});
