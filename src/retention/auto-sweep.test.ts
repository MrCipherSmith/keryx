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
import { AUTO_SWEEP_ENV, autoSweepStampPath, lastAutoSweepAt, maybeAutoSweepGdctx } from "./auto-sweep";
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

  test("the interval is claimed before the sweep runs, so a concurrent writer skips", async () => {
    const root = await project();
    try {
      await writeAged(path.join(root, ".metaproject", "data", "gdctx", "raw", "old.log"), 400);
      const now = Date.now();
      const observed: Array<number | null> = [];
      const deps = {
        ...defaultFsDeps,
        remove: async (entryPath: string, unit: "file" | "directory") => {
          observed.push(await lastAutoSweepAt(root));
          await defaultFsDeps.remove(entryPath, unit);
        },
      };

      await maybeAutoSweepGdctx(root, { deps, now, env: {} });
      // The stamp was already on disk while the removal was in flight — a
      // concurrent ctx write at that moment reads it and skips instead of
      // sweeping the same directories at the same time.
      expect(observed).toEqual([now]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

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
