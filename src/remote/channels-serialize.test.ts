// Flow 377 review round 1: pair, reload and disconnect run one at a time, a superseded pairing
// is cancelled, and a reload that cannot start leaves a running channel alone.
//
// The controller on a fake host and the in-process fake Bot API; no serve, no socket.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "bun:test";
import { ChannelsController, type ChannelsHost } from "./channels";
import { DEFAULT_ORPHAN_MS, DEFAULT_RUN_TIMEOUT_MS, REMOTE_CONFIG_SCHEMA_VERSION, saveBotToken, saveRemoteConfig } from "./config";
import { FakeBotApi } from "./fake-bot-api";
import type { RemoteHub } from "./hub";
import { until } from "./remote.test-helpers";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

class GatedApi extends FakeBotApi {
  private gates: Array<() => void> = [];
  private gateCalls = 0;
  constructor(private readonly gatedCalls: number) {
    super();
  }
  release(): void {
    for (const gate of this.gates.splice(0)) {
      gate();
    }
  }
  override async getMe(): ReturnType<FakeBotApi["getMe"]> {
    this.gateCalls += 1;
    if (this.gateCalls <= this.gatedCalls) {
      await new Promise<void>((resolve) => this.gates.push(resolve));
    }
    return super.getMe();
  }
  get waiting(): number {
    return this.gates.length;
  }
}

async function makeHost(api: FakeBotApi, extra: Partial<ChannelsHost> = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "keryx-channels-serialize-"));
  dirs.push(dir);
  const calls = { stop: 0, start: 0 };
  const host: ChannelsHost = {
    dir,
    machine: "devbox",
    hub: () => undefined,
    hubReason: () => undefined,
    startHub: async () => {
      calls.start += 1;
      return { ok: true };
    },
    stopHub: async () => {
      calls.stop += 1;
    },
    settle: async () => undefined,
    openApi: () => ({ ok: true, api }),
    ...extra,
  };
  return { host, calls, dir };
}

const request = new Request("http://127.0.0.1/");
const errorCode = async (response: Response): Promise<string | undefined> => ((await response.json()) as { error?: { code?: string } }).error?.code;

test("a pairing that was cancelled while it was starting does not come up afterwards", async () => {
  const api = new GatedApi(1);
  const { host } = await makeHost(api);
  const controller = new ChannelsController({ host });
  const pending = controller.handle("channels-pair", request);
  await until(() => api.waiting === 1, "getMe to be in flight");

  await controller.handle("channels-cancel", request);
  api.release();
  const response = await pending;

  expect(response.status).toBe(409);
  expect(await errorCode(response)).toBe("superseded");
  expect((await controller.handle("channels-pairing", request)).status).toBe(404);
  await until(() => api.activePollers() === 0, "no poller left behind");
  await controller.stop();
});

test("two pairs at once: the first is superseded, the second runs, and only one poller exists", async () => {
  const api = new GatedApi(1);
  const { host } = await makeHost(api);
  const controller = new ChannelsController({ host });
  const first = controller.handle("channels-pair", request);
  await until(() => api.waiting === 1, "the first getMe to be in flight");
  const second = controller.handle("channels-pair", request);

  api.release();
  const [a, b] = await Promise.all([first, second]);

  expect(a.status).toBe(409);
  expect(b.status).toBe(200);
  await until(() => api.activePollers() === 1, "exactly one poller");
  expect((await controller.handle("channels-pairing", request)).status).toBe(200);
  await controller.stop();
  await until(() => api.activePollers() === 0, "the poller to stop");
});

test("a pair queued behind a disconnect is superseded by it", async () => {
  const api = new GatedApi(0);
  const { host } = await makeHost(api);
  const controller = new ChannelsController({ host });
  const pair = controller.handle("channels-pair", request);
  const disconnect = controller.handle("channels-disconnect", request);
  const [paired, disconnected] = await Promise.all([pair, disconnect]);
  expect(paired.status).toBe(409);
  expect(disconnected.status).toBe(200);
  expect(api.activePollers()).toBe(0);
  await controller.stop();
});

test("a reload that cannot start leaves the running hub alone", async () => {
  const hub = {} as RemoteHub;
  const api = new FakeBotApi();
  // No token and no config are on disk: the new hub could not start.
  const { host, calls } = await makeHost(api, { hub: () => hub });
  const controller = new ChannelsController({ host });

  const response = await controller.handle("channels-reload", request);

  expect(response.status).toBe(422);
  expect(await errorCode(response)).toBe("cannot-connect");
  expect(calls.stop).toBe(0);
  expect(calls.start).toBe(0);
  await controller.stop();
});

test("a disconnect issued while a start is in flight waits for it and then stops the hub that came up", async () => {
  const api = new FakeBotApi();
  let running: RemoteHub | undefined;
  let finishStart: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    finishStart = resolve;
  });
  let starting: Promise<unknown> = Promise.resolve();
  const deleted = { count: 0 };
  const fakeHub = {
    deleteAllTopics: async () => {
      deleted.count += 1;
      return { deleted: 1, remaining: 0 };
    },
  } as unknown as RemoteHub;
  const { host, calls } = await makeHost(api, {
    hub: () => running,
    startHub: async () => {
      starting = (async () => {
        await gate;
        running = fakeHub;
      })();
      await starting;
      return { ok: true };
    },
    stopHub: async () => {
      calls.stop += 1;
      running = undefined;
    },
    settle: async () => {
      await starting;
    },
  });
  const controller = new ChannelsController({ host });
  void host.startHub();
  const disconnect = controller.handle("channels-disconnect", request);
  await new Promise((resolve) => setTimeout(resolve, 5));
  expect(calls.stop).toBe(0);

  finishStart();
  const response = await disconnect;

  expect(response.status).toBe(200);
  expect(deleted.count).toBe(1);
  expect(calls.stop).toBe(1);
  expect(running).toBeUndefined();
  await controller.stop();
});

test("a pairing closed while its status is being checked answers no-pairing, not a stale snapshot", async () => {
  const api = new FakeBotApi();
  const { host } = await makeHost(api);
  const controller = new ChannelsController({ host });
  expect((await controller.handle("channels-pair", request)).status).toBe(200);
  const checking = controller.handle("channels-pairing", request);
  await controller.handle("channels-cancel", request);
  expect((await checking).status).toBe(404);
  await controller.stop();
});

// ---- review follow-ups: F-107 (ready pairing is resumable) and F-109 (a bad token keeps the pairing) ----

const CODE = "K7M2QX9P";
const OPERATOR = 90_113_377;
const fastPairing = { code: CODE, pollTimeoutSec: 1, pollSleep: () => new Promise<void>((resolve) => setTimeout(resolve, 1)) };
const statusState = async (controller: ChannelsController): Promise<string> =>
  ((await (await controller.handle("channels-status", request)).json()) as { telegram: { state: string } }).telegram.state;
const pairingSnapshot = async (controller: ChannelsController): Promise<{ status: number; state?: string }> => {
  const response = await controller.handle("channels-pairing", request);
  return { status: response.status, ...(response.ok ? { state: ((await response.json()) as { state: string }).state } : {}) };
};

test("F-107: a pairing that reached ready is reported as a pairing until a reload consumes it", async () => {
  const api = new FakeBotApi();
  let running: RemoteHub | undefined;
  const { host, dir } = await makeHost(api, {
    hub: () => running,
    startHub: async () => {
      running = { list: () => [] } as unknown as RemoteHub;
      return { ok: true };
    },
  });
  const controller = new ChannelsController({ host, pairing: fastPairing });
  expect((await controller.handle("channels-pair", request)).status).toBe(200);
  api.pushPrivateMessage({ fromId: OPERATOR, text: CODE });
  await until(async () => (await pairingSnapshot(controller)).state === "waiting-for-group", "the operator to be paired");
  api.pushMyChatMember({ fromId: OPERATOR });
  await until(async () => (await pairingSnapshot(controller)).state === "ready", "the group to be accepted");

  // Nobody connected it (the modal was closed): the controller still says "pairing", so the modal offers Resume.
  expect(await statusState(controller)).toBe("pairing");
  expect(await pairingSnapshot(controller)).toEqual({ status: 200, state: "ready" });

  // What connectFinish does: write the files, then reload. Reload consumes the pairing.
  expect(saveBotToken("123456:AAHunit_followup_token_0123456789", dir).ok).toBe(true);
  expect(
    saveRemoteConfig(
      { schemaVersion: REMOTE_CONFIG_SCHEMA_VERSION, chatId: api.chatId, allowedUserIds: [OPERATOR], orphanMs: DEFAULT_ORPHAN_MS, runTimeoutMs: DEFAULT_RUN_TIMEOUT_MS },
      dir,
    ).ok,
  ).toBe(true);
  expect((await controller.handle("channels-reload", request)).status).toBe(200);
  expect(await statusState(controller)).toBe("connected");
  expect((await pairingSnapshot(controller)).status).toBe(404);
  await controller.stop();
});

test("F-109: a token Telegram rejects leaves the pairing in progress untouched and its code still usable", async () => {
  const good = new FakeBotApi();
  const bad = new FakeBotApi();
  bad.setTokenRejected(true);
  let current: FakeBotApi = good;
  const { host } = await makeHost(good, { openApi: () => ({ ok: true, api: current }) });
  const controller = new ChannelsController({ host, pairing: fastPairing });
  expect((await controller.handle("channels-pair", request)).status).toBe(200);
  await until(() => good.activePollers() === 1, "the first pairing to poll");

  current = bad;
  const refused = await controller.handle("channels-pair", request);
  expect(refused.status).toBe(422);
  expect(await errorCode(refused)).toBe("token-rejected");

  // The pairing that was open is still open: same state, still polling, and its code still pairs the operator.
  expect(await statusState(controller)).toBe("pairing");
  expect(await pairingSnapshot(controller)).toEqual({ status: 200, state: "waiting-for-user" });
  expect(good.activePollers()).toBe(1);
  good.pushPrivateMessage({ fromId: OPERATOR, text: CODE });
  await until(async () => (await pairingSnapshot(controller)).state === "waiting-for-group", "the old code to still work");
  await controller.stop();
});

test("F-109: a valid new token replaces the pairing, and the old poller is gone before the new one runs", async () => {
  // ONE bot (one token): the two pairings are two clients over the same state, so a second getUpdates
  // while the first is still in flight is a 409 and would fail the new pairing.
  const api = new FakeBotApi();
  const clients = [api.connect("first"), api.connect("second")];
  let opened = 0;
  const { host } = await makeHost(api, { openApi: () => ({ ok: true, api: clients[Math.min(opened++, clients.length - 1)]! }) });
  const controller = new ChannelsController({ host, pairing: fastPairing });
  let most = 0;
  const sampler = setInterval(() => {
    most = Math.max(most, api.activePollers());
  }, 1);
  try {
    expect((await controller.handle("channels-pair", request)).status).toBe(200);
    await until(() => api.callCount("getUpdates", "first") > 0, "the first pairing to poll");

    expect((await controller.handle("channels-pair", request)).status).toBe(200);
    await until(() => api.callCount("getUpdates", "second") > 0, "the new pairing to poll");
    // Give the new poller a few rounds: a conflict with a poller that was not ended first shows up as a failed pairing.
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(api.callCount("getMe", "first")).toBe(1);
    expect(api.callCount("getMe", "second")).toBe(1);
    expect(most).toBeLessThanOrEqual(1);
    expect(await pairingSnapshot(controller)).toEqual({ status: 200, state: "waiting-for-user" });
    const calls = api.calls.filter((call) => call.method === "getUpdates");
    expect(calls.at(-1)?.label).toBe("second");
  } finally {
    clearInterval(sampler);
    await controller.stop();
  }
});

test("a reload whose files do not validate leaves a live pairing running", async () => {
  const api = new FakeBotApi();
  // Nothing on disk: the reload cannot succeed, as when a second shell with a stale "off" snapshot presses Retry.
  const { host, calls } = await makeHost(api);
  const controller = new ChannelsController({ host, pairing: fastPairing });
  expect((await controller.handle("channels-pair", request)).status).toBe(200);
  await until(() => api.activePollers() === 1, "the pairing to poll");

  const response = await controller.handle("channels-reload", request);

  expect(response.status).toBe(422);
  expect(await errorCode(response)).toBe("cannot-connect");
  expect(calls.start).toBe(0);
  expect(await statusState(controller)).toBe("pairing");
  expect(await pairingSnapshot(controller)).toEqual({ status: 200, state: "waiting-for-user" });
  expect(api.activePollers()).toBe(1);
  // Its code still works.
  api.pushPrivateMessage({ fromId: OPERATOR, text: CODE });
  await until(async () => (await pairingSnapshot(controller)).state === "waiting-for-group", "the code to still pair the operator");
  await controller.stop();
});
