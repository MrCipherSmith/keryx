// Flow 237 T12 (F5): the retention policy had no invoker.
//
// `sweepProject`'s only caller was `keryx retention sweep --apply`, typed by a
// human — so on the keryx checkout itself the two gdctx stores held 2,570
// entries and ~137 MiB past their own policy, and would have held more forever.
//
// The first test below therefore goes through `keryx ctx` as a real process.
// A test that called `maybeAutoSweepGdctx` directly would have passed in every
// release where nothing invoked it — which is the defect, not the fix.

import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  AUTO_SWEEP_ENV,
  autoSweepClaimPath,
  autoSweepStampPath,
  lastAutoSweepAt,
  maybeAutoSweepGdctx,
  readAutoSweepStamp,
} from "./auto-sweep";
import { pathExists } from "../lib/fs";
import { defaultFsDeps } from "./fs-deps";

const DAY_MS = 24 * 60 * 60 * 1000;
const CLI = path.join(import.meta.dir, "..", "cli.ts");

async function project(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-auto-sweep-"));
  await mkdir(path.join(root, ".metaproject", "data", "gdctx", "raw"), { recursive: true });
  await mkdir(path.join(root, ".metaproject", "data", "gdctx", "artifacts"), { recursive: true });
  return root;
}

async function writeAged(filePath: string, ageDays: number): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, "x".repeat(64), "utf8");
  const when = new Date(Date.now() - ageDays * DAY_MS);
  await utimes(filePath, when, when);
}

async function keryx(cwd: string, args: string[], env: Record<string, string> = {}): Promise<number> {
  // The opt-out is stripped from the inherited environment first: whether the
  // automatic sweep is ON BY DEFAULT is exactly what the first test asserts,
  // and it must not silently pass or fail because of the shell that started
  // the test run.
  const inherited = { ...process.env } as Record<string, string | undefined>;
  delete inherited[AUTO_SWEEP_ENV];
  const child = Bun.spawn([process.execPath, CLI, ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...inherited, NO_COLOR: "1", ...env } as Record<string, string>,
  });
  await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return child.exited;
}

describe("the retention policy is actually invoked", () => {
  test("`keryx ctx run` sweeps the gdctx store it just wrote to", async () => {
    const root = await project();
    try {
      const stale = path.join(root, ".metaproject", "data", "gdctx", "raw", "2020-01-01T00-00-00-000Z-aaaaaa_run.log");
      const recent = path.join(root, ".metaproject", "data", "gdctx", "raw", "2026-01-01T00-00-00-000Z-bbbbbb_run.log");
      await writeAged(stale, 400); // far past DEFAULT_MAX_AGE_DAYS (14)
      await writeAged(recent, 1);

      expect(await keryx(root, ["ctx", "run", "--", "echo", "hello"])).toBe(0);

      const remaining = await readdir(path.join(root, ".metaproject", "data", "gdctx", "raw"));
      // The defect, verbatim: before this fix `stale` survived every ctx run
      // forever, because nothing applied the policy that already called it
      // eligible.
      expect(remaining).not.toContain(path.basename(stale));
      // And the sweep is the POLICY, not a purge: an entry inside the window
      // and the run's own fresh artifacts are untouched.
      expect(remaining).toContain(path.basename(recent));
      expect(remaining).toContain("latest.log");
      expect(remaining.some((name) => name.endsWith("_run.log") && name !== path.basename(recent))).toBe(true);

      expect(await lastAutoSweepAt(root)).not.toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  test(`${AUTO_SWEEP_ENV}=0 leaves the store to grow, so the automatic sweep is opt-out and not unconditional`, async () => {
    const root = await project();
    try {
      const stale = path.join(root, ".metaproject", "data", "gdctx", "raw", "2020-01-01T00-00-00-000Z-cccccc_run.log");
      await writeAged(stale, 400);

      expect(await keryx(root, ["ctx", "run", "--", "echo", "hello"], { [AUTO_SWEEP_ENV]: "0" })).toBe(0);

      const remaining = await readdir(path.join(root, ".metaproject", "data", "gdctx", "raw"));
      expect(remaining).toContain(path.basename(stale));
      expect(await lastAutoSweepAt(root)).toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);
});

describe("maybeAutoSweepGdctx throttling", () => {
  test("a second call inside the interval does not sweep again", async () => {
    const root = await project();
    try {
      const first = path.join(root, ".metaproject", "data", "gdctx", "raw", "first.log");
      await writeAged(first, 400);
      const now = Date.now();

      const one = await maybeAutoSweepGdctx(root, { deps: defaultFsDeps, now, env: {} });
      expect(one.ran).toBe(true);
      expect(await readdir(path.join(root, ".metaproject", "data", "gdctx", "raw"))).toEqual([]);

      // A second eligible entry appears a minute later. The store is NOT swept
      // again — the cost argument (a full stat of both directories) is why the
      // sweep is throttled rather than run per write.
      const second = path.join(root, ".metaproject", "data", "gdctx", "raw", "second.log");
      await writeAged(second, 400);
      const two = await maybeAutoSweepGdctx(root, { deps: defaultFsDeps, now: now + 60_000, env: {} });
      expect(two).toEqual({ ran: false, reason: "throttled" });
      expect(await readdir(path.join(root, ".metaproject", "data", "gdctx", "raw"))).toEqual(["second.log"]);

      // A day later it sweeps again, so throttling delays the policy rather
      // than cancelling it.
      const three = await maybeAutoSweepGdctx(root, { deps: defaultFsDeps, now: now + DAY_MS + 1, env: {} });
      expect(three.ran).toBe(true);
      expect(await readdir(path.join(root, ".metaproject", "data", "gdctx", "raw"))).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  // V237-02 (flow 237 T13). The test this replaces asserted the stamp was on
  // disk while the sweep ran, and read that as serialization. It is not: the
  // stamp was written by a plain `writeFile` after a separate read, so two
  // processes that both got past the interval check both swept. What has to be
  // asserted is the OUTCOME — a caller arriving mid-sweep does not sweep — and
  // that is what this asserts, re-entrantly (a genuine second call, in flight,
  // through the public function) and across real processes below.
  test("a call arriving while a sweep is in flight does not sweep", async () => {
    const root = await project();
    try {
      await writeAged(path.join(root, ".metaproject", "data", "gdctx", "raw", "old.log"), 400);
      await writeAged(path.join(root, ".metaproject", "data", "gdctx", "raw", "older.log"), 400);
      const now = Date.now();
      const concurrent: unknown[] = [];
      const deps = {
        ...defaultFsDeps,
        remove: async (entryPath: string, unit: "file" | "directory") => {
          concurrent.push(await maybeAutoSweepGdctx(root, { deps: defaultFsDeps, now, env: {} }));
          await defaultFsDeps.remove(entryPath, unit);
        },
      };

      const outcome = await maybeAutoSweepGdctx(root, { deps, now, env: {} });
      expect(outcome.ran).toBe(true);
      // Every one of them skipped: none swept the store the holder was sweeping.
      expect(concurrent).toEqual(concurrent.map(() => ({ ran: false, reason: "in-progress" })));
      expect(concurrent.length).toBeGreaterThan(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  // The in-process test above cannot see a lost update across an fs boundary,
  // which is where the measured 8-ran-of-8 lived. These are real OS processes,
  // released together on a filesystem barrier so that process-start skew — the
  // thing that made the old code LOOK correct — cannot do the work.
  test("processes released together on a barrier: exactly one sweeps", async () => {
    const root = await project();
    const workers = 6;
    try {
      for (let i = 0; i < 60; i += 1) {
        await writeAged(path.join(root, ".metaproject", "data", "gdctx", "raw", `e-${i}.log`), 400);
        await writeAged(path.join(root, ".metaproject", "data", "gdctx", "artifacts", `e-${i}.md`), 400);
      }
      const barrier = path.join(root, "_barrier");
      await mkdir(barrier, { recursive: true });
      const workerPath = path.join(root, "worker.ts");
      await writeFile(
        workerPath,
        [
          `import { existsSync, writeFileSync } from "node:fs";`,
          `import { maybeAutoSweepGdctx } from ${JSON.stringify(path.join(import.meta.dir, "auto-sweep.ts"))};`,
          `const [root, barrier, id] = process.argv.slice(2);`,
          `writeFileSync(barrier + "/ready-" + id, "1");`,
          `while (!existsSync(barrier + "/go")) Bun.sleepSync(1);`,
          `const outcome = await maybeAutoSweepGdctx(root, { env: {} });`,
          `const removed = outcome.ran ? outcome.report.targets.reduce((n, t) => n + t.entriesRemoved, 0) : 0;`,
          `console.log(JSON.stringify({ ran: outcome.ran, reason: outcome.ran ? null : outcome.reason, removed }));`,
        ].join("\n"),
        "utf8",
      );

      const running = Array.from({ length: workers }, (_, i) =>
        Bun.spawn([process.execPath, workerPath, root, barrier, String(i)], { stdout: "pipe", stderr: "pipe" }),
      );
      const deadline = Date.now() + 60_000;
      while (Date.now() < deadline) {
        if ((await readdir(barrier)).filter((f) => f.startsWith("ready-")).length >= workers) break;
        await Bun.sleep(5);
      }
      await writeFile(path.join(barrier, "go"), "1", "utf8");

      const outcomes = await Promise.all(
        running.map(async (child) => {
          const [out] = await Promise.all([new Response(child.stdout).text(), child.exited]);
          return JSON.parse(out.trim()) as { ran: boolean; reason: string | null; removed: number };
        }),
      );
      // Was `ran=6 skipped=0` before the atomic claim.
      expect(outcomes.filter((o) => o.ran)).toHaveLength(1);
      expect(outcomes.filter((o) => !o.ran).map((o) => o.reason)).toEqual(
        Array.from({ length: workers - 1 }, () => "in-progress"),
      );
      // And the one that ran did all the work; nobody double-swept.
      expect(outcomes.find((o) => o.ran)?.removed).toBe(120);
      expect(await readdir(path.join(root, ".metaproject", "data", "gdctx", "raw"))).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 90_000);

  test("a corrupt stamp reads as `never swept` rather than freezing the policy forever", async () => {
    const root = await project();
    try {
      await writeAged(path.join(root, ".metaproject", "data", "gdctx", "raw", "old.log"), 400);
      await mkdir(path.dirname(autoSweepStampPath(root)), { recursive: true });
      await writeFile(autoSweepStampPath(root), "{not json", "utf8");

      const result = await maybeAutoSweepGdctx(root, { deps: defaultFsDeps, now: Date.now(), env: {} });
      expect(result.ran).toBe(true);
      expect(await readdir(path.join(root, ".metaproject", "data", "gdctx", "raw"))).toEqual([]);
      expect(JSON.parse(await readFile(autoSweepStampPath(root), "utf8")).lastRunAtMs).toBeGreaterThan(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  // V237-04 (flow 237 T13): the stamp used to carry only `lastRunAtMs`, written
  // before the sweep, so a process that died mid-sweep left a mark asserting a
  // sweep that never happened — and `keryx retention status` read it back as
  // "Last automatic sweep". The kill here is a real SIGKILL of a real process;
  // the injected `remove` only holds that process at a known point so the kill
  // lands mid-sweep every time instead of by luck.
  test("a process killed mid-sweep leaves a stamp that does not claim a sweep completed", async () => {
    const root = await project();
    try {
      await writeAged(path.join(root, ".metaproject", "data", "gdctx", "raw", "old.log"), 400);
      const marker = path.join(root, "sweeping");
      const workerPath = path.join(root, "hang.ts");
      await writeFile(
        workerPath,
        [
          `import { writeFileSync } from "node:fs";`,
          `import { maybeAutoSweepGdctx } from ${JSON.stringify(path.join(import.meta.dir, "auto-sweep.ts"))};`,
          `import { defaultFsDeps } from ${JSON.stringify(path.join(import.meta.dir, "fs-deps.ts"))};`,
          `const [root, marker] = process.argv.slice(2);`,
          `await maybeAutoSweepGdctx(root, { env: {}, deps: { ...defaultFsDeps, remove: async () => {`,
          `  writeFileSync(marker, "1");`,
          `  await new Promise(() => {});`,
          `} } });`,
        ].join("\n"),
        "utf8",
      );

      const child = Bun.spawn([process.execPath, workerPath, root, marker], { stdout: "ignore", stderr: "ignore" });
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline && !(await pathExists(marker))) await Bun.sleep(5);
      expect(await pathExists(marker)).toBe(true);
      child.kill("SIGKILL");
      await child.exited;

      const stamp = await readAutoSweepStamp(root);
      expect(stamp?.startedAtMs).toBeGreaterThan(0);
      // The whole point: started is recorded, completed is not.
      expect(stamp?.completedAtMs).toBeNull();
      expect(await lastAutoSweepAt(root)).toBeNull();
      // The store really was not swept.
      expect(await readdir(path.join(root, ".metaproject", "data", "gdctx", "raw"))).toEqual(["old.log"]);

      // The crash does not turn the throttle off: an unbounded sweep on every
      // ctx write is a worse outcome than one deferred day.
      const soon = await maybeAutoSweepGdctx(root, { deps: defaultFsDeps, now: Date.now(), env: {} });
      expect(soon).toEqual({ ran: false, reason: "throttled" });

      // And the claim the dead process left behind is breakable once abandoned,
      // so the policy resumes rather than wedging on it forever.
      const later = await maybeAutoSweepGdctx(root, {
        deps: defaultFsDeps,
        now: Date.now() + DAY_MS + 1,
        env: {},
        claimStaleMs: 0,
      });
      expect(later.ran).toBe(true);
      expect(await readdir(path.join(root, ".metaproject", "data", "gdctx", "raw"))).toEqual([]);
      expect((await readAutoSweepStamp(root))?.completedAtMs).toBeGreaterThan(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);

  test("a live claim is NOT broken before the stale window, even past the interval", async () => {
    const root = await project();
    try {
      await writeAged(path.join(root, ".metaproject", "data", "gdctx", "raw", "old.log"), 400);
      await mkdir(path.dirname(autoSweepClaimPath(root)), { recursive: true });
      await writeFile(autoSweepClaimPath(root), "someone-else", "utf8");

      const result = await maybeAutoSweepGdctx(root, { deps: defaultFsDeps, now: Date.now(), env: {} });
      expect(result).toEqual({ ran: false, reason: "in-progress" });
      expect(await readdir(path.join(root, ".metaproject", "data", "gdctx", "raw"))).toEqual(["old.log"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("an unwritable stamp skips the sweep rather than sweeping on every single write", async () => {
    const root = await project();
    try {
      await writeAged(path.join(root, ".metaproject", "data", "gdctx", "raw", "old.log"), 400);
      // A FILE where the stamp's parent directory must be: `mkdir -p` fails
      // with ENOTDIR, which is a real, un-mocked way for the claim to fail.
      await writeFile(path.join(root, ".metaproject", "data", "retention"), "not a directory", "utf8");

      const result = await maybeAutoSweepGdctx(root, { deps: defaultFsDeps, now: Date.now(), env: {} });
      expect(result).toEqual({ ran: false, reason: "stamp-unwritable" });
      expect(await readdir(path.join(root, ".metaproject", "data", "gdctx", "raw"))).toEqual(["old.log"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
