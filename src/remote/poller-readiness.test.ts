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
