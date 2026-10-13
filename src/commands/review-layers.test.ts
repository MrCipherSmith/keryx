import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createLayersFixture, git, type LayersFixture } from "../review/layers.test-helpers";
import { layersLockPath, layersRefreshInFlight, readLayers, refreshLayers } from "../review/layers";
import { ensurePackageLayers } from "./review-layers";
import { reviewCommand } from "./review";

let fixture: LayersFixture;
let previousCwd: string;
let logs: string[];
let errors: string[];

beforeEach(async () => {
  fixture = await createLayersFixture();
  previousCwd = process.cwd();
  process.chdir(fixture.root);
  logs = [];
  spyOn(console, "log").mockImplementation((...parts: unknown[]) => {
    logs.push(parts.join(" "));
  });
  errors = [];
  spyOn(console, "error").mockImplementation((...parts: unknown[]) => {
    errors.push(parts.join(" "));
  });
  process.exitCode = 0;
});
afterEach(async () => {
  process.chdir(previousCwd);
  process.exitCode = 0;
  (console.log as unknown as { mockRestore(): void }).mockRestore();
  (console.error as unknown as { mockRestore(): void }).mockRestore();
  await fixture.cleanup();
});

describe("keryx review layers", () => {
  test("refresh writes layers.json for the package and prints the lines", async () => {
    await reviewCommand(["layers", "refresh", "--package", fixture.packageDir]);
    const layers = await readLayers(fixture.packageDir);
    expect(layers?.graph.status).toBe("ok");
    expect(layers?.graphCommit).toBe(fixture.second);
    const output = logs.join("\n");
    expect(output).toContain("graph: ok");
    expect(output).toContain("wiki: ok");
    expect(output).toContain("memory: ok");
    expect(existsSync(path.join(fixture.root, ".metaproject", "data", "gdgraph", "storage"))).toBe(false);
  });

  test("status refuses a package with no layers.json", async () => {
    await reviewCommand(["layers", "status", "--package", fixture.packageDir]);
    expect(process.exitCode).toBe(1);
    expect(logs.join("\n")).toContain("no layers.json");
  });

  test("an unknown flag is refused and nothing is refreshed", async () => {
    await reviewCommand(["layers", "refresh", "--package", fixture.packageDir, "--nope"]);
    expect(process.exitCode).toBe(1);
    expect(existsSync(path.join(fixture.packageDir, "layers.json"))).toBe(false);
  });
});

describe("--package of the layers, chunks and coverage commands stays inside the project (AC8)", () => {
  let outside: string;
  beforeEach(async () => {
    outside = await mkdtemp(path.join(tmpdir(), "keryx-package-outside-"));
    await symlink(outside, path.join(fixture.root, "linked-out"));
    await mkdir(path.join(path.dirname(fixture.root), "escape"), { recursive: true });
  });
  afterEach(async () => {
    await rm(outside, { recursive: true, force: true });
    await rm(path.join(path.dirname(fixture.root), "escape"), { recursive: true, force: true });
  });

  const commands: Array<[string, string[]]> = [
    ["layers refresh", ["layers", "refresh"]],
    ["layers status", ["layers", "status"]],
    ["chunks plan", ["chunks", "plan"]],
    ["coverage", ["coverage"]],
  ];

  for (const [name, head] of commands) {
    for (const where of ["outside", "linked-out", "../escape"] as const) {
      test(`${name} refuses --package ${where} and writes nothing`, async () => {
        const target = where === "outside" ? outside : where;
        await reviewCommand([...head, "--package", target]);
        expect(process.exitCode).toBe(1);
        expect(errors.join("\n")).toMatch(/outside|inside|contain|within/i);
        expect(errors.join("\n")).not.toMatch(/not a directory/i);
        expect(await readdir(outside)).toEqual([]);
      });
    }
  }
});

describe("blast-radius --package reads the package graph", () => {
  test("refreshes a package that has none and computes the radius from its graph", async () => {
    await reviewCommand(["blast-radius", "--package", fixture.packageDir, "--changed", "src/a.ts", "--json", "--no-related-tests"]);
    expect(existsSync(path.join(fixture.packageDir, "layers.json"))).toBe(true);
    const radius = JSON.parse(logs.join("\n")) as { files?: unknown };
    expect(JSON.stringify(radius)).toContain("src/b.ts");
    expect(git(fixture.root, ["rev-parse", "HEAD"])).toBe(fixture.second);
  });

  test("a graph that failed to build is a refusal, not an empty radius", async () => {
    const missing = "0123456789abcdef0123456789abcdef01234567";
    await reviewCommand(["layers", "refresh", "--package", fixture.packageDir, "--head", missing]);
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
    logs.length = 0;
    await writeFile(path.join(fixture.packageDir, "manifest.json"), JSON.stringify({ target: { head: missing } }));
    await reviewCommand(["blast-radius", "--package", fixture.packageDir, "--changed", "src/a.ts", "--no-related-tests", "--json"]);
    expect(process.exitCode).toBe(1);
    expect(errors.join("\n")).toMatch(/graph is failed|not computed from a graph/);
    expect(logs.join("\n")).not.toContain("src/b.ts");
  });
});

describe("the refresh lock (R2-10, R2-11)", () => {
  const holdLock = async (ageMs: number, pid: number): Promise<string> => {
    const lock = layersLockPath(fixture.packageDir);
    await mkdir(lock, { recursive: true });
    await writeFile(path.join(lock, "owner.json"), JSON.stringify({ pid, token: "other" }));
    const at = new Date(Date.now() - ageMs);
    await utimes(lock, at, at);
    return lock;
  };
  const deadPid = async (): Promise<number> => {
    const child = Bun.spawn([process.execPath, "-e", "0"]);
    await child.exited;
    return child.pid;
  };

  test("ensurePackageLayers refuses while a live refresh holds the lock, and goes on once it is released (R2-10)", async () => {
    const lock = await holdLock(0, process.pid);
    expect(await layersRefreshInFlight(fixture.packageDir)).toBe(true);
    await expect(ensurePackageLayers(fixture.packageDir, { projectRoot: fixture.root, waitMs: 120 })).rejects.toThrow(/still being refreshed/);
    expect(existsSync(path.join(fixture.packageDir, "layers.json"))).toBe(false);

    await rm(lock, { recursive: true, force: true });
    const layers = await ensurePackageLayers(fixture.packageDir, { projectRoot: fixture.root, waitMs: 120 });
    expect(layers.graph.status).toBe("ok");
  });

  test("ensurePackageLayers picks the result up when the holder finishes within the wait (R2-10)", async () => {
    const lock = await holdLock(0, process.pid);
    setTimeout(() => void rm(lock, { recursive: true, force: true }), 150);
    const layers = await ensurePackageLayers(fixture.packageDir, { projectRoot: fixture.root, waitMs: 5000 });
    expect(layers.graph.status).toBe("ok");
  });

  test("a lock that is old and whose owner is dead is not in flight, and a refresh takes it over (R2-11)", async () => {
    await holdLock(10 * 60_000, await deadPid());
    expect(await layersRefreshInFlight(fixture.packageDir)).toBe(false);
    const layers = await refreshLayers({ projectRoot: fixture.root, packageDir: fixture.packageDir });
    expect(layers.graph.status).toBe("ok");
    expect(existsSync(layersLockPath(fixture.packageDir))).toBe(false);
  });

  test("an old lock whose owner is still alive stays in flight, and a fresh one does too (R2-11)", async () => {
    await holdLock(10 * 60_000, process.pid);
    expect(await layersRefreshInFlight(fixture.packageDir)).toBe(true);
    await rm(layersLockPath(fixture.packageDir), { recursive: true, force: true });
    await holdLock(1_000, await deadPid());
    expect(await layersRefreshInFlight(fixture.packageDir)).toBe(true);
  });
});
