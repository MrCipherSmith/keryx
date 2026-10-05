// Flow 404 (AC8): the daily Part 1 materials sync inside `keryx serve`. A fake clock and a fake sync drive the
// job; no timer is started and no real sync runs.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { createServeResearchSync } from "../commands/serve-research-sync";
import {
  readResearchSyncEntry,
  readResearchSyncFired,
  researchSyncClaimPath,
  researchSyncDataDir,
  researchSyncEntryPath,
  runResearchSyncPass,
  scheduleResearchSync,
  unscheduleResearchSync,
  utcDay,
  type ResearchSyncJobDeps,
} from "./research-sync-job";

const CATALOG = path.join("docs", "research", "role-blurring-part1");

let root: string;
let notices: string[];
let calls: string[];

beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(tmpdir(), "keryx-research-job-")));
  await mkdir(path.join(root, CATALOG), { recursive: true });
  notices = [];
  calls = [];
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const at = (iso: string) => (): Date => new Date(iso);
const trusted = async (): Promise<boolean> => true;
const exec = promisify(execFile);
const git = (cwd: string, ...args: string[]): Promise<unknown> => exec("git", args, { cwd });

function deps(over: Partial<ResearchSyncJobDeps> = {}): ResearchSyncJobDeps {
  return {
    roots: () => [root],
    sync: async (r) => {
      calls.push(r);
      return { ok: true };
    },
    hasCatalog: async (r) => existsSync(path.join(r, CATALOG)),
    entryTrusted: trusted,
    now: at("2026-10-05T04:00:00Z"),
    onNotice: (m) => notices.push(m),
    ...over,
  };
}

describe("the daily entry", () => {
  test("creating it writes one small file and an ignore file; creating again keeps it", async () => {
    expect(await readResearchSyncEntry(root)).toBeUndefined();
    const first = await scheduleResearchSync(root, new Date("2026-10-05T04:00:00Z"));
    expect(first).toEqual({ created: true });
    expect(await readResearchSyncEntry(root)).toEqual({ version: 1, every: "daily", createdAt: "2026-10-05T04:00:00.000Z" });
    expect(await readFile(path.join(researchSyncDataDir(root), ".gitignore"), "utf8")).toContain("*");

    const second = await scheduleResearchSync(root, new Date("2026-10-09T04:00:00Z"));
    expect(second).toEqual({ created: false });
    expect((await readResearchSyncEntry(root))?.createdAt).toBe("2026-10-05T04:00:00.000Z");
  });

  test("removing it takes the entry and the record of the last run; removing again says nothing was there", async () => {
    await scheduleResearchSync(root);
    await runResearchSyncPass(deps());
    expect(await readResearchSyncFired(root)).toBeDefined();

    expect(await unscheduleResearchSync(root)).toEqual({ removed: true });
    expect(await readResearchSyncEntry(root)).toBeUndefined();
    expect(await readResearchSyncFired(root)).toBeUndefined();
    expect(await unscheduleResearchSync(root)).toEqual({ removed: false });

    calls.length = 0;
    await runResearchSyncPass(deps());
    expect(calls).toEqual([]);
  });
});

describe("once per UTC day", () => {
  test("a project without the entry is left alone", async () => {
    expect(await runResearchSyncPass(deps())).toEqual([]);
    expect(calls).toEqual([]);
  });

  test("runs once on a day, however many ticks, and again the next UTC day", async () => {
    await scheduleResearchSync(root);
    const first = await runResearchSyncPass(deps({ now: at("2026-10-05T00:00:05Z") }));
    expect(first.map((r) => r.action)).toEqual(["ran"]);
    for (const time of ["2026-10-05T00:05:00Z", "2026-10-05T12:00:00Z", "2026-10-05T23:59:59Z"]) {
      const again = await runResearchSyncPass(deps({ now: at(time) }));
      expect(again.map((r) => r.action)).toEqual(["waiting"]);
    }
    expect(calls).toEqual([root]);

    const next = await runResearchSyncPass(deps({ now: at("2026-10-06T00:00:01Z") }));
    expect(next.map((r) => r.action)).toEqual(["ran"]);
    expect(calls).toEqual([root, root]);
  });

  test("the day is the UTC day, not the local one", () => {
    expect(utcDay(new Date("2026-10-05T23:30:00-05:00"))).toBe("2026-10-06");
    expect(utcDay(new Date("2026-10-06T01:30:00+03:00"))).toBe("2026-10-05");
  });

  test("a restarted serve the same day does not run it again", async () => {
    await scheduleResearchSync(root);
    await runResearchSyncPass(deps());
    expect(calls).toHaveLength(1);

    // A new serve is a new job object over the same files.
    const restarted = createServeResearchSync({ roots: () => [root], sync: deps().sync, entryTrusted: trusted, now: at("2026-10-05T18:00:00Z"), onNotice: (m) => notices.push(m) });
    const reports = await restarted.tick();
    expect(reports.map((r) => r.action)).toEqual(["waiting"]);
    expect(calls).toHaveLength(1);
    expect((await readResearchSyncFired(root))?.day).toBe("2026-10-05");
  });

  test("a serve that was down for days runs once when it comes back, not once per missed day", async () => {
    await scheduleResearchSync(root);
    await runResearchSyncPass(deps({ now: at("2026-10-01T04:00:00Z") }));
    calls.length = 0;
    await runResearchSyncPass(deps({ now: at("2026-10-05T04:00:00Z") }));
    await runResearchSyncPass(deps({ now: at("2026-10-05T04:00:30Z") }));
    expect(calls).toHaveLength(1);
  });

  test("two ticks at once start one run", async () => {
    await scheduleResearchSync(root);
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const job = createServeResearchSync({
      roots: () => [root],
      entryTrusted: trusted,
      sync: async (r) => {
        calls.push(r);
        await gate;
        return { ok: true };
      },
      now: at("2026-10-05T04:00:00Z"),
    });
    const a = job.tick();
    const b = job.tick();
    release();
    await Promise.all([a, b]);
    expect(calls).toHaveLength(1);
  });
});

describe("a project the job must skip", () => {
  test("without the catalog directory it skips without a word and claims nothing", async () => {
    await scheduleResearchSync(root);
    await rm(path.join(root, CATALOG), { recursive: true, force: true });
    expect(await runResearchSyncPass(deps())).toEqual([]);
    expect(calls).toEqual([]);
    expect(notices).toEqual([]);
    expect(await readResearchSyncFired(root)).toBeUndefined();

    // The catalog appears later: the first tick after that runs.
    await mkdir(path.join(root, CATALOG), { recursive: true });
    expect((await runResearchSyncPass(deps())).map((r) => r.action)).toEqual(["ran"]);
  });

  test("the real serve wiring also skips a root with an entry and no catalog", async () => {
    await scheduleResearchSync(root);
    await rm(path.join(root, CATALOG), { recursive: true, force: true });
    const job = createServeResearchSync({ roots: () => [root], sync: deps().sync, entryTrusted: trusted, onNotice: (m) => notices.push(m) });
    expect(await job.tick()).toEqual([]);
    expect(calls).toEqual([]);
    expect(notices).toEqual([]);
  });

  test("a root named twice is synced once", async () => {
    await scheduleResearchSync(root);
    await runResearchSyncPass(deps({ roots: () => [root, `${root}${path.sep}.`, root] }));
    expect(calls).toHaveLength(1);
  });
});

describe("a failing run does not take the tick down", () => {
  test("a failed outcome is reported, recorded, and not retried the same day", async () => {
    await scheduleResearchSync(root);
    const failing = deps({ sync: async () => ({ ok: false, reason: "counts script failed" }) });
    const reports = await runResearchSyncPass(failing);
    expect(reports.map((r) => [r.action, r.detail])).toEqual([["failed", "counts script failed"]]);
    expect(notices).toEqual(["research sync could not run: counts script failed"]);
    expect(await readResearchSyncFired(root)).toMatchObject({ day: "2026-10-05", ok: false, reason: "counts script failed" });

    const again = await runResearchSyncPass(deps({ sync: failing.sync, now: at("2026-10-05T10:00:00Z") }));
    expect(again.map((r) => r.action)).toEqual(["waiting"]);
    expect(notices).toHaveLength(1);

    // Tomorrow it tries again, and a good run is recorded as good.
    const next = await runResearchSyncPass(deps({ now: at("2026-10-06T04:00:00Z") }));
    expect(next.map((r) => r.action)).toEqual(["ran"]);
    expect((await readResearchSyncFired(root))?.ok).toBe(true);
  });

  test("a sync that throws is a notice, not an exception, and the next project is still synced", async () => {
    const other = await realpath(await mkdtemp(path.join(tmpdir(), "keryx-research-job2-")));
    try {
      await mkdir(path.join(other, CATALOG), { recursive: true });
      await scheduleResearchSync(root);
      await scheduleResearchSync(other);
      const reports = await runResearchSyncPass(
        deps({
          roots: () => [root, other],
          sync: async (r) => {
            calls.push(r);
            if (r === root) throw new Error("boom");
            return { ok: true };
          },
        }),
      );
      expect(reports.map((r) => r.action)).toEqual(["failed", "ran"]);
      expect(notices).toEqual(["research sync could not run: boom"]);
      expect(calls).toEqual([root, other]);
    } finally {
      await rm(other, { recursive: true, force: true });
    }
  });

  test("through serve: tick resolves when the sync throws, and the exit code is not touched", async () => {
    await scheduleResearchSync(root);
    const before = process.exitCode;
    const job = createServeResearchSync({
      roots: () => [root],
      entryTrusted: trusted,
      sync: async () => {
        throw new Error("sync exploded");
      },
      now: at("2026-10-05T04:00:00Z"),
      onNotice: (m) => notices.push(m),
    });
    const reports = await job.tick();
    expect(reports.map((r) => r.action)).toEqual(["failed"]);
    expect(notices).toEqual(["research sync could not run: sync exploded"]);
    expect(process.exitCode).toBe(before);
  });

  test("an unreadable state file or a broken root is a notice, not an exception", async () => {
    await scheduleResearchSync(root);
    const reports = await runResearchSyncPass(
      deps({
        hasCatalog: async () => {
          throw new Error("disk gone");
        },
      }),
    );
    expect(reports).toEqual([]);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain("disk gone");
  });

  test("the real serve wiring leaves a stale -latest file alone when the real sync fails", async () => {
    await git(root, "init", "-q");
    await scheduleResearchSync(root);
    const latest = path.join(root, CATALOG, "part1-counts-latest.json");
    await writeFile(latest, '{"good":true}\n');
    // No part1-counts.json and no script in the catalog: the real sync fails before it writes anything.
    // No trust override either: the entry is untracked in a real repository, so the real check lets it through.
    const job = createServeResearchSync({ roots: () => [root], now: at("2026-10-05T04:00:00Z"), onNotice: (m) => notices.push(m) });
    const reports = await job.tick();
    expect(reports.map((r) => r.action)).toEqual(["failed"]);
    expect(await readFile(latest, "utf8")).toBe('{"good":true}\n');
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain("research sync could not run");
  });
});

describe("an entry the project ships is not an entry the operator made", () => {
  test("a schedule.json that git tracks is ignored: the sync does not run and nothing is claimed", async () => {
    await git(root, "init", "-q");
    await scheduleResearchSync(root);
    // `git add -f` beats the ignore file of the state directory, exactly as a committed clone would carry it.
    await git(root, "add", "-f", path.relative(root, researchSyncEntryPath(root)));
    const job = createServeResearchSync({ roots: () => [root], sync: deps().sync, now: at("2026-10-05T04:00:00Z"), onNotice: (m) => notices.push(m) });
    expect(await job.tick()).toEqual([]);
    expect(calls).toEqual([]);
    expect(await readResearchSyncFired(root)).toBeUndefined();
    expect(existsSync(researchSyncClaimPath(root, "2026-10-05"))).toBe(false);
  });

  test("the same entry, untracked, runs; a directory that is not a repository is skipped", async () => {
    await scheduleResearchSync(root);
    const make = (): ReturnType<typeof createServeResearchSync> =>
      createServeResearchSync({ roots: () => [root], sync: deps().sync, now: at("2026-10-05T04:00:00Z"), onNotice: (m) => notices.push(m) });
    // Not a repository: git cannot say the entry is untracked, so it is not believed.
    expect(await make().tick()).toEqual([]);
    expect(calls).toEqual([]);

    await git(root, "init", "-q");
    expect((await make().tick()).map((r) => r.action)).toEqual(["ran"]);
    expect(calls).toEqual([root]);
  });

  test("a trust check that throws skips the project instead of running it", async () => {
    await scheduleResearchSync(root);
    const reports = await runResearchSyncPass(
      deps({
        entryTrusted: async () => {
          throw new Error("git exploded");
        },
      }),
    );
    expect(reports).toEqual([]);
    expect(calls).toEqual([]);
  });
});

describe("two serve processes", () => {
  test("a day another process has already claimed is not run, even before it wrote its result", async () => {
    await scheduleResearchSync(root);
    // The other process created the claim and has not written fired.json yet.
    await writeFile(researchSyncClaimPath(root, "2026-10-05"), '{"pid":1}\n', { flag: "wx" });
    expect(await readResearchSyncFired(root)).toBeUndefined();
    const reports = await runResearchSyncPass(deps());
    expect(reports.map((r) => r.action)).toEqual(["waiting"]);
    expect(calls).toEqual([]);
  });

  test("passes that start at the same moment run the sync once", async () => {
    await scheduleResearchSync(root);
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const gated = deps({
      sync: async (r) => {
        calls.push(r);
        await gate;
        return { ok: true };
      },
    });
    const passes = [runResearchSyncPass(gated), runResearchSyncPass(gated), runResearchSyncPass(gated)];
    // Let every pass reach its claim before the one that won is allowed to finish.
    await new Promise((resolve) => setTimeout(resolve, 100));
    release();
    const reports = (await Promise.all(passes)).flat();
    expect(calls).toHaveLength(1);
    expect(reports.map((r) => r.action).sort()).toEqual(["ran", "waiting", "waiting"]);
  });

  test("the claim of an earlier day is removed, and unscheduling removes the rest", async () => {
    await scheduleResearchSync(root);
    await runResearchSyncPass(deps({ now: at("2026-10-04T04:00:00Z") }));
    await runResearchSyncPass(deps({ now: at("2026-10-05T04:00:00Z") }));
    expect((await readdir(researchSyncDataDir(root))).filter((name) => name.startsWith("claim-"))).toEqual(["claim-2026-10-05"]);
    await unscheduleResearchSync(root);
    expect((await readdir(researchSyncDataDir(root))).filter((name) => name.startsWith("claim-"))).toEqual([]);
  });
});

describe("a sync that hangs", () => {
  test("is recorded as failed at the deadline, the tick ends, and the day is not retried", async () => {
    await scheduleResearchSync(root);
    const reports = await runResearchSyncPass(deps({ deadlineMs: 30, sync: () => new Promise<never>(() => {}) }));
    expect(reports.map((r) => r.action)).toEqual(["failed"]);
    expect(reports[0]?.detail).toContain("did not finish");
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain("research sync could not run: sync did not finish");
    expect(await readResearchSyncFired(root)).toMatchObject({ day: "2026-10-05", ok: false });
    expect((await runResearchSyncPass(deps())).map((r) => r.action)).toEqual(["waiting"]);
  });

  test("through serve: tick and stop resolve while the sync is still hanging, and `running` is released", async () => {
    await scheduleResearchSync(root);
    let started = 0;
    const job = createServeResearchSync({
      roots: () => [root],
      entryTrusted: trusted,
      deadlineMs: 30,
      sync: () => {
        started += 1;
        return new Promise<never>(() => {});
      },
      now: at("2026-10-05T04:00:00Z"),
      onNotice: (m) => notices.push(m),
    });
    expect((await job.tick()).map((r) => r.action)).toEqual(["failed"]);
    await job.stop();
    // The next tick starts a fresh pass (it is not handed the finished one) and finds the day taken.
    expect((await job.tick()).map((r) => r.action)).toEqual(["waiting"]);
    expect(started).toBe(1);
  });
});

describe("the timer", () => {
  test("start runs one pass at once and arms the repeat; stop disarms it and waits", async () => {
    await scheduleResearchSync(root);
    const armed: Array<{ tick: () => void; everyMs: number }> = [];
    let disarmed = 0;
    const job = createServeResearchSync({
      roots: () => [root],
      sync: deps().sync,
      entryTrusted: trusted,
      now: at("2026-10-05T04:00:00Z"),
      arm: (tick, everyMs) => {
        armed.push({ tick, everyMs });
        return () => {
          disarmed += 1;
        };
      },
    });
    job.start();
    job.start();
    expect(armed).toHaveLength(1);
    await job.tick();
    expect(calls).toEqual([root]);
    armed[0]?.tick();
    await job.stop();
    expect(disarmed).toBe(1);
    expect(calls).toEqual([root]);
  });
});
