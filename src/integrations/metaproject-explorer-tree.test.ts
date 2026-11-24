import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  METAPROJECT_CAPABILITIES, METAPROJECT_PAGE_SIZE_V2, MetaprojectRequestError, parseExplorerRequest,
  parseExplorerRequestV1, type MetaprojectNode, type MetaprojectRequestV2, type MetaprojectTreeEntry, type MetaprojectTreeV2,
} from "./metaproject-explorer-contract";
import { explorerGraphFreshness, loadExplorerGraph, metaprojectExplorer } from "./metaproject-explorer";
import { metaprojectExplorerV2 } from "./metaproject-explorer-v2";

type TreeRequest = Extract<MetaprojectRequestV2, { action: "tree" }>;

const roots: string[] = [];
const storage = ".metaproject/data/gdgraph/storage";

async function writeSource(root: string, relative: string, text: string): Promise<void> {
  const destination = path.join(root, relative);
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, text);
}

/** Wiki pages of two types, titled against their file order; no graph is built. */
async function wikiOnly(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "keryx-explorer-tree-"));
  roots.push(root);
  await writeSource(root, ".metaproject/wiki/components/zeta.md", "# Alpha\n");
  await writeSource(root, ".metaproject/wiki/components/alpha.md", "# Zeta\n");
  await writeSource(root, ".metaproject/wiki/domain-models/order.md", "# Order\n");
  return root;
}

const MANY_FOLDERS = 120;
const MANY_FILES = 15;

/** Wiki plus a built graph whose files nest in folders, with a folder too large for one page. */
async function builtGraph(): Promise<string> {
  const root = await wikiOnly();
  const files = [
    "root.ts", "src/a.ts", "src/lib/b.ts", "src/lib/deep/c.ts", "src/lib/deep/d.ts", "docs/readme.md", "pkg/inner/x.ts",
    ...Array.from({ length: MANY_FOLDERS }, (_, index) => `many/dir-${String(index).padStart(3, "0")}/f.ts`),
    ...Array.from({ length: MANY_FILES }, (_, index) => `many/file-${String(index).padStart(2, "0")}.ts`),
  ];
  // Written in reverse, so only the tree's own sort can put them in order.
  await writeSource(root, `${storage}/nodes.jsonl`, [...files].reverse().map((file) => JSON.stringify({ id: file, kind: "file", path: file, language: "typescript" })).join("\n"));
  await writeSource(root, `${storage}/edges.jsonl`, "");
  await writeSource(root, `${storage}/symbols.jsonl`, JSON.stringify({ id: "src/a.ts#run", path: "src/a.ts", name: "run", startLine: 1 }));
  await writeSource(root, `${storage}/calls.jsonl`, "");
  return root;
}

afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function tree(root: string, request: Omit<TreeRequest, "version" | "action">): Promise<MetaprojectTreeV2> {
  const response = await metaprojectExplorer(root, { version: 2, action: "tree", ...request });
  if (!("entries" in response) || !("scope" in response)) throw new Error("Expected a tree response");
  return response;
}

function label(entry: MetaprojectTreeEntry): string {
  switch (entry.type) {
    case "folder": return `folder:${entry.path}:${entry.files}${entry.module ? `:${entry.module.id}` : ""}`;
    case "group": return `group:${entry.key}:${entry.name}:${entry.pages}`;
    case "node": return `node:${entry.node.id}`;
  }
}

function codeOf(run: () => unknown): string | undefined {
  try {
    run();
  } catch (error) {
    return error instanceof MetaprojectRequestError ? error.code : `untyped:${String(error)}`;
  }
  return undefined;
}

describe("metaproject explorer tree (AC1)", () => {
  test("lists the root's folders with counts and modules, then its files, never symbols", async () => {
    const root = await builtGraph();
    const result = await tree(root, { scope: "graph" });
    expect(result).toMatchObject({ schemaVersion: 2, scope: "graph", parent: null, partial: false });
    expect(result.nextCursor).toBeUndefined();
    expect(result.entries.map(label)).toEqual([
      "folder:docs:1:module:docs",
      `folder:many:${MANY_FOLDERS + MANY_FILES}:module:many`,
      "folder:pkg:1",
      "folder:src:4:module:src",
      "node:file:root.ts",
    ]);
    const file = result.entries.at(-1);
    expect(file?.type === "node" && file.node).toMatchObject({ kind: "file", title: "root.ts", path: "root.ts" });
  });

  test("lists a nested folder's children", async () => {
    const root = await builtGraph();
    const src = await tree(root, { scope: "graph", parent: "src" });
    expect(src.parent).toBe("src");
    expect(src.entries.map(label)).toEqual(["folder:src/lib:3:module:src/lib", "node:file:src/a.ts"]);
    const lib = await tree(root, { scope: "graph", parent: "src/lib" });
    expect(lib.entries.map(label)).toEqual(["folder:src/lib/deep:2:module:src/lib/deep", "node:file:src/lib/b.ts"]);
    const deep = await tree(root, { scope: "graph", parent: "src/lib/deep" });
    expect(deep.entries.map(label)).toEqual(["node:file:src/lib/deep/c.ts", "node:file:src/lib/deep/d.ts"]);
    const pkg = await tree(root, { scope: "graph", parent: "pkg" });
    expect(pkg.entries.map(label)).toEqual(["folder:pkg/inner:1:module:pkg/inner"]);
  });

  test("leaves symbols out of listings and folder counts even when the graph model holds them", async () => {
    const root = await builtGraph();
    const symbols: MetaprojectNode[] = [
      { id: "symbol:src/a.ts#run", kind: "symbol", title: "run", path: "src/a.ts" },
      { id: "symbol:only/x.ts#y", kind: "symbol", title: "y", path: "only/x.ts" },
      { id: "symbol:top.ts#z", kind: "symbol", title: "z", path: "top.ts" },
    ];
    let loaded: MetaprojectNode[] = [];
    const read = (request: TreeRequest) => metaprojectExplorerV2(root, request, async (checkout, graphRequest) => {
      const graph = await loadExplorerGraph(checkout, graphRequest);
      loaded = [...graph.nodes, ...symbols];
      return { graph: { ...graph, nodes: loaded }, freshness: () => explorerGraphFreshness(checkout, graph), confirm: async () => {}, track: async () => {} };
    });
    const top = await read({ version: 2, action: "tree", scope: "graph" });
    expect(loaded.filter((node) => node.kind === "symbol")).toHaveLength(symbols.length);
    if (!("entries" in top) || !("scope" in top)) throw new Error("Expected a tree response");
    expect(top.entries.map(label)).toEqual([
      "folder:docs:1:module:docs", `folder:many:${MANY_FOLDERS + MANY_FILES}:module:many`, "folder:pkg:1", "folder:src:4:module:src", "node:file:root.ts",
    ]);
    const src = await read({ version: 2, action: "tree", scope: "graph", parent: "src" });
    if (!("entries" in src) || !("scope" in src)) throw new Error("Expected a tree response");
    expect(src.entries.map(label)).toEqual(["folder:src/lib:3:module:src/lib", "node:file:src/a.ts"]);
    await expect(read({ version: 2, action: "tree", scope: "graph", parent: "only" })).rejects.toMatchObject({ code: "not-found" });
  });

  test("answers an empty, complete root for a built graph without files", async () => {
    const root = await wikiOnly();
    await writeSource(root, `${storage}/nodes.jsonl`, "");
    await writeSource(root, `${storage}/edges.jsonl`, "");
    expect(await tree(root, { scope: "graph" })).toMatchObject({ entries: [], partial: false, parent: null });
    await expect(tree(root, { scope: "graph", parent: "src" })).rejects.toMatchObject({ code: "not-found" });
  });

  test("chains pages of at most the page size to the full child list", async () => {
    const root = await builtGraph();
    const seen: string[] = [];
    let page = await tree(root, { scope: "graph", parent: "many" });
    let pages = 1;
    expect(page.entries).toHaveLength(METAPROJECT_PAGE_SIZE_V2);
    while (page.nextCursor) {
      page = await tree(root, { scope: "graph", parent: "many", cursor: page.nextCursor, expectedSnapshotId: page.snapshotId });
      pages++;
      seen.push(...page.entries.map(label));
    }
    const first = await tree(root, { scope: "graph", parent: "many" });
    const all = [...first.entries.map(label), ...seen];
    expect(pages).toBe(2);
    expect(all).toHaveLength(MANY_FOLDERS + MANY_FILES);
    expect(new Set(all).size).toBe(all.length);
    expect(all).toEqual([
      ...Array.from({ length: MANY_FOLDERS }, (_, index) => {
        const folder = `many/dir-${String(index).padStart(3, "0")}`;
        return `folder:${folder}:1:module:${folder}`;
      }),
      ...Array.from({ length: MANY_FILES }, (_, index) => `node:file:many/file-${String(index).padStart(2, "0")}.ts`),
    ]);
  });

  test("groups wiki pages by page type at the root and lists a group's pages by title", async () => {
    const root = await builtGraph();
    const groups = await tree(root, { scope: "wiki" });
    expect(groups).toMatchObject({ scope: "wiki", parent: null, partial: false });
    expect(groups.entries.map(label)).toEqual(["group:component:Component:2", "group:domain-model:Domain model:1"]);
    const pages = await tree(root, { scope: "wiki", parent: "component" });
    expect(pages.parent).toBe("component");
    // By title (Alpha, Zeta), not by file name.
    expect(pages.entries.map(label)).toEqual(["node:wiki:components/zeta.md", "node:wiki:components/alpha.md"]);
  });

  test("answers an empty, partial graph tree while the graph is not built, and the wiki tree as usual", async () => {
    const root = await wikiOnly();
    expect(await tree(root, { scope: "graph" })).toMatchObject({ entries: [], partial: true, parent: null });
    expect(await tree(root, { scope: "graph", parent: "src" })).toMatchObject({ entries: [], partial: true, parent: "src" });
    const wiki = await tree(root, { scope: "wiki" });
    expect(wiki.partial).toBe(false);
    expect(wiki.entries.map(label)).toEqual(["group:component:Component:2", "group:domain-model:Domain model:1"]);
  });
});

describe("metaproject explorer tree (AC2)", () => {
  test("refuses malformed tree requests as invalid input", () => {
    const base = { version: 2, action: "tree", scope: "graph" };
    const malformed: unknown[] = [
      { version: 2, action: "tree" },
      { ...base, extra: true },
      { ...base, scope: "spec" },
      { ...base, scope: ["graph"] },
      { ...base, parent: "/src" },
      { ...base, parent: "../outside" },
      { ...base, parent: "src/../outside" },
      { ...base, parent: "src/" },
      { ...base, parent: "" },
      { ...base, parent: "C:/src" },
      { ...base, parent: 1 },
      { ...base, scope: "wiki", parent: "" },
      { ...base, cursor: "" },
      { ...base, cursor: 3 },
      { ...base, expectedSnapshotId: "not-a-sha" },
    ];
    for (const request of malformed) {
      expect({ request, code: codeOf(() => parseExplorerRequest(request)) }).toEqual({ request, code: "invalid-input" });
    }
    expect(parseExplorerRequest({ ...base, parent: "src/lib", cursor: "c" })).toEqual({
      version: 2, action: "tree", scope: "graph", parent: "src/lib", cursor: "c",
    });
    expect(parseExplorerRequest({ version: 2, action: "tree", scope: "wiki", parent: "component" })).toEqual({
      version: 2, action: "tree", scope: "wiki", parent: "component",
    });
  });

  test("refuses a cursor that is not one this request issued", async () => {
    const root = await builtGraph();
    await expect(tree(root, { scope: "graph", parent: "many", cursor: "garbage" })).rejects.toMatchObject({ code: "invalid-input" });
    const first = await tree(root, { scope: "graph", parent: "many" });
    if (!first.nextCursor) throw new Error("Expected a next cursor");
    await expect(tree(root, { scope: "graph", parent: "src", cursor: first.nextCursor })).rejects.toMatchObject({ code: "invalid-input" });
    await expect(tree(root, { scope: "wiki", parent: "many", cursor: first.nextCursor })).rejects.toMatchObject({ code: "invalid-input" });
  });

  test("answers not-found for an unknown parent", async () => {
    const root = await builtGraph();
    for (const parent of ["missing", "src/missing", "src/a.ts", "many/dir-000/f.ts"]) {
      await expect(tree(root, { scope: "graph", parent })).rejects.toMatchObject({ code: "not-found" });
    }
    await expect(tree(root, { scope: "wiki", parent: "architecture" })).rejects.toMatchObject({ code: "not-found" });
    await expect(tree(root, { scope: "wiki", parent: "components" })).rejects.toMatchObject({ code: "not-found" });
  });

  test("answers stale-snapshot for a cursor or expected snapshot from another snapshot", async () => {
    const root = await builtGraph();
    const first = await tree(root, { scope: "graph", parent: "many" });
    if (!first.nextCursor) throw new Error("Expected a next cursor");
    await expect(tree(root, { scope: "graph", expectedSnapshotId: "0".repeat(64) })).rejects.toMatchObject({ code: "stale-snapshot" });
    await writeSource(root, ".metaproject/wiki/components/alpha.md", "# Zeta\n\nRevised.\n");
    await expect(tree(root, { scope: "graph", parent: "many", cursor: first.nextCursor })).rejects.toMatchObject({ code: "stale-snapshot" });
    await expect(tree(root, { scope: "wiki", expectedSnapshotId: first.snapshotId })).rejects.toMatchObject({ code: "stale-snapshot" });
  });

  test("lists tree among the capabilities and leaves v1 parsing and responses unchanged", async () => {
    expect(METAPROJECT_CAPABILITIES).toContain("tree");
    const root = await builtGraph();
    expect(await metaprojectExplorer(root, { version: 2, action: "capabilities" })).toEqual({
      schemaVersion: 2, actions: METAPROJECT_CAPABILITIES,
    });
    const unversioned = { action: "tree", scope: "graph" };
    expect(() => parseExplorerRequestV1(unversioned)).toThrow("Invalid request");
    expect(() => parseExplorerRequest(unversioned)).toThrow("Invalid request");
    expect(parseExplorerRequest({ action: "catalog" })).toEqual({ action: "catalog" });
    const legacy = await metaprojectExplorer(root, { action: "catalog" });
    expect(legacy.schemaVersion).toBe(1);
    expect("openSpec" in legacy).toBe(false);
    expect("nodes" in legacy && legacy.nodes.some((node) => node.id === "file:src/a.ts")).toBe(true);
  });
});
