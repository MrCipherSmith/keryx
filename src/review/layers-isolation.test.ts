import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { ensurePackageLayers } from "../commands/review-layers";
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
import {
  TRACKED_MEMORY_INDEX,
  createLayersFixture,
  git,
  readText,
  statusOutsidePackage,
  writeProjectFile,
  type LayersFixture,
} from "./layers.test-helpers";

let fixture: LayersFixture;
afterEach(async () => {
  await fixture.cleanup();
});

describe("the memory index of a refresh stays inside the package (R1-01)", () => {
  beforeEach(async () => {
    fixture = await createLayersFixture({ trackMemoryIndex: true });
  });

  test("a project that TRACKS its memory index keeps it byte for byte and a clean tree", async () => {
    const before = await readText(path.join(fixture.root, TRACKED_MEMORY_INDEX));
    expect(git(fixture.root, ["ls-files", TRACKED_MEMORY_INDEX])).toBe(TRACKED_MEMORY_INDEX);
    expect(statusOutsidePackage(fixture.root)).toBe("");

    const layers = await refreshLayers({ projectRoot: fixture.root, packageDir: fixture.packageDir });

    expect(layers.memory.status).toBe("ok");
    expect(layers.memory.entries).toBe(1);
    expect(await readText(path.join(fixture.root, TRACKED_MEMORY_INDEX))).toBe(before);
    expect(statusOutsidePackage(fixture.root)).toBe("");
    const own = JSON.parse(await readText(path.join(fixture.packageDir, "layers", "memory", "index.json")));
    expect(own.entryCount).toBe(1);
  });
});

describe("a refresh is atomic and exclusive (R1-02)", () => {
  beforeEach(async () => {
    fixture = await createLayersFixture();
  });

  test("while a rebuild runs the old graph stays in place, readers are refused, and nothing half-built is published", async () => {
    await refreshLayers({ projectRoot: fixture.root, packageDir: fixture.packageDir });
    const oldBuild = await readText(path.join(packageGraphDir(fixture.packageDir), "build.json"));

    const seen: { refused: boolean; oldBuildStillThere: boolean; lockHeld: boolean; staging: string[] } = {
      refused: false,
      oldBuildStillThere: false,
      lockHeld: false,
      staging: [],
    };
    const deps: Partial<LayerDeps> = {
      async buildGraph(root, options) {
        await loadPackageGraph(fixture.packageDir).catch((error: unknown) => {
          seen.refused = error instanceof PackageGraphError && /being refreshed/.test(error.message);
        });
        seen.lockHeld = existsSync(layersLockPath(fixture.packageDir));
        seen.oldBuildStillThere = (await readText(path.join(packageGraphDir(fixture.packageDir), "build.json"))) === oldBuild;
        seen.staging = readdirSync(path.join(fixture.packageDir, "layers")).filter((name) => /^graph\.[0-9a-f-]{36}$/.test(name));
        return buildGraph(root, options);
      },
    };
    await refreshLayers({ projectRoot: fixture.root, packageDir: fixture.packageDir, deps });

    expect(seen.refused).toBe(true);
    expect(seen.lockHeld).toBe(true);
    expect(seen.oldBuildStillThere).toBe(true);
    expect(seen.staging).toHaveLength(1);
    const names = readdirSync(path.join(fixture.packageDir, "layers"));
    expect(names.filter((name) => name.startsWith("graph."))).toEqual([]);
    expect(existsSync(layersLockPath(fixture.packageDir))).toBe(false);
    expect((await loadPackageGraph(fixture.packageDir)).layers.graph.status).toBe("ok");
  });

  test("two refreshes of one package run one after the other", async () => {
    let running = 0;
    let peak = 0;
    const deps: Partial<LayerDeps> = {
      async buildGraph(root, options) {
        running += 1;
        peak = Math.max(peak, running);
        await new Promise((resolve) => setTimeout(resolve, 60));
        try {
          return await buildGraph(root, options);
        } finally {
          running -= 1;
        }
      },
    };
    const run = () => refreshLayers({ projectRoot: fixture.root, packageDir: fixture.packageDir, deps });
    const [first, second] = await Promise.all([run(), run()]);
    expect(first.graph.status).toBe("ok");
    expect(second.graph.status).toBe("ok");
    expect(peak).toBe(1);
  });

  test("layers.json is replaced whole and leaves no temp file beside it", async () => {
    await refreshLayers({ projectRoot: fixture.root, packageDir: fixture.packageDir });
    const leftovers = readdirSync(fixture.packageDir).filter((name) => name.endsWith(".tmp"));
    expect(leftovers).toEqual([]);
    expect(JSON.parse(await readText(path.join(fixture.packageDir, "layers.json"))).version).toBe(1);
  });

  test("a build that throws keeps no staging directory behind", async () => {
    await refreshLayers({
      projectRoot: fixture.root,
      packageDir: fixture.packageDir,
      deps: {
        async buildGraph() {
          throw new Error("disk full");
        },
      },
    });
    const names = readdirSync(path.join(fixture.packageDir, "layers"));
    expect(names.filter((name) => name.startsWith("graph."))).toEqual([]);
  });
});

describe("the graph is built from the PR head, not the working copy (R1-03)", () => {
  beforeEach(async () => {
    fixture = await createLayersFixture();
  });

  test("untracked and uncommitted edits at HEAD == prHead do not reach the graph", async () => {
    await writeProjectFile(fixture.root, "src/dirty.ts", 'export const dirty = "untracked";\n');
    await writeProjectFile(fixture.root, "src/a.ts", "export const a = 1;\nexport const edited = 2;\n");
    expect(git(fixture.root, ["rev-parse", "HEAD"])).toBe(fixture.second);

    const layers = await refreshLayers({ projectRoot: fixture.root, packageDir: fixture.packageDir, prHead: fixture.second });
    expect(layers.graph.status).toBe("ok");

    const { graph } = await loadPackageGraph(fixture.packageDir, fixture.second);
    expect(graph.nodes.some((node) => node.path === "src/dirty.ts")).toBe(false);
    expect(JSON.stringify(graph)).not.toContain("edited");
    expect(readdirSync(fixture.root)).toContain("src");
    expect(git(fixture.root, ["worktree", "list", "--porcelain"]).split("\n").filter((line) => line.startsWith("worktree "))).toHaveLength(1);
  });

  test("a build root that is not at the PR head is refused", async () => {
    const wrong = "0123456789abcdef0123456789abcdef01234567";
    const layers = await refreshLayers({
      projectRoot: fixture.root,
      packageDir: fixture.packageDir,
      deps: {
        async git(cwd, args) {
          if (args[0] === "rev-parse" && args[1] === "HEAD" && cwd !== fixture.root) return wrong;
          return defaultLayerDeps.git(cwd, args);
        },
      },
    });
    expect(layers.graph.status).toBe("failed");
    expect(layers.graph.error).toContain("not the PR head");
    expect(layers.graphCommit).toBeNull();
  });
});

describe("one source for the PR head (R1-04)", () => {
  beforeEach(async () => {
    fixture = await createLayersFixture();
  });

  async function writeManifest(head: string): Promise<void> {
    await mkdir(fixture.packageDir, { recursive: true });
    await writeFile(path.join(fixture.packageDir, "manifest.json"), JSON.stringify({ target: { kind: "report", head } }), "utf8");
  }

  test("with no --head the package manifest's target.head wins over the checkout's HEAD", async () => {
    await writeManifest(fixture.first);
    expect(git(fixture.root, ["rev-parse", "HEAD"])).toBe(fixture.second);

    const layers = await refreshLayers({ projectRoot: fixture.root, packageDir: fixture.packageDir });
    expect(layers.prHead).toBe(fixture.first);
    expect(layers.headSource).toBe("manifest");
    expect(layers.graphCommit).toBe(fixture.first);
    expect((await loadPackageGraph(fixture.packageDir)).graph.nodes.some((node) => node.path === "src/c.ts")).toBe(false);
  });

  test("an explicit head beats the manifest, and a package with no manifest falls back to the checkout", async () => {
    await writeManifest(fixture.first);
    const explicit = await refreshLayers({ projectRoot: fixture.root, packageDir: fixture.packageDir, prHead: fixture.second });
    expect(explicit.prHead).toBe(fixture.second);
    expect(explicit.headSource).toBe("input");

    const bare = path.join(fixture.root, ".metaproject", "reviews", "bare");
    await mkdir(bare, { recursive: true });
    const fallback = await refreshLayers({ projectRoot: fixture.root, packageDir: bare });
    expect(fallback.prHead).toBe(fixture.second);
    expect(fallback.headSource).toBe("checkout");
  });

  test("ensurePackageLayers re-refreshes layers built for another head than the manifest's", async () => {
    await refreshLayers({ projectRoot: fixture.root, packageDir: fixture.packageDir, prHead: fixture.second });
    await writeManifest(fixture.first);

    const layers = await ensurePackageLayers(fixture.packageDir, { projectRoot: fixture.root });
    expect(layers.prHead).toBe(fixture.first);
    expect((await readLayers(fixture.packageDir))?.graphCommit).toBe(fixture.first);
  });
});
