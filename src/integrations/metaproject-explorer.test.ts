import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { metaprojectExplorer } from "./metaproject-explorer";

const roots: string[] = [];
async function fixture(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "keryx-explorer-"));
  roots.push(root);
  await mkdir(path.join(root, ".metaproject/wiki/components"), { recursive: true });
  await writeFile(path.join(root, ".metaproject/wiki/components/first.md"), "# First\n\nSearchable body. [Second](second.md)\n");
  await writeFile(path.join(root, ".metaproject/wiki/components/second.md"), "# Second\n");
  return root;
}
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("metaproject explorer", () => {
  test("keeps wiki catalog, details and search when graph is missing", async () => {
    const root = await fixture();
    const catalog = await metaprojectExplorer(root, { action: "catalog" });
    expect("graph" in catalog && catalog.graph).toBe("missing");
    if (!("nodes" in catalog)) throw new Error("Expected catalog");
    expect(catalog.nodes.some((node) => node.id === "wiki:components/first.md")).toBe(true);
    expect(catalog.edges).toContainEqual({ from: "wiki:components/first.md", to: "wiki:components/second.md", kind: "links" });
    const detail = await metaprojectExplorer(root, { action: "detail", id: "wiki:components/first.md" });
    expect("markdown" in detail && detail.markdown).toContain("Searchable body");
    const search = await metaprojectExplorer(root, { action: "search", query: "Searchable" });
    expect("hits" in search && search.hits[0]?.node.id).toBe("wiki:components/first.md");
  });

  test("keeps directed imports and describes provenance", async () => {
    const root = await fixture();
    const dir = path.join(root, ".metaproject/data/gdgraph/storage");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "nodes.jsonl"), [{ id: "a", kind: "file", path: "src/a.ts", language: "typescript" }, { id: "b", kind: "file", path: "src/b.ts", language: "typescript" }].map((entry) => JSON.stringify(entry)).join("\n"));
    await writeFile(path.join(dir, "edges.jsonl"), JSON.stringify({ id: "e", from: "src/a.ts", to: "src/b.ts", kind: "imports", specifier: "./b" }));
    await writeFile(path.join(dir, "describes.jsonl"), JSON.stringify({ id: "d", from: "wiki:components/first.md", to: "src/a.ts", origin: "frontmatter", pattern: "src/a.ts" }));
    const catalog = await metaprojectExplorer(root, { action: "catalog" });
    if (!("edges" in catalog)) throw new Error("Expected catalog");
    expect(catalog.edges).toContainEqual({ from: "file:src/a.ts", to: "file:src/b.ts", kind: "imports" });
    expect(catalog.edges).toContainEqual({ from: "wiki:components/first.md", to: "file:src/a.ts", kind: "describes", evidence: ["frontmatter", "src/a.ts"] });
  });

  test("refuses wiki page symlinks outside the checkout", async () => {
    const root = await fixture();
    const outside = await mkdtemp(path.join(os.tmpdir(), "keryx-explorer-outside-"));
    roots.push(outside);
    await writeFile(path.join(outside, "secret.md"), "# Secret");
    await symlink(path.join(outside, "secret.md"), path.join(root, ".metaproject/wiki/components/external.md"));
    const catalog = await metaprojectExplorer(root, { action: "catalog" });
    if (!("nodes" in catalog)) throw new Error("Expected catalog");
    expect(catalog.nodes.some((node) => node.title === "Secret")).toBe(false);
    expect(catalog.nodes.some((node) => node.title === "First")).toBe(true);
  });
  test("keeps wiki available when graph records are corrupt", async () => {
    const root = await fixture();
    const dir = path.join(root, ".metaproject/data/gdgraph/storage");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "nodes.jsonl"), "{bad json");
    await writeFile(path.join(dir, "edges.jsonl"), "");
    const catalog = await metaprojectExplorer(root, { action: "catalog" });
    if (!("graph" in catalog)) throw new Error("Expected catalog");
    expect(catalog.graph).toBe("unknown");
    expect(catalog.nodes.some((node) => node.title === "First")).toBe(true);
    const detail = await metaprojectExplorer(root, { action: "detail", id: "wiki:components/first.md" });
    expect("markdown" in detail && detail.markdown).toContain("Searchable body");
  });

  test("finds symbol roots when symbol edge types are disabled", async () => {
    const root = await fixture();
    const dir = path.join(root, ".metaproject/data/gdgraph/storage");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "nodes.jsonl"), JSON.stringify({ id: "a", kind: "file", path: "src/a.ts", language: "typescript" }));
    await writeFile(path.join(dir, "edges.jsonl"), "");
    await writeFile(path.join(dir, "symbols.jsonl"), JSON.stringify({ id: "src/a.ts#run", path: "src/a.ts", name: "run", startLine: 1 }));
    await writeFile(path.join(dir, "calls.jsonl"), "");
    const neighbors = await metaprojectExplorer(root, { action: "neighbors", id: "symbol:src/a.ts#run", depth: 1, direction: "both", kinds: ["imports"] });
    if (!("root" in neighbors)) throw new Error("Expected neighbors");
    expect(neighbors.nodes[0]?.id).toBe("symbol:src/a.ts#run");
    expect(neighbors.edges).toEqual([]);
  });

  test("keeps wiki body hits ahead of broad file matches", async () => {
    const root = await fixture();
    const dir = path.join(root, ".metaproject/data/gdgraph/storage");
    await mkdir(dir, { recursive: true });
    const files = Array.from({ length: 250 }, (_, index) => ({ id: String(index), kind: "file", path: `src/searchable-${index}.ts`, language: "typescript" }));
    await writeFile(path.join(dir, "nodes.jsonl"), files.map((file) => JSON.stringify(file)).join("\n"));
    await writeFile(path.join(dir, "edges.jsonl"), "");
    const search = await metaprojectExplorer(root, { action: "search", query: "searchable" });
    if (!("hits" in search)) throw new Error("Expected search");
    expect(search.hits.some((hit) => hit.node.id === "wiki:components/first.md")).toBe(true);
  });

  test("aggregates directed imports between modules", async () => {
    const root = await fixture();
    const dir = path.join(root, ".metaproject/data/gdgraph/storage");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "nodes.jsonl"), ["src/one/a.ts", "src/two/b.ts"].map((file) => JSON.stringify({ id: file, kind: "file", path: file, language: "typescript" })).join("\n"));
    await writeFile(path.join(dir, "edges.jsonl"), JSON.stringify({ id: "e", from: "src/one/a.ts", to: "src/two/b.ts", kind: "imports", specifier: "../two/b" }));
    const catalog = await metaprojectExplorer(root, { action: "catalog" });
    if (!("edges" in catalog)) throw new Error("Expected catalog");
    expect(catalog.edges).toContainEqual({ from: "module:src/one", to: "module:src/two", kind: "imports", count: 1, evidence: ["src/one/a.ts → src/two/b.ts"] });
  });

});
