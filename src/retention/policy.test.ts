// RED first: written against `./policy`, which does not exist yet.

import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { defaultFsDeps } from "./fs-deps";
import {
  DEFAULT_MAX_AGE_DAYS,
  discoverOwnerConflictTargets,
  discoverTargets,
  gdctxTargets,
  OWNER_CONFLICT_MAX_AGE_DAYS,
} from "./policy";

async function project(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "retention-policy-"));
}

describe("gdctxTargets", () => {
  test("names the raw and artifacts directories with their own age/byte caps", () => {
    const cwd = "/repo";
    const targets = gdctxTargets(cwd);
    expect(targets.map((t) => t.id).sort()).toEqual(["gdctx-artifacts", "gdctx-raw"]);
    const raw = targets.find((t) => t.id === "gdctx-raw");
    expect(raw?.dir).toBe(path.join(cwd, ".metaproject", "data", "gdctx", "raw"));
    expect(raw?.unit).toBe("file");
    expect(raw?.maxAgeDays).toBe(DEFAULT_MAX_AGE_DAYS);
    const artifacts = targets.find((t) => t.id === "gdctx-artifacts");
    expect(artifacts?.dir).toBe(path.join(cwd, ".metaproject", "data", "gdctx", "artifacts"));
    // Raw logs run larger than their compact summaries; the byte caps say so.
    expect(raw?.maxBytes).toBeGreaterThan(artifacts?.maxBytes ?? 0);
  });
});

describe("discoverOwnerConflictTargets", () => {
  test("finds every <owner>-write-conflicts directory under every workspace", async () => {
    const cwd = await project();
    await mkdir(path.join(cwd, ".metaproject", "workspaces", "ws-1", "memory-write-conflicts"), { recursive: true });
    await mkdir(path.join(cwd, ".metaproject", "workspaces", "ws-1", "proposals"), { recursive: true });
    await mkdir(path.join(cwd, ".metaproject", "workspaces", "ws-2", "wiki-write-conflicts"), { recursive: true });
    await mkdir(path.join(cwd, ".metaproject", "workspaces", "ws-2", "session-evidence"), { recursive: true });

    const result = await discoverOwnerConflictTargets(cwd, defaultFsDeps);

    expect(result.issues).toEqual([]);
    expect(result.targets.length).toBe(2);
    expect(result.targets.every((t) => t.unit === "directory")).toBe(true);
    expect(result.targets.every((t) => t.maxAgeDays === OWNER_CONFLICT_MAX_AGE_DAYS)).toBe(true);
    const dirs = result.targets.map((t) => t.dir).sort();
    expect(dirs).toEqual(
      [
        path.join(cwd, ".metaproject", "workspaces", "ws-1", "memory-write-conflicts"),
        path.join(cwd, ".metaproject", "workspaces", "ws-2", "wiki-write-conflicts"),
      ].sort(),
    );
  });

  test("an absent workspaces directory discovers nothing rather than throwing, and raises no issue", async () => {
    const cwd = await project();
    const result = await discoverOwnerConflictTargets(cwd, defaultFsDeps);
    expect(result).toEqual({ targets: [], issues: [] });
  });

  test("an unreadable single workspace is reported as an issue but does not stop discovery of the rest", async () => {
    const cwd = await project();
    await mkdir(path.join(cwd, ".metaproject", "workspaces", "ws-1", "memory-write-conflicts"), { recursive: true });
    await mkdir(path.join(cwd, ".metaproject", "workspaces", "ws-2", "wiki-write-conflicts"), { recursive: true });

    const flaky = {
      ...defaultFsDeps,
      readdir: async (dir: string) => {
        if (dir.endsWith(path.join("workspaces", "ws-1"))) {
          const error = new Error("denied") as NodeJS.ErrnoException;
          error.code = "EACCES";
          throw error;
        }
        return defaultFsDeps.readdir(dir);
      },
    };

    const result = await discoverOwnerConflictTargets(cwd, flaky);
    expect(result.targets.map((t) => t.dir)).toEqual([path.join(cwd, ".metaproject", "workspaces", "ws-2", "wiki-write-conflicts")]);
    expect(result.issues.length).toBe(1);
    expect(result.issues[0]).toContain("ws-1");
    expect(result.issues[0]).toContain("EACCES");
  });

  test("an unreadable workspaces directory itself (not just absent) is a discovery issue, not a silent empty result", async () => {
    const cwd = await project();
    const flaky = {
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

    const result = await discoverOwnerConflictTargets(cwd, flaky);
    expect(result.targets).toEqual([]);
    expect(result.issues.length).toBe(1);
    expect(result.issues[0]).toContain("EACCES");
  });
});

describe("discoverTargets", () => {
  test("combines the static gdctx targets with discovered owner-conflict targets", async () => {
    const cwd = await project();
    await mkdir(path.join(cwd, ".metaproject", "workspaces", "ws-1", "memory-write-conflicts"), { recursive: true });

    const result = await discoverTargets(cwd, defaultFsDeps);

    expect(result.targets.some((t) => t.id === "gdctx-raw")).toBe(true);
    expect(result.targets.some((t) => t.id === "gdctx-artifacts")).toBe(true);
    expect(result.targets.some((t) => t.dir.endsWith("memory-write-conflicts"))).toBe(true);
    expect(result.issues).toEqual([]);
  });

  test("surfaces owner-conflict discovery issues alongside the target list", async () => {
    const cwd = await project();
    const flaky = {
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

    const result = await discoverTargets(cwd, flaky);
    expect(result.issues.length).toBe(1);
    // The static gdctx targets are still present — discovery failing for one
    // store does not hide the others.
    expect(result.targets.some((t) => t.id === "gdctx-raw")).toBe(true);
  });
});
