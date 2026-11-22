import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { MetaprojectCatalog } from "./metaproject-explorer-contract";
import { metaprojectExplorer } from "./metaproject-explorer";
import { parseExplorerRequest } from "../commands/metaproject-explorer";

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

  test("keeps wiki body hits visible even with hundreds of exact filename matches", async () => {
    const root = await fixture();
    const dir = path.join(root, ".metaproject/data/gdgraph/storage");
    await mkdir(dir, { recursive: true });
    const files = Array.from({ length: 250 }, (_, index) => ({ id: String(index), kind: "file", path: `src/${index}/searchable`, language: "typescript" }));
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

  test("normalizes wiki metadata and legacy wrapped pages for detail", async () => {
    const root = await fixture();
    const file = path.join(root, ".metaproject/wiki/components/first.md");
    await writeFile(file, "---\nTitle: First\nType: component\n---\n```markdown\n---\nTitle: First\n---\n# First\n\nBody\n```\n");
    const wrapped = await metaprojectExplorer(root, { action: "detail", id: "wiki:components/first.md" });
    expect("markdown" in wrapped && wrapped.markdown).toBe("# First\n\nBody\n");
    await writeFile(file, "---\nTitle: First\n---\n# First\n\n```markdown\nExample\n```\n");
    const ordinary = await metaprojectExplorer(root, { action: "detail", id: "wiki:components/first.md" });
    expect("markdown" in ordinary && ordinary.markdown).toContain("```markdown\nExample\n```");
  });

  test("preserves assets without counting them as module imports", async () => {
    const root = await fixture();
    const dir = path.join(root, ".metaproject/data/gdgraph/storage");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "nodes.jsonl"), ["src/one/a.ts", "src/two/image.png"].map((file) => JSON.stringify({ path: file })).join("\n"));
    await writeFile(path.join(dir, "edges.jsonl"), JSON.stringify({ from: "src/one/a.ts", to: "src/two/image.png", kind: "asset" }));
    const catalog = await metaprojectExplorer(root, { action: "catalog" });
    if (!("edges" in catalog)) throw new Error("Expected catalog");
    expect(catalog.edges).toContainEqual({ from: "file:src/one/a.ts", to: "file:src/two/image.png", kind: "asset" });
    expect(catalog.edges.some((edge) => edge.kind === "imports")).toBe(false);
  });

  test("fails requested broken symbol relationships but skips calls when disabled", async () => {
    const root = await fixture();
    const dir = path.join(root, ".metaproject/data/gdgraph/storage");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "nodes.jsonl"), JSON.stringify({ path: "src/a.ts" }));
    await writeFile(path.join(dir, "edges.jsonl"), "");
    await writeFile(path.join(dir, "symbols.jsonl"), JSON.stringify({ id: "s", path: "src/a.ts", name: "run", startLine: 1 }));
    await writeFile(path.join(dir, "calls.jsonl"), "{bad");
    await expect(metaprojectExplorer(root, { action: "neighbors", id: "file:src/a.ts", depth: 1, direction: "both", kinds: ["defines"] })).rejects.toThrow("Symbol layer");
    const result = await metaprojectExplorer(root, { action: "neighbors", id: "symbol:s", depth: 1, direction: "both", kinds: ["imports"] });
    expect("root" in result && result.root).toBe("symbol:s");
    await rm(path.join(dir, "calls.jsonl"));
    await expect(metaprojectExplorer(root, { action: "neighbors", id: "file:src/a.ts", depth: 1, direction: "both", kinds: ["defines"] })).rejects.toThrow("Symbol layer");
  });

  test("validates Core requests independently", () => {
    for (const invalid of [null, { action: "write" }, { action: "catalog", extra: true }, { action: "neighbors", id: "x", depth: 3, direction: "both", kinds: [] }, { action: "neighbors", id: "x", depth: 1, direction: "sideways", kinds: [] }, { action: "neighbors", id: "x", depth: 1, direction: "both", kinds: ["write"] }]) {
      expect(() => parseExplorerRequest(invalid)).toThrow("Invalid request");
    }
    expect(parseExplorerRequest({ action: "neighbors", id: "x", depth: 1, direction: "both", kinds: ["asset"] })).toMatchObject({ kinds: ["asset"] });
  });

  test("writes a catalog larger than the pipe buffer as one complete CLI response", async () => {
    const root = await fixture();
    const storage = path.join(root, ".metaproject/data/gdgraph/storage");
    await mkdir(storage, { recursive: true });
    const files = Array.from({ length: 800 }, (_, index) => ({
      id: String(index),
      kind: "file",
      path: `src/components/entry-${index}.ts`,
      language: "typescript",
    }));
    await writeFile(path.join(storage, "nodes.jsonl"), files.map(file => JSON.stringify(file)).join("\n"));
    await writeFile(path.join(storage, "edges.jsonl"), "");
    const child = Bun.spawn([
      process.execPath,
      path.resolve(import.meta.dir, "../cli.ts"),
      "metaproject-explorer",
      "--request",
      JSON.stringify({ action: "catalog" }),
    ], { cwd: root, stdout: "pipe", stderr: "pipe" });
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    expect(Buffer.byteLength(stdout)).toBeGreaterThan(65_536);
    const catalog = JSON.parse(stdout) as MetaprojectCatalog;
    expect(catalog.counts.files).toBe(files.length);
  });
});
