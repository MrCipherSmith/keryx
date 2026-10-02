// Flow 389, AC1: the digest schedule fires by itself inside `keryx serve`.
//
// A fake clock and a fake `gh` drive the ticker serve runs. A due trigger starts exactly one
// run; a second tick in the same slot starts none; a restart of serve neither loses a due run
// nor repeats one that was already started. No OS timer is involved anywhere: `arm` is injected,
// so nothing here schedules a real interval.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { pauseStoredSchedule, resumeStoredSchedule } from "../trigger/schedules";
import { readTriggerRuns } from "../trigger/record";
import { addDigestSchedule, FakeGh, fakeSummary, runDigest, setupDigestEnv, TestClock, type DigestTestEnv } from "./digest.test-helpers";
import { createDigestTicker, firedPath, readFired, TICK_EVERY_MS, type DigestTicker } from "./digest-ticker";

let env: DigestTestEnv;
let clock: TestClock;
let gh: FakeGh;
let name = "";
let fires: string[] = [];
let flushes: string[] = [];
let notices: string[] = [];

beforeEach(async () => {
  env = await setupDigestEnv();
  clock = new TestClock("2026-10-02T12:00:30Z");
  gh = new FakeGh().empty();
  name = await addDigestSchedule(env, { cron: "* * * * *" });
  fires = [];
  flushes = [];
  notices = [];
});

afterEach(async () => {
  await env.teardown();
});

/** A ticker like serve's, with a fake clock and a `fire` that starts a REAL digest run against the fake gh. */
function makeTicker(options: { throwOnFire?: boolean } = {}): DigestTicker {
  return createDigestTicker({
    roots: () => [env.root],
    now: clock.now,
    onNotice: (message) => notices.push(message),
    fire: async (root, scheduleName) => {
      fires.push(`${scheduleName}@${clock.now().toISOString()}`);
      if (options.throwOnFire === true) throw new Error("the run could not start");
      await runDigest({ ...env, root }, scheduleName, { runGh: gh.run, summarize: fakeSummary().summarize, now: clock.now });
    },
    flush: async (_root, scheduleName) => {
      flushes.push(scheduleName);
    },
  });
}

async function runCount(): Promise<number> {
  const read = await readTriggerRuns(env.root);
  return read.state === "present" ? read.records.filter((r) => r.trigger === name && r.outcome !== "reserved").length : 0;
}

describe("AC1: a due digest starts exactly one run", () => {
  test("the first tick only arms the digest; nothing is owed for the time before serve saw it", async () => {
    const ticker = makeTicker();
    const reports = await ticker.tick();
    expect(reports.map((r) => r.action)).toEqual(["armed"]);
    expect(fires).toEqual([]);
    expect(await runCount()).toBe(0);
  });

  test("when the cron time arrives the ticker starts one run, and the run is a real digest run with a record and a report", async () => {
    const ticker = makeTicker();
    await ticker.tick();
    clock.set("2026-10-02T12:01:10Z");
    const reports = await ticker.tick();

    expect(reports.map((r) => r.action)).toEqual(["fired"]);
    expect(reports[0]?.slot).toBe("2026-10-02T12:01:00.000Z");
    expect(fires).toHaveLength(1);
    expect(await runCount()).toBe(1);
    const read = await readTriggerRuns(env.root);
    const record = read.state === "present" ? read.records.find((r) => r.trigger === name && r.outcome !== "reserved") : undefined;
    expect(record?.outcome).toBe("ok");
    expect(record?.agentTask?.reportPath).toMatch(/^\.metaproject\/data\/trigger\/reports\/morning\/.+\.md$/);
  });

  test("a second tick in the same slot starts none, however many times it is asked", async () => {
    const ticker = makeTicker();
    await ticker.tick();
    clock.set("2026-10-02T12:01:10Z");
    await ticker.tick();
    clock.set("2026-10-02T12:01:40Z");
    const again = await ticker.tick();
    clock.set("2026-10-02T12:01:59Z");
    const third = await ticker.tick();

    expect(again.map((r) => r.action)).toEqual(["waiting"]);
    expect(third.map((r) => r.action)).toEqual(["waiting"]);
    expect(fires).toHaveLength(1);
    expect(await runCount()).toBe(1);
  });

  test("the next slot starts the next run", async () => {
    const ticker = makeTicker();
    await ticker.tick();
    clock.set("2026-10-02T12:01:10Z");
    await ticker.tick();
    clock.set("2026-10-02T12:02:05Z");
    const reports = await ticker.tick();
    expect(reports.map((r) => r.action)).toEqual(["fired"]);
    expect(fires).toHaveLength(2);
  });

  test("two ticks started together run the digest once: a tick in progress is shared, not repeated", async () => {
    const ticker = makeTicker();
    await ticker.tick();
    clock.set("2026-10-02T12:01:10Z");
    const [a, b] = await Promise.all([ticker.tick(), ticker.tick()]);
    expect(a).toBe(b);
    expect(fires).toHaveLength(1);
  });
});

describe("AC1: a serve restart neither loses nor duplicates a due run", () => {
  test("a restart after the slot was claimed does not run it again", async () => {
    const first = makeTicker();
    await first.tick();
    clock.set("2026-10-02T12:01:10Z");
    await first.tick();
    expect(fires).toHaveLength(1);

    // serve restarts: a new ticker with no memory, only the file on disk
    const second = makeTicker();
    clock.set("2026-10-02T12:01:20Z");
    const reports = await second.tick();
    expect(reports.map((r) => r.action)).toEqual(["waiting"]);
    expect(fires).toHaveLength(1);
    expect(await runCount()).toBe(1);
  });

  test("a slot that came due while serve was down is run once when serve is back", async () => {
    const before = makeTicker();
    await before.tick(); // armed at 12:00
    // serve is down: the clock passes 12:01, 12:02 ... 12:30
    clock.set("2026-10-02T12:30:10Z");
    const after = makeTicker();
    const reports = await after.tick();

    expect(reports.map((r) => r.action)).toEqual(["fired"]);
    expect(reports[0]?.slot).toBe("2026-10-02T12:30:00.000Z");
    // thirty missed slots collapse into one run, not thirty
    expect(fires).toHaveLength(1);
    expect(await runCount()).toBe(1);
    expect((await after.tick()).map((r) => r.action)).toEqual(["waiting"]);
  });

  test("a run that crashed is not started a second time by the next tick or the next serve; the notice says why", async () => {
    const ticker = makeTicker({ throwOnFire: true });
    await ticker.tick();
    clock.set("2026-10-02T12:01:10Z");
    const reports = await ticker.tick();
    expect(reports[0]?.detail).toContain("the run could not start");
    expect(notices.join("\n")).toContain('digest "morning" could not run: the run could not start');

    clock.set("2026-10-02T12:01:30Z");
    await ticker.tick();
    await makeTicker().tick();
    expect(fires).toHaveLength(1);
  });

  test("the claim is on disk before the run starts", async () => {
    const ticker = createDigestTicker({
      roots: () => [env.root],
      now: clock.now,
      flush: async () => {},
      fire: async () => {
        const claimed = await readFired(env.root, name);
        expect(claimed?.fired).toBe(true);
        expect(claimed?.slot).toBe("2026-10-02T12:01:00.000Z");
        expect(JSON.parse(await readFile(firedPath(env.root, name), "utf8")).fired).toBe(true);
      },
    });
    await ticker.tick();
    clock.set("2026-10-02T12:01:10Z");
    await ticker.tick();
  });
});

describe("AC1: a paused digest is not run, and resuming does not catch up", () => {
  test("paused: no run, however many slots pass; resumed: armed, nothing owed, then the next slot runs", async () => {
    const ticker = makeTicker();
    await ticker.tick();
    await pauseStoredSchedule(env.root, name);
    clock.set("2026-10-02T12:10:10Z");
    expect((await ticker.tick()).map((r) => r.action)).toEqual(["paused"]);
    clock.set("2026-10-02T13:10:10Z");
    expect((await ticker.tick()).map((r) => r.action)).toEqual(["paused"]);
    expect(fires).toEqual([]);

    await resumeStoredSchedule(env.root, name);
    clock.set("2026-10-02T13:20:10Z");
    expect((await ticker.tick()).map((r) => r.action)).toEqual(["armed"]);
    expect(fires).toEqual([]);

    clock.set("2026-10-02T13:21:10Z");
    expect((await ticker.tick()).map((r) => r.action)).toEqual(["fired"]);
    expect(fires).toHaveLength(1);
  });

  test("a message already queued is still flushed while the digest is paused", async () => {
    const ticker = makeTicker();
    await ticker.tick();
    await pauseStoredSchedule(env.root, name);
    flushes = [];
    clock.set("2026-10-02T12:05:00Z");
    await ticker.tick();
    expect(flushes).toEqual([name]);
  });
});

describe("AC1: serve starts and stops the ticker without a timer of its own in the test", () => {
  test("start checks at once, then on every interval the injected clock hands it; stop disarms", async () => {
    let tickOnInterval: (() => void) | undefined;
    let armedEvery = 0;
    let disarmed = 0;
    const ticker = createDigestTicker({
      roots: () => [env.root],
      now: clock.now,
      flush: async () => {},
      fire: async (root, scheduleName) => {
        fires.push(scheduleName);
        await runDigest({ ...env, root }, scheduleName, { runGh: gh.run, summarize: fakeSummary().summarize, now: clock.now });
      },
      arm: (tick, everyMs) => {
        tickOnInterval = tick;
        armedEvery = everyMs;
        return () => {
          disarmed += 1;
        };
      },
    });
    ticker.start();
    ticker.start(); // a second start is a no-op
    expect(armedEvery).toBe(TICK_EVERY_MS);
    await ticker.tick(); // the immediate check on start has armed the digest
    expect(fires).toEqual([]);

    // the interval callback is what makes a due digest start on its own
    clock.set("2026-10-02T12:03:10Z");
    tickOnInterval?.();
    await ticker.tick();
    expect(fires).toHaveLength(1);
    expect(await runCount()).toBe(1);

    await ticker.stop();
    expect(disarmed).toBe(1);
  });

  test("a digest in a project root other than the first is found too, and a root listed twice is read once", async () => {
    const ticker = createDigestTicker({
      roots: () => [env.root, env.root],
      now: clock.now,
      flush: async (_root, scheduleName) => {
        flushes.push(scheduleName);
      },
      fire: async () => {},
    });
    await ticker.tick();
    expect(flushes).toEqual([name]);
  });
});
