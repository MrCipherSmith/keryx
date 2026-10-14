import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdir, rm, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { defaultLayerDeps, layersLockPath, readLayers, refreshLayers, resolveCommit, type LayerDeps } from "./layers";
import { createLayersFixture, git, type LayersFixture } from "./layers.test-helpers";

let fixture: LayersFixture;
beforeEach(async () => {
  fixture = await createLayersFixture();
});
afterEach(async () => {
  await fixture.cleanup();
});

describe("the throwaway checkout is made without the operator's hooks or fsmonitor (R3-21)", () => {
  test("worktree add carries core.hooksPath=/dev/null and core.fsmonitor=false", async () => {
    const adds: string[][] = [];
    const deps: Partial<LayerDeps> = {
      git: (cwd, args) => {
        if (args.includes("worktree") && args.includes("add")) adds.push(args);
        return defaultLayerDeps.git(cwd, args);
      },
    };
    await refreshLayers({ projectRoot: fixture.root, packageDir: fixture.packageDir, prHead: fixture.second, deps });
    expect(adds.length).toBeGreaterThan(0);
    for (const args of adds) {
      expect(args.slice(0, 4)).toEqual(["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false"]);
    }
  });
});

describe("a head named by a ref resolves to a commit, never to a tag object (R3-21)", () => {
  test("an annotated tag resolves to the commit it points at", async () => {
    git(fixture.root, ["tag", "-a", "v1", "-m", "release", fixture.first]);
    const tagObject = git(fixture.root, ["rev-parse", "v1"]);
    expect(tagObject).not.toBe(fixture.first);
    expect(await resolveCommit(fixture.root, "v1")).toBe(fixture.first);
  });

  test("a refresh at an annotated tag records the commit as the head", async () => {
    git(fixture.root, ["tag", "-a", "v1", "-m", "release", fixture.first]);
    const layers = await refreshLayers({ projectRoot: fixture.root, packageDir: fixture.packageDir, prHead: "v1" });
    expect(layers.prHead).toBe(fixture.first);
    expect(layers.graphCommit).toBe(fixture.first);
  });
});

describe("the refresh lock outlives a quiet minute of a live refresh (R3-21)", () => {
  test("a lock 45 s old whose owner is gone is still waited on, not reclaimed", async () => {
    const dead = spawnSync(process.execPath, ["-e", "0"]);
    const lock = layersLockPath(fixture.packageDir);
    await mkdir(lock, { recursive: true });
    await writeFile(path.join(lock, "owner.json"), JSON.stringify({ pid: dead.pid, token: "gone" }), "utf8");
    const old = new Date(Date.now() - 45_000);
    await utimes(lock, old, old);

    let finished = false;
    const refresh = refreshLayers({ projectRoot: fixture.root, packageDir: fixture.packageDir, prHead: fixture.second }).then((layers) => {
      finished = true;
      return layers;
    });
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(finished).toBe(false);

    await rm(lock, { recursive: true, force: true });
    const layers = await refresh;
    expect(layers.graph.status).toBe("ok");
    expect((await readLayers(fixture.packageDir))?.prHead).toBe(fixture.second);
  }, 30_000);
});
