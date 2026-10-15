import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import path from "node:path";
import { loadPackageGraph, readLayers, refreshLayers } from "./layers";
import { createLayersFixture, git, type LayersFixture } from "./layers.test-helpers";

let fixture: LayersFixture;
beforeEach(async () => {
  fixture = await createLayersFixture();
});
afterEach(async () => {
  await fixture.cleanup();
});

describe("a layer refresh builds the graph at the PR head (AC3)", () => {
  test("a checkout at another commit, with no storage/, still yields a graph at the PR head", async () => {
    git(fixture.root, ["checkout", "-q", "--detach", fixture.first]);
    expect(existsSync(path.join(fixture.root, ".metaproject", "data", "gdgraph", "storage"))).toBe(false);

    const layers = await refreshLayers({
      projectRoot: fixture.root,
      packageDir: fixture.packageDir,
      prHead: fixture.second,
    });

    expect(layers.prHead).toBe(fixture.second);
    expect(layers.graphCommit).toBe(fixture.second);
    expect(layers.graph.status).toBe("ok");
    const loaded = await loadPackageGraph(fixture.packageDir, fixture.second);
    expect(loaded.graph.nodes.map((node) => node.path)).toContain("src/c.ts");
    expect(git(fixture.root, ["rev-parse", "HEAD"])).toBe(fixture.first);
    expect(git(fixture.root, ["worktree", "list", "--porcelain"]).split("\n").filter((l) => l.startsWith("worktree "))).toHaveLength(1);
  });

  test("the graph is the PR head's even when the checkout is behind it", async () => {
    git(fixture.root, ["checkout", "-q", "--detach", fixture.first]);
    await refreshLayers({ projectRoot: fixture.root, packageDir: fixture.packageDir, prHead: fixture.second });
    const atFirst = await refreshLayers({
      projectRoot: fixture.root,
      packageDir: fixture.packageDir,
      prHead: fixture.first,
    });
    const loaded = await loadPackageGraph(fixture.packageDir, fixture.first);
    expect(atFirst.graphCommit).toBe(fixture.first);
    expect(loaded.graph.nodes.map((node) => node.path)).not.toContain("src/c.ts");
  });

  test("a graph from another commit is never read", async () => {
    await refreshLayers({ projectRoot: fixture.root, packageDir: fixture.packageDir, prHead: fixture.second });
    await expect(loadPackageGraph(fixture.packageDir, fixture.first)).rejects.toThrow();
  });

  test("a PR head git cannot check out marks the layer failed, not stale-but-readable", async () => {
    const missing = "0123456789abcdef0123456789abcdef01234567";
    const layers = await refreshLayers({ projectRoot: fixture.root, packageDir: fixture.packageDir, prHead: missing });
    expect(layers.graph.status).toBe("failed");
    expect(layers.graphCommit).toBeNull();
    expect((await readLayers(fixture.packageDir))?.graph.status).toBe("failed");
    await expect(loadPackageGraph(fixture.packageDir)).rejects.toThrow();
  });
});
