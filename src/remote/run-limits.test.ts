// AC11, serve/client part: a run started from Telegram cannot hold a shell
// forever, and a shell that dies cannot take serve (or another session) with it.
//
//   - `withRunTimeout` interrupts through an AbortSignal, tells the topic, and
//     does not depend on the interrupted function behaving;
//   - a killed shell (gone without deregistering) leaves serve answering, the
//     other sessions working, and its own queued line waiting for it.

import { afterEach, describe, expect, test } from "bun:test";
import { DEFAULT_RUN_TIMEOUT_MS } from "./config";
import type { HubTimers } from "./hub";
import { call, makeRig, type Rig } from "./remote.http.test-helpers";
import { ManualClock, OWNER_ID, settle, until } from "./remote.test-helpers";
import { describeRunLimit, runTimeoutNotice, withRunTimeout } from "./run-limits";

// The limit under test is named as one second (what the notice says) but runs for 80 ms of real
// time: the hub's own value is minutes, and nothing here may wait that long.
const scaledTimers: HubTimers = {
  setTimeout: (fn) => setTimeout(fn, 80),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
};

let rig: Rig | undefined;
afterEach(async () => {
  await rig?.cleanup();
  rig = undefined;
});

describe("withRunTimeout", () => {
  test("a run that finishes in time returns its value and posts nothing", async () => {
    const clock = new ManualClock();
    let notified = 0;
    const outcome = await withRunTimeout(
      1_000,
      async () => "done",
      () => {
        notified += 1;
      },
      clock,
    );
    expect(outcome).toEqual({ ok: true, value: "done" });
    expect(notified).toBe(0);
    // Its timer is gone: nothing left to fire later.
    expect(clock.pendingTimers()).toBe(0);
  });

  test("a run that overruns is aborted through its signal and the notice is posted", async () => {
    const clock = new ManualClock();
    let signalSeen: AbortSignal | undefined;
    const notices: number[] = [];
    const running = withRunTimeout(
      60_000,
      (signal) =>
        new Promise<string>((_resolve, reject) => {
          signalSeen = signal;
          signal.addEventListener("abort", () => reject(new Error("interrupted")), { once: true });
        }),
      ({ runMs }) => {
        notices.push(runMs);
      },
      clock,
    );
    await settle();
    expect(signalSeen?.aborted).toBe(false);
    await clock.advance(60_000);
    expect(await running).toEqual({ ok: false, timedOut: true, runMs: 60_000 });
    expect(signalSeen?.aborted).toBe(true);
    expect(notices).toEqual([60_000]);
  });

  test("a function that ignores the signal still cannot hold the caller, and its late failure is swallowed", async () => {
    const clock = new ManualClock();
    let release: (() => void) | undefined;
    const running = withRunTimeout(
      500,
      () =>
        new Promise<string>((_resolve, reject) => {
          release = () => reject(new Error("failed long after the timeout"));
        }),
      () => undefined,
      clock,
    );
    await clock.advance(500);
    expect(await running).toMatchObject({ ok: false, timedOut: true });
    // Would be an unhandled rejection (and fail this run) if it were not absorbed.
    release?.();
    await settle();
  });

  test("an error thrown before the timeout propagates", async () => {
    const clock = new ManualClock();
    await expect(
      withRunTimeout(
        1_000,
        async () => {
          throw new Error("the run failed");
        },
        () => undefined,
        clock,
      ),
    ).rejects.toThrow("the run failed");
    expect(clock.pendingTimers()).toBe(0);
  });

  test("a notice that cannot be posted does not turn an interrupted run into a crash", async () => {
    const clock = new ManualClock();
    const running = withRunTimeout(
      10,
      () => new Promise<string>(() => undefined),
      () => {
        throw new Error("the topic is unreachable");
      },
      clock,
    );
    await clock.advance(10);
    expect(await running).toMatchObject({ ok: false, timedOut: true });
  });

  test("a non-positive limit is refused", async () => {
    await expect(withRunTimeout(0, async () => 1, () => undefined)).rejects.toThrow(RangeError);
    await expect(withRunTimeout(Number.NaN, async () => 1, () => undefined)).rejects.toThrow(RangeError);
  });

  test("the notice names the limit in minutes or seconds", () => {
    expect(runTimeoutNotice(30 * 60_000)).toBe("Run interrupted: it exceeded the 30 minutes limit.");
    expect(describeRunLimit(60_000)).toBe("1 minute");
    expect(describeRunLimit(90_000)).toBe("90 seconds");
    expect(describeRunLimit(1)).toBe("1 second");
  });
});

describe("a run started from Telegram, over the real channel", () => {
  test("the client learns the limit at registration", async () => {
    rig = makeRig();
    await rig.startServe();
    const client = rig.makeClient({ sessionId: "sess-rl-0001", project: "/work/app", name: "release", onLine: () => undefined });
    const started = await client.start();
    expect(started.ok && started.runTimeoutMs).toBe(DEFAULT_RUN_TIMEOUT_MS);
    expect(client.runTimeoutMs).toBe(DEFAULT_RUN_TIMEOUT_MS);
  });

  test("an overrunning line is interrupted and the topic is told", async () => {
    rig = makeRig();
    await rig.startServe();
    let aborted = false;
    const client = rig.makeClient({
      sessionId: "sess-rl-0002",
      project: "/work/app",
      name: "release",
      onLine: async () => {
        const outcome = await withRunTimeout(
          1_000,
          (signal) =>
            new Promise<void>((resolve) => {
              signal.addEventListener(
                "abort",
                () => {
                  aborted = true;
                  resolve();
                },
                { once: true },
              );
            }),
          async ({ runMs }) => {
            await client.reply(runTimeoutNotice(runMs));
          },
          scaledTimers,
        );
        expect(outcome).toMatchObject({ ok: false, timedOut: true });
      },
    });
    const started = await client.start();
    if (!started.ok) {
      throw new Error("register failed");
    }
    rig.api.pushMessage({ fromId: OWNER_ID, text: "run forever", threadId: started.threadId });
    await until(() => rig?.api.sentTo(started.threadId).some((message) => message.text === runTimeoutNotice(1_000)) === true, "the interruption notice in the topic");
    expect(aborted).toBe(true);
    // The shell is still connected and still takes the next line.
    expect(client.connected).toBe(true);
  });
});

describe("a killed shell", () => {
  test("serve keeps answering and the other sessions keep working", async () => {
    rig = makeRig();
    const serve = await rig.startServe();
    const seenB: string[] = [];
    const a = rig.makeClient({ sessionId: "sess-rl-a", project: "/work/a", name: "alpha", onLine: () => undefined });
    const b = rig.makeClient({ sessionId: "sess-rl-b", project: "/work/b", name: "beta", onLine: (text) => void seenB.push(text) });
    const [ra, rb] = await Promise.all([a.start(), b.start()]);
    if (!ra.ok || !rb.ok) {
      throw new Error("both sessions should register");
    }

    // Killed: no deregister, the stream just stops.
    await a.drop();

    const status = await call(serve.origin, serve.serveToken, "GET", "/v1/status");
    expect(status.status).toBe(200);

    rig.api.pushMessage({ fromId: OWNER_ID, text: "still there?", threadId: rb.threadId });
    await until(() => seenB.length === 1, "beta's line");
    expect(seenB).toEqual(["still there?"]);
    expect(await b.reply("yes")).toBe(true);
    await until(() => rig?.api.sentTo(rb.threadId).some((message) => message.text === "yes") === true, "beta's reply");

    // Alpha is not forgotten at once: the lease decides, not the dropped socket.
    expect(serve.service.hub()?.list().map((session) => session.name).sort()).toEqual(["alpha", "beta"]);
  });

  test("a line sent while the shell was gone is delivered when it comes back, once", async () => {
    rig = makeRig();
    await rig.startServe();
    const first = rig.makeClient({ sessionId: "sess-rl-c", project: "/work/c", name: "gamma", onLine: () => undefined });
    const started = await first.start();
    if (!started.ok) {
      throw new Error("register failed");
    }
    await first.drop();

    rig.api.pushMessage({ fromId: OWNER_ID, text: "while you were out", threadId: started.threadId });
    await settle();
    await settle();

    const received: string[] = [];
    const second = rig.makeClient({ sessionId: "sess-rl-c", project: "/work/c", name: "gamma", onLine: (text) => void received.push(text) });
    expect((await second.start()).ok).toBe(true);
    await until(() => received.length === 1, "the waiting line");
    await settle();
    await settle();
    expect(received).toEqual(["while you were out"]);
  });

  test("a shell that vanishes with a request in flight does not wedge serve", async () => {
    rig = makeRig();
    const serve = await rig.startServe();
    const client = rig.makeClient({ sessionId: "sess-rl-d", project: "/work/d", name: "delta", onLine: async () => new Promise<void>(() => undefined) });
    const started = await client.start();
    if (!started.ok) {
      throw new Error("register failed");
    }
    rig.api.pushMessage({ fromId: OWNER_ID, text: "never finishes", threadId: started.threadId });
    await settle();
    await settle();
    await client.drop();
    const status = await call(serve.origin, serve.serveToken, "GET", "/v1/status");
    expect(status.status).toBe(200);
    // And serve can still be stopped promptly.
    const stopping = serve.stop();
    await expect(Promise.race([stopping.then(() => "stopped"), new Promise((resolve) => setTimeout(() => resolve("hung"), 5_000))])).resolves.toBe("stopped");
  });
});
