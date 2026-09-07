// Retention sweep engine (flow 237 phase 5, T8 — AC3 / AC-29 "forgetting",
// the retention/prune slice for stores that grow without bound: gdctx raw
// logs/artifacts and owner write-conflict sidecars).
//
// RED first: this file is written against `./sweep`, `./policy`, and
// `./fs-deps` before those modules exist, so the first run of this suite
// fails on the import, not on an assertion.

import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { RetentionFsDeps } from "./fs-deps";
import { defaultFsDeps } from "./fs-deps";
import type { RetentionTarget } from "./policy";
import { RETENTION_SCOPE_NOTE, sweepAll, sweepProject, sweepTarget } from "./sweep";

const DAY_MS = 24 * 60 * 60 * 1000;

async function project(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "retention-sweep-"));
}

/** Write a file and back-date its mtime by `ageDays`. */
async function writeAged(filePath: string, content: string, ageDays: number, now: number): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content, "utf8");
  const when = new Date(now - ageDays * DAY_MS);
  await import("node:fs/promises").then(({ utimes }) => utimes(filePath, when, when));
}

function fileTarget(dir: string, overrides: Partial<RetentionTarget> = {}): RetentionTarget {
  return {
    id: "test-files",
    label: "test files",
    dir,
    unit: "file",
    maxAgeDays: 14,
    maxBytes: 10 * 1024 * 1024,
    ...overrides,
  };
}

describe("sweepTarget: age cutoff", () => {
  test("dry run flags entries older than maxAgeDays as would-remove, never deletes", async () => {
    const cwd = await project();
    const dir = path.join(cwd, "store");
    const now = Date.now();
    await writeAged(path.join(dir, "old.log"), "old", 20, now);
    await writeAged(path.join(dir, "new.log"), "new", 1, now);

    const result = await sweepTarget(fileTarget(dir), defaultFsDeps, { dryRun: true, now });

    expect(result.status).toBe("ok");
    expect(result.entriesScanned).toBe(2);
    const old = result.entries.find((e) => e.name === "old.log");
    const fresh = result.entries.find((e) => e.name === "new.log");
    expect(old?.outcome).toBe("would-remove");
    expect(old?.reason).toBe("age");
    expect(fresh?.outcome).toBe("kept");

    // Dry run truly never touches disk.
    const remaining = await readdir(dir);
    expect(remaining.sort()).toEqual(["new.log", "old.log"]);
  });

  test("apply removes only the entries past the age cutoff", async () => {
    const cwd = await project();
    const dir = path.join(cwd, "store");
    const now = Date.now();
    await writeAged(path.join(dir, "old.log"), "old", 20, now);
    await writeAged(path.join(dir, "new.log"), "new", 1, now);

    const result = await sweepTarget(fileTarget(dir), defaultFsDeps, { dryRun: false, now });

    expect(result.status).toBe("ok");
    expect(result.entriesRemoved).toBe(1);
    const remaining = await readdir(dir);
    expect(remaining).toEqual(["new.log"]);
  });
});

describe("sweepTarget: byte cap", () => {
  test("removes oldest-remaining entries, beyond the age cutoff, until under the byte cap", async () => {
    const cwd = await project();
    const dir = path.join(cwd, "store");
    const now = Date.now();
    // All within the age window (maxAgeDays: 14), so age removes nothing; the
    // byte cap must still bring total size under target.maxBytes by evicting
    // the oldest entries first.
    await writeAged(path.join(dir, "a.log"), "x".repeat(100), 5, now);
    await writeAged(path.join(dir, "b.log"), "x".repeat(100), 4, now);
    await writeAged(path.join(dir, "c.log"), "x".repeat(100), 3, now);

    const result = await sweepTarget(fileTarget(dir, { maxBytes: 150 }), defaultFsDeps, { dryRun: false, now });

    // 300 bytes total, cap 150: oldest (a.log, then b.log) must go until <=150.
    const remaining = await readdir(dir);
    expect(remaining).toEqual(["c.log"]);
    expect(result.entries.find((e) => e.name === "a.log")?.reason).toBe("bytes-cap");
    expect(result.entries.find((e) => e.name === "b.log")?.reason).toBe("bytes-cap");
    expect(result.bytesRemaining).toBeLessThanOrEqual(150);
  });
});

describe("sweepTarget: unreachable store", () => {
  test("a directory that cannot be read yields incomplete with a reason, never a clean success", async () => {
    const cwd = await project();
    const dir = path.join(cwd, "unreadable-store");
    const failingDeps: RetentionFsDeps = {
      ...defaultFsDeps,
      readdir: async () => {
        const error = new Error("permission denied") as NodeJS.ErrnoException;
        error.code = "EACCES";
        throw error;
      },
    };

    const result = await sweepTarget(fileTarget(dir), failingDeps, { dryRun: true });

    expect(result.status).toBe("incomplete");
    expect(result.reasons.length).toBeGreaterThan(0);
    expect(result.reasons.join(" ")).toContain("EACCES");
  });

  test("an absent directory is empty, not incomplete — nothing to reach yet is not a failure to reach it", async () => {
    const cwd = await project();
    const dir = path.join(cwd, "never-created");

    const result = await sweepTarget(fileTarget(dir), defaultFsDeps, { dryRun: true });

    expect(result.status).toBe("empty");
    expect(result.reasons).toEqual([]);
  });

  test("a single entry that cannot be removed marks the target incomplete with the reason, and other entries still complete", async () => {
    const cwd = await project();
    const dir = path.join(cwd, "store");
    const now = Date.now();
    await writeAged(path.join(dir, "stuck.log"), "x", 20, now);
    await writeAged(path.join(dir, "removable.log"), "x", 20, now);

    const failingDeps: RetentionFsDeps = {
      ...defaultFsDeps,
      remove: async (entryPath, unit) => {
        if (entryPath.endsWith("stuck.log")) {
          const error = new Error("resource busy") as NodeJS.ErrnoException;
          error.code = "EBUSY";
          throw error;
        }
        return defaultFsDeps.remove(entryPath, unit);
      },
    };

    const result = await sweepTarget(fileTarget(dir), failingDeps, { dryRun: false, now });

    expect(result.status).toBe("incomplete");
    expect(result.reasons.join(" ")).toContain("stuck.log");
    expect(result.reasons.join(" ")).toContain("EBUSY");
    const stuck = result.entries.find((e) => e.name === "stuck.log");
    expect(stuck?.outcome).toBe("remove-failed");
    expect(stuck?.error).toContain("EBUSY");
    const removable = result.entries.find((e) => e.name === "removable.log");
    expect(removable?.outcome).toBe("removed");

    const remaining = await readdir(dir);
    expect(remaining).toEqual(["stuck.log"]);
  });
});

describe("sweepTarget: directory unit (owner write-conflict sidecars)", () => {
  test("sweeps the whole conflict directory as one unit, sized recursively", async () => {
    const cwd = await project();
    const dir = path.join(cwd, "workspaces", "ws-1", "memory-write-conflicts");
    const now = Date.now();
    const conflictDir = path.join(dir, "abc123");
    await mkdir(conflictDir, { recursive: true });
    await writeFile(path.join(conflictDir, "proposed"), "x".repeat(50), "utf8");
    const when = new Date(now - 40 * DAY_MS);
    await import("node:fs/promises").then(({ utimes }) => utimes(conflictDir, when, when));

    const target: RetentionTarget = {
      id: "owner-write-conflicts:ws-1:memory-write-conflicts",
      label: "refused-write sidecars",
      dir,
      unit: "directory",
      maxAgeDays: 30,
      maxBytes: 10 * 1024 * 1024,
    };

    const result = await sweepTarget(target, defaultFsDeps, { dryRun: false, now });

    expect(result.entriesRemoved).toBe(1);
    expect(result.entries[0]?.bytes).toBe(50);
    const remainingWorkspaces = await readdir(dir).catch(() => []);
    expect(remainingWorkspaces).toEqual([]);
  });
});

describe("sweepAll", () => {
  test("aggregates target statuses: any incomplete target makes the whole report incomplete", async () => {
    const cwd = await project();
    const okDir = path.join(cwd, "ok-store");
    await mkdir(okDir, { recursive: true });
    const failingDeps: RetentionFsDeps = {
      ...defaultFsDeps,
      readdir: async (dir: string) => {
        if (dir.includes("broken-store")) {
          const error = new Error("nope") as NodeJS.ErrnoException;
          error.code = "EACCES";
          throw error;
        }
        return defaultFsDeps.readdir(dir);
      },
    };

    const targets: RetentionTarget[] = [
      fileTarget(okDir, { id: "ok" }),
      fileTarget(path.join(cwd, "broken-store"), { id: "broken" }),
    ];

    const report = await sweepAll(targets, failingDeps, { dryRun: true });

    expect(report.status).toBe("incomplete");
    expect(report.targets.map((t) => t.id).sort()).toEqual(["broken", "ok"]);
  });

  test("never claims external copies or git history are erased", async () => {
    const report = await sweepAll([], defaultFsDeps, { dryRun: true });
    expect(report.scopeNote).toBe(RETENTION_SCOPE_NOTE);
    expect(report.scopeNote.toLowerCase()).toContain("git history");
    expect(report.scopeNote.toLowerCase()).toContain("never touched or promised erased");
  });
});

describe("sweepProject", () => {
  test("discovers gdctx targets and sweeps them by real path under cwd", async () => {
    const cwd = await project();
    const now = Date.now();
    await writeAged(path.join(cwd, ".metaproject", "data", "gdctx", "raw", "old.log"), "x", 20, now);
    await writeAged(path.join(cwd, ".metaproject", "data", "gdctx", "artifacts", "old.md"), "x", 20, now);

    const report = await sweepProject(cwd, defaultFsDeps, { dryRun: false, now });

    expect(report.status).toBe("ok");
    expect(report.targets.map((t) => t.id).sort()).toEqual(["gdctx-artifacts", "gdctx-raw"]);
    const rawResult = report.targets.find((t) => t.id === "gdctx-raw");
    expect(rawResult?.entriesRemoved).toBe(1);
  });

  test("a discovery issue folds the report to incomplete even when every found target swept cleanly", async () => {
    const cwd = await project();
    await mkdir(path.join(cwd, ".metaproject", "data", "gdctx", "raw"), { recursive: true });
    await mkdir(path.join(cwd, ".metaproject", "data", "gdctx", "artifacts"), { recursive: true });
    const flaky: RetentionFsDeps = {
      ...defaultFsDeps,
      readdir: async (dir: string) => {
        if (dir.endsWith("workspaces")) {
          const error = new Error("denied") as NodeJS.ErrnoException;
          error.code = "EACCES";
          throw error;
        }
        return defaultFsDeps.readdir(dir);
      },
    };

    const report = await sweepProject(cwd, flaky, { dryRun: true });

    expect(report.status).toBe("incomplete");
    expect(report.discoveryIssues.length).toBe(1);
    // Both gdctx targets still swept fine — the issue is additive, not a
    // reason to hide the results this run DID get.
    expect(report.targets.every((t) => t.status === "ok" || t.status === "empty")).toBe(true);
  });

  test("--target filtering narrows to the requested target ids only", async () => {
    const cwd = await project();
    await mkdir(path.join(cwd, ".metaproject", "data", "gdctx", "raw"), { recursive: true });
    await mkdir(path.join(cwd, ".metaproject", "data", "gdctx", "artifacts"), { recursive: true });

    const report = await sweepProject(cwd, defaultFsDeps, { dryRun: true, targetIds: ["gdctx-raw"] });

    expect(report.targets.map((t) => t.id)).toEqual(["gdctx-raw"]);
  });
});

describe("cleanup", () => {
  test("temp dirs used by this suite are real directories under the OS tmp root", async () => {
    // Sanity check the fixture helper itself so a silent path bug in `project()`
    // does not make every other test above pass against the wrong directory.
    const cwd = await project();
    expect(cwd.startsWith(tmpdir())).toBe(true);
    await rm(cwd, { recursive: true, force: true });
  });
});
