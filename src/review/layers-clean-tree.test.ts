import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import path from "node:path";
import { loadPackageGraph, packageGraphDir, refreshLayers } from "./layers";
import {
  TRACKED_GRAPH_ARTIFACTS,
  createLayersFixture,
  git,
  readText,
  statusOutsidePackage,
  type LayersFixture,
} from "./layers.test-helpers";

let fixture: LayersFixture;
beforeEach(async () => {
  fixture = await createLayersFixture();
});
afterEach(async () => {
  await fixture.cleanup();
});

describe("a layer refresh leaves the working tree and the PR untouched (AC2)", () => {
  test("tracked graph artifacts stay byte for byte, the tree stays clean, the diff is unchanged", async () => {
    const before = await Promise.all(TRACKED_GRAPH_ARTIFACTS.map((file) => readText(path.join(fixture.root, file))));
    const diffBefore = git(fixture.root, ["diff", `${fixture.first}...HEAD`]);
    expect(statusOutsidePackage(fixture.root)).toBe("");

    const layers = await refreshLayers({ projectRoot: fixture.root, packageDir: fixture.packageDir });
    expect(layers.graph.status).toBe("ok");

    const after = await Promise.all(TRACKED_GRAPH_ARTIFACTS.map((file) => readText(path.join(fixture.root, file))));
    expect(after).toEqual(before);
    expect(statusOutsidePackage(fixture.root)).toBe("");
    expect(git(fixture.root, ["diff", `${fixture.first}...HEAD`])).toBe(diffBefore);
    expect(existsSync(path.join(fixture.root, ".metaproject", "data", "gdgraph", "storage"))).toBe(false);
  });

  test("the package keeps its own graph and ignores it, so it is never staged", async () => {
    await refreshLayers({ projectRoot: fixture.root, packageDir: fixture.packageDir });
    expect(existsSync(path.join(packageGraphDir(fixture.packageDir), "storage", "nodes.jsonl"))).toBe(true);
    expect(await readText(path.join(fixture.packageDir, "layers", ".gitignore"))).toBe("*\n");
    const untracked = git(fixture.root, ["status", "--porcelain", "-uall", "--", ".metaproject/reviews"]);
    expect(untracked).not.toContain("storage");
    expect(untracked).not.toContain("layers/graph");
  });

  test("graph readers answer from the package graph, not the project's", async () => {
    await refreshLayers({ projectRoot: fixture.root, packageDir: fixture.packageDir });
    const { buildAffectedReport } = await import("../gdgraph/affected-report");
    const { dataDir } = await loadPackageGraph(fixture.packageDir);
    const report = await buildAffectedReport(fixture.root, "src/a.ts", { dataDir });
    const text = JSON.stringify(report);
    expect(text).toContain("src/b.ts");
    expect(existsSync(path.join(fixture.root, ".metaproject", "data", "gdgraph", "storage"))).toBe(false);
  });
});
