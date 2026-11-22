import { expect, test } from "bun:test";
import { FakeBotApi } from "./fake-bot-api";
import { UpdatePoller } from "./poller";
import { BotApiError } from "./types";

test("readiness waits for a successful runtime response, including an empty batch", async () => {
  const api = new FakeBotApi();
  let release: (() => void) | undefined;
  api.getUpdates = async () => { await new Promise<void>((resolve) => { release = resolve; }); return []; };
  const poller = new UpdatePoller({ api, sink: { accept: async () => {} }, timeoutSec: 0 });
  poller.start();
  const ready = poller.waitForReady(1000);
  expect(await poller.waitForReady(1)).toBe(false);
  release?.();
  expect(await ready).toBe(true);
  await poller.stop();
});

test("a failed first poll cannot later be mistaken for readiness", async () => {
  const api = new FakeBotApi();
  api.getUpdates = async () => { throw new BotApiError("conflict", "conflict"); };
  const poller = new UpdatePoller({ api, sink: { accept: async () => {} } });
  poller.start();
  expect(await poller.waitForReady(1000)).toBe(false);
  await poller.stop();
});
test("the first batch is held until admission, and abandoned batches are never accepted", async () => {
  for (const activate of [true, false]) {
    const api = new FakeBotApi();
    const accepted: number[] = [];
    let release: (() => void) | undefined;
    let confirm!: (offset: number | undefined) => void;
    const confirmation = new Promise<number | undefined>((resolve) => { confirm = resolve; });
    let calls = 0;
    api.getUpdates = async ({ offset, signal }) => {
      calls += 1;
      if (calls === 1) return [{ update_id: 42 }];
      confirm(offset);
      return await new Promise((resolve) => { signal?.addEventListener("abort", () => resolve([]), { once: true }); });
    };
    const poller = new UpdatePoller({ api, sink: { accept: async (updates) => { accepted.push(...updates.map((update) => update.update_id)); } },
      holdAfterFirstResponse: (signal) => new Promise<void>((resolve) => {
        release = resolve;
        signal.addEventListener("abort", () => resolve(), { once: true });
      }),
    });
    poller.start();
    try {
      expect(await poller.waitForReady(1000)).toBe(true);
      expect(accepted).toEqual([]);
      if (activate) {
        release?.();
        expect(await confirmation).toBe(43);
        expect(accepted).toEqual([42]);
      }
    } finally {
      await poller.stop();
    }
    if (!activate) {
      expect(calls).toBe(1);
      expect(accepted).toEqual([]);
    }
  }
});
