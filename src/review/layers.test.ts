import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  PackageGraphError,
  loadPackageGraph,
  readLayers,
  refreshLayers,
  type LayerDeps,
} from "./layers";
import { createLayersFixture, type LayersFixture } from "./layers.test-helpers";

let fixture: LayersFixture;
beforeEach(async () => {
  fixture = await createLayersFixture();
});
afterEach(async () => {
  await fixture.cleanup();
});

describe("refreshLayers (AC1)", () => {
  test("rebuilds the graph and writes layers.json with per-layer commit, time and counts", async () => {
    const layers = await refreshLayers({ projectRoot: fixture.root, packageDir: fixture.packageDir });

    expect(layers.prHead).toBe(fixture.second);
    expect(layers.graph.status).toBe("ok");
    expect(layers.graph.commit).toBe(fixture.second);
    expect(layers.graph.nodes).toBeGreaterThanOrEqual(3);
    expect(layers.graph.edges).toBeGreaterThanOrEqual(2);
    expect(Date.parse(layers.graph.builtAt ?? "")).not.toBeNaN();
    expect(layers.wiki.status).toBe("ok");
    expect(typeof layers.wiki.pagesRefreshed).toBe("number");
    expect(layers.wiki).toHaveProperty("pagesStaleProse");
    expect(layers.memory.status).toBe("ok");
    expect(layers.memory.entries).toBe(1);

    const onDisk = JSON.parse(await readFile(path.join(fixture.packageDir, "layers.json"), "utf8"));
    expect(onDisk).toEqual(layers);
    expect(await readLayers(fixture.packageDir)).toEqual(layers);
  });

  test("the wiki refresh is a dry run by default and the memory count comes from the index", async () => {
    const seen: { dryRun: unknown[] } = { dryRun: [] };
    const deps: Partial<LayerDeps> = {
      async indexMemory(cwd, indexDir) {
        expect(cwd).toBe(fixture.root);
        expect(indexDir).toBe(path.join(fixture.packageDir, "layers", "memory"));
        return { entryCount: 7 };
      },
      async refreshWiki(input) {
        seen.dryRun.push(input.dryRun);
        return { pages: [], refreshed: 2, unchanged: 0, conflicts: 0, staleSource: 0, source: { status: "fresh", reasons: [], stampedAt: null } };
      },
    };
    const layers = await refreshLayers({ projectRoot: fixture.root, packageDir: fixture.packageDir, deps });
    expect(seen.dryRun).toEqual([true]);
    expect(layers.memory.entries).toBe(7);
    expect(layers.wiki.pagesRefreshed).toBe(2);
    expect(layers.wiki.written).toBe(false);
  });

  test("a failed rebuild is written as graph: failed with the error, and the other layers still run", async () => {
    const layers = await refreshLayers({
      projectRoot: fixture.root,
      packageDir: fixture.packageDir,
      deps: {
        async buildGraph() {
          throw new Error("disk full");
        },
      },
    });
    expect(layers.graph.status).toBe("failed");
    expect(layers.graph.error).toContain("disk full");
    expect(layers.graphCommit).toBeNull();
    expect(layers.wiki.status).toBe("skipped");
    expect(layers.memory.status).toBe("ok");
    expect((await readLayers(fixture.packageDir))?.graph.status).toBe("failed");
  });

  test("loadPackageGraph refuses a failed graph, and a missing layers.json", async () => {
    await expect(loadPackageGraph(fixture.packageDir)).rejects.toBeInstanceOf(PackageGraphError);
    await refreshLayers({
      projectRoot: fixture.root,
      packageDir: fixture.packageDir,
      deps: {
        async buildGraph() {
          throw new Error("boom");
        },
      },
    });
    await expect(loadPackageGraph(fixture.packageDir)).rejects.toThrow(/failed/);
  });

  test("loadPackageGraph returns the graph built at the PR head and refuses another commit", async () => {
    await refreshLayers({ projectRoot: fixture.root, packageDir: fixture.packageDir });
    const loaded = await loadPackageGraph(fixture.packageDir, fixture.second);
    expect(loaded.graph.nodes.some((node) => node.path === "src/c.ts")).toBe(true);
    await expect(loadPackageGraph(fixture.packageDir, fixture.first)).rejects.toThrow(/not /);
  });
});

// The wiki enrich step and its deep variant call a model. gdgraph/enrich is tree-sitter symbol extraction, build.ts imports it, and it calls none.
const MODEL_STEPS = /[\\/]wiki[\\/](deep-)?enrich/;

describe("the refresh reaches no model (AC1)", () => {
  test("no module in the review layer import closure imports wiki enrich", async () => {
    const { readFileSync, existsSync } = await import("node:fs");
    const transpiler = new Bun.Transpiler({ loader: "ts" });
    const srcRoot = path.join(import.meta.dir, "..");
    const seen = new Set<string>();
    const offenders: string[] = [];
    const queue = [
      ...["layers", "layers-payload", "layers-usage", "layers-view", "chunks", "chunks-estimate", "coverage-complete"].map((name) => path.join(import.meta.dir, `${name}.ts`)),
      ...["review-layers", "review-chunks"].map((name) => path.join(srcRoot, "commands", `${name}.ts`)),
    ];
    while (queue.length > 0) {
      const file = queue.pop()!;
      if (seen.has(file)) continue;
      seen.add(file);
      const source = readFileSync(file, "utf8");
      for (const entry of transpiler.scanImports(source)) {
        if (!entry.path.startsWith(".")) continue;
        const resolved = path.resolve(path.dirname(file), entry.path);
        const candidate = [`${resolved}.ts`, path.join(resolved, "index.ts")].find((c) => existsSync(c));
        if (candidate === undefined) continue;
        if (MODEL_STEPS.test(candidate)) offenders.push(`${path.relative(srcRoot, file)} -> ${path.relative(srcRoot, candidate)}`);
        queue.push(candidate);
      }
    }
    expect(offenders).toEqual([]);
    expect(seen.size).toBeGreaterThan(20);
  });

  test("the review modules do not mention wiki enrich in an import", async () => {
    const { readdirSync, readFileSync } = await import("node:fs");
    const reviewFiles = readdirSync(import.meta.dir).filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"));
    const importers = reviewFiles.filter((name) =>
      /from\s+["'][^"']*wiki\/(deep-)?enrich/.test(readFileSync(path.join(import.meta.dir, name), "utf8")),
    );
    expect(importers).toEqual([]);
  });
});
