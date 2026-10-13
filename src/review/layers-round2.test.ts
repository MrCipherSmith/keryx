import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, realpath, rename, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ensurePackageLayers } from "../commands/review-layers";
import { shellQuote, shellWord } from "../lib/shell-quote";
import { buildGraph } from "../gdgraph/build";
import {
  PackageGraphError,
  defaultLayerDeps,
  layersLockPath,
  loadPackageGraph,
  packageGraphDir,
  readLayers,
  refreshLayers,
  type LayerDeps,
} from "./layers";
import { createLayersFixture, git, type LayersFixture } from "./layers.test-helpers";

let fixture: LayersFixture;
beforeEach(async () => {
  fixture = await createLayersFixture();
});
afterEach(async () => {
  await fixture.cleanup();
});

const countingBuild = (): { deps: Partial<LayerDeps>; builds: () => number } => {
  let count = 0;
  return {
    deps: {
      async buildGraph(root, options) {
        count += 1;
        return buildGraph(root, options);
      },
    },
    builds: () => count,
  };
};

describe("the graph directory is verified, not assumed (R2-02)", () => {
  test("layers.json says ok but the graph directory is gone: the reader refuses and ensure rebuilds", async () => {
    await refreshLayers({ projectRoot: fixture.root, packageDir: fixture.packageDir });
    await rm(packageGraphDir(fixture.packageDir), { recursive: true, force: true });

    await expect(loadPackageGraph(fixture.packageDir)).rejects.toBeInstanceOf(PackageGraphError);
    await expect(loadPackageGraph(fixture.packageDir)).rejects.toThrow(/missing or does not match/);

    const layers = await ensurePackageLayers(fixture.packageDir, { projectRoot: fixture.root });
    expect(layers.graph.status).toBe("ok");
    expect((await loadPackageGraph(fixture.packageDir)).graph.nodes.length).toBeGreaterThan(0);
  });

  test("a build.json of another commit makes the graph unreadable", async () => {
    await refreshLayers({ projectRoot: fixture.root, packageDir: fixture.packageDir });
    await writeFile(path.join(packageGraphDir(fixture.packageDir), "build.json"), JSON.stringify({ commit: fixture.first }));
    await expect(loadPackageGraph(fixture.packageDir)).rejects.toThrow(/missing or does not match/);
  });

  test("a publish killed between its two renames is put back by the next refresh, without a rebuild", async () => {
    await refreshLayers({ projectRoot: fixture.root, packageDir: fixture.packageDir });
    const finalDir = packageGraphDir(fixture.packageDir);
    await rename(finalDir, `${finalDir}.old.killed`);
    await mkdir(`${finalDir}.stale-staging`, { recursive: true });

    const counted = countingBuild();
    const layers = await refreshLayers({ projectRoot: fixture.root, packageDir: fixture.packageDir, deps: counted.deps });

    expect(counted.builds()).toBe(0);
    expect(layers.graph.status).toBe("ok");
    expect(existsSync(path.join(finalDir, "build.json"))).toBe(true);
    const names = await readdir(path.join(fixture.packageDir, "layers"));
    expect(names.filter((name) => name.startsWith("graph."))).toEqual([]);
    expect((await loadPackageGraph(fixture.packageDir)).graph.nodes.length).toBeGreaterThan(0);
  });
});

describe("one spelling of the head (R2-03, R2-35)", () => {
  test("a short sha and a branch name are resolved to the full commit and the graph builds", async () => {
    for (const head of [fixture.second.slice(0, 8), "main"]) {
      const layers = await refreshLayers({ projectRoot: fixture.root, packageDir: fixture.packageDir, prHead: head, force: true });
      expect(layers.prHead).toBe(fixture.second);
      expect(layers.graph.status).toBe("ok");
      expect(layers.graphCommit).toBe(fixture.second);
    }
  });

  test("a short manifest head resolves too, and ensure reuses the record for it", async () => {
    await writeFile(path.join(fixture.packageDir, "manifest.json"), JSON.stringify({ target: { head: fixture.second.slice(0, 7) } }));
    const first = await ensurePackageLayers(fixture.packageDir, { projectRoot: fixture.root });
    expect(first.prHead).toBe(fixture.second);
    const refreshedAt = first.refreshedAt;
    const again = await ensurePackageLayers(fixture.packageDir, { projectRoot: fixture.root });
    expect(again.refreshedAt).toBe(refreshedAt);
  });
});

describe("reuse, force and failures (R2-12, R2-23, R2-25)", () => {
  test("a second refresh at the same head keeps the graph and still refreshes the other layers; force rebuilds", async () => {
    const counted = countingBuild();
    const run = (force?: boolean) =>
      refreshLayers({ projectRoot: fixture.root, packageDir: fixture.packageDir, deps: counted.deps, ...(force === undefined ? {} : { force }) });
    const first = await run();
    const second = await run();
    expect(counted.builds()).toBe(1);
    expect(second.graph).toEqual(first.graph);
    expect(second.memory.status).toBe("ok");
    await run(true);
    expect(counted.builds()).toBe(2);
  });

  test("a failed graph at the same head is retried by ensure, not returned as sticky", async () => {
    await refreshLayers({
      projectRoot: fixture.root,
      packageDir: fixture.packageDir,
      deps: {
        async buildGraph() {
          throw new Error("disk full");
        },
      },
    });
    expect((await readLayers(fixture.packageDir))?.graph.status).toBe("failed");
    const layers = await ensurePackageLayers(fixture.packageDir, { projectRoot: fixture.root });
    expect(layers.graph.status).toBe("ok");
  });

  test("a forced rebuild that fails keeps the previous intact graph record", async () => {
    const first = await refreshLayers({ projectRoot: fixture.root, packageDir: fixture.packageDir });
    const second = await refreshLayers({
      projectRoot: fixture.root,
      packageDir: fixture.packageDir,
      force: true,
      deps: {
        async buildGraph() {
          throw new Error("transient");
        },
      },
    });
    expect(second.graph).toEqual(first.graph);
    expect((await loadPackageGraph(fixture.packageDir)).layers.graph.status).toBe("ok");
  });
});

describe("the base of the wiki mark (R2-27)", () => {
  test("defaults to the manifest's target ref, else the parent of the head", async () => {
    const noManifest = await refreshLayers({ projectRoot: fixture.root, packageDir: fixture.packageDir });
    expect(noManifest.base).toBe(`${fixture.second}~1`);
    await writeFile(path.join(fixture.packageDir, "manifest.json"), JSON.stringify({ target: { kind: "report", ref: fixture.first, head: fixture.second } }));
    const withManifest = await refreshLayers({ projectRoot: fixture.root, packageDir: fixture.packageDir });
    expect(withManifest.base).toBe(fixture.first);
    await writeFile(path.join(fixture.packageDir, "manifest.json"), JSON.stringify({ target: { kind: "pr", ref: "PR 12", head: fixture.second } }));
    expect((await refreshLayers({ projectRoot: fixture.root, packageDir: fixture.packageDir })).base).toBe(`${fixture.second}~1`);
  });
});

describe("the checkout in the operator's repository (R2-14, R2-15)", () => {
  test("a failed add prunes and retries once; a successful one never prunes", async () => {
    const calls: string[][] = [];
    let failures = 1;
    const git: LayerDeps["git"] = async (cwd, args) => {
      calls.push(args);
      if (failures > 0 && args.includes("add")) {
        failures -= 1;
        return null;
      }
      return defaultLayerDeps.git(cwd, args);
    };
    const layers = await refreshLayers({ projectRoot: fixture.root, packageDir: fixture.packageDir, deps: { git } });
    expect(layers.graph.status).toBe("ok");
    const verbs = calls.map((args) => args.filter((arg) => ["add", "prune"].includes(arg))[0]).filter(Boolean);
    expect(verbs).toEqual(["add", "prune", "add"]);

    calls.length = 0;
    await refreshLayers({ projectRoot: fixture.root, packageDir: fixture.packageDir, force: true, deps: { git } });
    expect(calls.some((args) => args.includes("prune"))).toBe(false);
  });

  test("the operator's post-checkout hook does not run for the review checkout", async () => {
    const marker = path.join(fixture.root, "hook-ran");
    const hook = path.join(fixture.root, ".git", "hooks", "post-checkout");
    await writeFile(hook, `#!/bin/sh\necho ran > '${marker}'\n`, { mode: 0o755 });
    const layers = await refreshLayers({ projectRoot: fixture.root, packageDir: fixture.packageDir });
    expect(layers.graph.status).toBe("ok");
    expect(existsSync(marker)).toBe(false);
  });
});

describe("a killed refresh leaves nothing behind (R2-08)", () => {
  const registered = (): string[] =>
    git(fixture.root, ["worktree", "list", "--porcelain"])
      .split("\n")
      .filter((line) => line.startsWith("worktree "))
      .map((line) => line.slice("worktree ".length));

  test("a SIGTERM during the build removes the checkout, its registration, the staging directory and the lock", async () => {
    const ready = path.join(fixture.root, "ready.flag");
    const script = path.join(fixture.root, "child.ts");
    await writeFile(
      script,
      [
        `import { writeFileSync } from "node:fs";`,
        `import { refreshLayers } from ${JSON.stringify(path.resolve(import.meta.dir, "layers.ts"))};`,
        `await refreshLayers({ projectRoot: ${JSON.stringify(fixture.root)}, packageDir: ${JSON.stringify(fixture.packageDir)}, deps: {`,
        `  async buildGraph() { writeFileSync(${JSON.stringify(ready)}, "1"); await new Promise(() => {}); return { nodes: 0, edges: 0 }; },`,
        `} });`,
      ].join("\n"),
    );
    const child = spawn(process.execPath, ["run", script], { stdio: "ignore" });
    const exited = new Promise<NodeJS.Signals | null>((resolve) => child.on("exit", (_code, signal) => resolve(signal)));
    const deadline = Date.now() + 30_000;
    while (!existsSync(ready) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
    expect(existsSync(ready)).toBe(true);
    expect(registered()).toHaveLength(2);
    expect(existsSync(layersLockPath(fixture.packageDir))).toBe(true);

    child.kill("SIGTERM");
    expect(await exited).toBe("SIGTERM");

    expect(registered()).toHaveLength(1);
    expect(existsSync(layersLockPath(fixture.packageDir))).toBe(false);
    const names = await readdir(path.join(fixture.packageDir, "layers"));
    expect(names.filter((name) => name.startsWith("graph."))).toEqual([]);
  });

  test("the next refresh sweeps an old keryx checkout a SIGKILL left, and keeps a fresh one", async () => {
    const temp = await realpath(tmpdir());
    const old = await mkdtemp(path.join(temp, "keryx-layers-old-"));
    const fresh = await mkdtemp(path.join(temp, "keryx-layers-fresh-"));
    try {
      for (const dir of [old, fresh]) {
        await rm(dir, { recursive: true, force: true });
        git(fixture.root, ["worktree", "add", "--detach", dir, fixture.second]);
      }
      const longAgo = new Date(Date.now() - 2 * 60 * 60_000);
      await utimes(old, longAgo, longAgo);

      await refreshLayers({ projectRoot: fixture.root, packageDir: fixture.packageDir });

      expect(existsSync(old)).toBe(false);
      expect(registered()).not.toContain(old);
      expect(existsSync(fresh)).toBe(true);
      expect(registered()).toContain(fresh);
    } finally {
      git(fixture.root, ["worktree", "remove", "--force", fresh]);
      await rm(old, { recursive: true, force: true });
      await rm(fresh, { recursive: true, force: true });
    }
  });
});

describe("shell-quoted package directories in hints (R2-13)", () => {
  test("shellWord keeps a plain path and quotes anything a shell would split or run", () => {
    expect(shellWord("/tmp/pkg-1/a.b")).toBe("/tmp/pkg-1/a.b");
    expect(shellWord("/tmp/my pkg")).toBe("'/tmp/my pkg'");
    expect(shellWord("/tmp/a;rm -rf ~")).toBe("'/tmp/a;rm -rf ~'");
    expect(shellWord("-rf")).toBe("'-rf'");
    expect(shellWord("it's")).toBe(shellQuote("it's"));
  });

  test("the refusal hint of a package with a space in its path is one shell word", async () => {
    const dir = path.join(fixture.root, ".metaproject", "reviews", "with space");
    await mkdir(dir, { recursive: true });
    await expect(loadPackageGraph(dir)).rejects.toThrow(`--package '${dir}'`);
  });
});
