// LWG wiki layer (flow 223, phase 0): AC1, AC5, AC6, AC7, AC10, AC13.

import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildGraph } from "./build";
import { getFilesDescribedBy, getPagesDescribing, loadGraph } from "./query";
import type { GraphData } from "./types";
import { buildWikiLayer, computeFingerprints, wikiPageId } from "./wiki-layer";

const GRAPH: GraphData = {
  nodes: [
    { id: "src/ctx/index.ts", kind: "file", path: "src/ctx/index.ts", language: "typescript" },
    { id: "src/ctx/run.ts", kind: "file", path: "src/ctx/run.ts", language: "typescript" },
    { id: "logo.png", kind: "asset", path: "logo.png", language: "asset" },
  ],
  edges: [],
};

function page(relativePath: string, overrides: Partial<{ title: string; pageType: string }> = {}) {
  return {
    relativePath,
    title: overrides.title ?? relativePath,
    pageType: overrides.pageType ?? "component",
    status: "accepted" as string | null,
    version: "1.0.0" as string | null,
  };
}

describe("buildWikiLayer", () => {
  test("AC1: emits a page node per page and describes edges for resolved paths", () => {
    const layer = buildWikiLayer({
      projectRoot: "/x",
      graph: GRAPH,
      validModules: new Set(["src/ctx"]),
      pages: [page("components/src-ctx.md")],
      pageContents: new Map([
        ["components/src-ctx.md", "Describes:\n  - src/ctx/index.ts\n  - src/ctx/run.ts\n"],
      ]),
    });

    expect(layer.pages).toHaveLength(1);
    expect(layer.pages[0]?.id).toBe("wiki:components/src-ctx.md");
    expect(layer.pages[0]?.undecidable).toBe(false);
    expect(layer.describes.map((edge) => edge.to)).toEqual(["src/ctx/index.ts", "src/ctx/run.ts"]);
    expect(layer.describes.every((edge) => edge.origin === "frontmatter")).toBe(true);
  });

  test("AC6: an unbuilt graph yields an EMPTY layer, not a layer of orphans", () => {
    const layer = buildWikiLayer({
      projectRoot: "/x",
      graph: GRAPH,
      validModules: undefined,
      pages: [page("components/src-ctx.md")],
      pageContents: new Map([["components/src-ctx.md", "Describes:\n  - src/ctx/index.ts\n"]]),
    });

    // The dangerous alternative is one page node per page marked undecidable:
    // that reads downstream as "every page describes nothing", i.e. everything
    // is orphaned. Absent information must stay absent.
    expect(layer).toEqual({ pages: [], describes: [] });
  });

  test("AC5: the module set drives the layer — a stubbed set changes the output", () => {
    const withModules = buildWikiLayer({
      projectRoot: "/x",
      graph: GRAPH,
      validModules: new Set(["src/ctx"]),
      pages: [page("components/src-ctx.md")],
      pageContents: new Map([["components/src-ctx.md", "# Page\n"]]),
    });
    const withoutModules = buildWikiLayer({
      projectRoot: "/x",
      graph: GRAPH,
      validModules: undefined,
      pages: [page("components/src-ctx.md")],
      pageContents: new Map([["components/src-ctx.md", "# Page\n"]]),
    });
    expect(withModules.pages.length).not.toBe(withoutModules.pages.length);
  });

  test("AC10: a page describing nothing is undecidable and emits no edges", () => {
    const layer = buildWikiLayer({
      projectRoot: "/x",
      graph: GRAPH,
      validModules: new Set(["src/ctx"]),
      pages: [page("architecture/overview.md", { pageType: "architecture" })],
      pageContents: new Map([["architecture/overview.md", "# Overview\nStatus: accepted\n"]]),
    });

    expect(layer.pages[0]?.undecidable).toBe(true);
    expect(layer.describes).toEqual([]);
  });

  test("asset nodes are never describable targets", () => {
    const layer = buildWikiLayer({
      projectRoot: "/x",
      graph: GRAPH,
      validModules: new Set(["src/ctx"]),
      pages: [page("components/x.md")],
      pageContents: new Map([["components/x.md", "Describes:\n  - logo.png\n"]]),
    });
    expect(layer.describes).toEqual([]);
    expect(layer.pages[0]?.undecidable).toBe(true);
  });
});

describe("computeFingerprints (AC7)", () => {
  test("hashes are content-derived, stable and sorted by path", () => {
    const records = [
      { path: "b.ts", content: "export const b = 1;\n" },
      { path: "a.ts", content: "export const a = 1;\n" },
    ];
    const first = computeFingerprints(records, new Map([["a.ts", 5]]));
    const second = computeFingerprints(records, new Map([["a.ts", 5]]));

    expect(first.map((f) => f.path)).toEqual(["a.ts", "b.ts"]);
    expect(first).toEqual(second);
    expect(first[0]?.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(first[0]?.contentHash).not.toBe(first[1]?.contentHash);
    // A file whose mtime could not be read is recorded as 0, not dropped.
    expect(first[1]?.mtimeMs).toBe(0);
  });
});

describe("reverse queries (AC3)", () => {
  const graph: GraphData = {
    ...GRAPH,
    describes: [
      { id: "d1", from: wikiPageId("components/a.md"), to: "src/ctx/index.ts", pattern: "src/ctx", origin: "key-files" },
      { id: "d2", from: wikiPageId("components/b.md"), to: "src/ctx/index.ts", pattern: "src/ctx/index.ts", origin: "frontmatter" },
      { id: "d3", from: wikiPageId("components/b.md"), to: "src/ctx/run.ts", pattern: "src/ctx/run.ts", origin: "frontmatter" },
    ],
  };

  test("a file covered by two pages returns both, and nothing else", () => {
    expect(getPagesDescribing(graph, "src/ctx/index.ts")).toEqual([
      "wiki:components/a.md",
      "wiki:components/b.md",
    ]);
    expect(getPagesDescribing(graph, "src/ctx/run.ts")).toEqual(["wiki:components/b.md"]);
  });

  test("the forward direction is available from the same layer", () => {
    expect(getFilesDescribedBy(graph, wikiPageId("components/b.md"))).toEqual([
      "src/ctx/index.ts",
      "src/ctx/run.ts",
    ]);
  });

  test("no layer means no information, and an empty answer says so honestly", () => {
    expect(getPagesDescribing({ nodes: [], edges: [] }, "src/ctx/index.ts")).toEqual([]);
  });
});

describe("end-to-end build (AC1, AC7, AC13)", () => {
  async function fixture(): Promise<string> {
    const root = await mkdtemp(path.join(tmpdir(), "lwg-build-"));
    await mkdir(path.join(root, "src", "ctx"), { recursive: true });
    await writeFile(path.join(root, "src", "ctx", "index.ts"), 'export * from "./run";\n');
    await writeFile(path.join(root, "src", "ctx", "run.ts"), "export const run = () => 1;\n");
    return root;
  }

  test("layer files appear, and nodes.jsonl/edges.jsonl stay byte-identical (AC13)", async () => {
    const root = await fixture();
    const storage = path.join(root, ".metaproject", "data", "gdgraph", "storage");

    // Build with no wiki at all: the layer cannot run.
    await buildGraph(root);
    const nodesBefore = await readFile(path.join(storage, "nodes.jsonl"), "utf8");
    const edgesBefore = await readFile(path.join(storage, "edges.jsonl"), "utf8");

    // Now add a wiki page and rebuild: the layer runs.
    await mkdir(path.join(root, ".metaproject", "wiki", "components"), { recursive: true });
    await writeFile(
      path.join(root, ".metaproject", "wiki", "components", "src-ctx.md"),
      "# src/ctx\nVersion: 1.0.0\nType: component\nStatus: accepted\nDescribes:\n  - src/ctx/run.ts\n",
    );
    await buildGraph(root);

    const nodesAfter = await readFile(path.join(storage, "nodes.jsonl"), "utf8");
    const edgesAfter = await readFile(path.join(storage, "edges.jsonl"), "utf8");
    // The whole reason the layer is separate: legacy artifacts unchanged.
    expect(nodesAfter).toBe(nodesBefore);
    expect(edgesAfter).toBe(edgesBefore);

    const graph = await loadGraph(root);
    expect(graph.wikiPages?.map((p) => p.id)).toEqual(["wiki:components/src-ctx.md"]);
    expect(getFilesDescribedBy(graph, "wiki:components/src-ctx.md")).toEqual(["src/ctx/run.ts"]);

    const manifest = JSON.parse(await readFile(path.join(storage, "build-manifest.json"), "utf8"));
    expect(manifest.files.map((f: { path: string }) => f.path)).toEqual([
      "src/ctx/index.ts",
      "src/ctx/run.ts",
    ]);
    expect(manifest.files[0].contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(manifest.files[0].mtimeMs).toBeGreaterThan(0);
  });

  test("AC2: a graph with no layer files loads with the fields simply absent", async () => {
    const root = await fixture();
    await buildGraph(root);
    // No wiki directory was ever created, so no layer files exist.
    const graph = await loadGraph(root);
    expect(graph.wikiPages).toBeUndefined();
    expect(graph.describes).toBeUndefined();
    expect(graph.nodes.length).toBeGreaterThan(0);
  });
});
