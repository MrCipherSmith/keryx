import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  METAPROJECT_CAPABILITIES, parseExplorerRequestV1, type MetaprojectCatalog, type MetaprojectRequestV2,
} from "./metaproject-explorer-contract";
import { metaprojectExplorer } from "./metaproject-explorer";
import { parseExplorerRequest } from "./service";

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

  test("keeps exact filenames and symbols when wiki text fills the result limit", async () => {
    const root = await fixture();
    const dir = path.join(root, ".metaproject/data/gdgraph/storage");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "nodes.jsonl"), JSON.stringify({ path: "src/searchable" }));
    await writeFile(path.join(dir, "edges.jsonl"), "");
    await writeFile(path.join(dir, "symbols.jsonl"), JSON.stringify({ id: "src/searchable#run", path: "src/searchable", name: "searchable", startLine: 1 }));
    await writeFile(path.join(dir, "calls.jsonl"), "");
    await Promise.all(Array.from({ length: 205 }, (_, index) =>
      writeFile(path.join(root, `.metaproject/wiki/components/other-${index}.md`), `# Other ${index}\n\nsearchable\n`),
    ));
    const search = await metaprojectExplorer(root, { action: "search", query: "searchable" });
    if (!("hits" in search)) throw new Error("Expected search");
    expect(search.hits).toHaveLength(200);
    expect(search.hits.filter(hit => hit.node.kind !== "wiki").map(hit => hit.node.id))
      .toEqual(["file:src/searchable", "symbol:src/searchable#run"]);
    expect(search.hits.some(hit => hit.node.kind === "wiki" && hit.snippet?.includes("searchable"))).toBe(true);
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

async function writeSource(root: string, relative: string, text: string): Promise<void> {
  const destination = path.join(root, relative);
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, text);
}

const specPath = "openspec/specs/review/spec.md";
const activeDelta = "openspec/changes/improve/specs/review/spec.md";
const archivedDelta = "openspec/changes/archive/2026-01-01-released/specs/review/spec.md";
const linkConfig = ".metaproject/openspec/links.json";
const digestPattern = /^[a-f0-9]{64}$/;

describe("metaproject explorer v2", () => {
  test("runs the fixed probe on an unavailable root while the actual v1 parser rejects it", async () => {
    const input = { action: "capabilities", version: 2 } as const;
    expect(() => parseExplorerRequestV1(JSON.parse(JSON.stringify(input)))).toThrow("Invalid request");
    expect(() => parseExplorerRequest({ ...input, cwd: "/foreign" })).toThrow("Invalid Metaproject v2 request");
    expect(() => parseExplorerRequest({ action: "detail", version: 2, id: "test", artifact: "../outside" })).toThrow("Invalid Metaproject v2 request");
    expect(() => parseExplorerRequest({ action: "search", version: 2, query: "q", scopes: ["wiki", "wiki"] })).toThrow("Invalid Metaproject v2 request");
    const root = await fixture();
    expect(await metaprojectExplorer(path.join(root, "missing"), input)).toEqual({
      schemaVersion: 2, actions: METAPROJECT_CAPABILITIES,
    });
    const legacy = await metaprojectExplorer(root, parseExplorerRequestV1({ action: "catalog" }));
    expect(legacy.schemaVersion).toBe(1);
    expect("openSpec" in legacy).toBe(false);
  });

  test("projects oriented delta and declared-context evidence and opens an explicitly selected archive", async () => {
    const root = await fixture();
    await writeSource(root, specPath, "### Requirement: Review can start\nCurrent policy.\n");
    const delta = "## MODIFIED Requirements\n### Requirement: Review can start\nUpdated policy.\n";
    await writeSource(root, activeDelta, delta);
    await writeSource(root, archivedDelta, delta);
    const source = { kind: "spec", path: specPath };
    const target = { kind: "wiki", path: ".metaproject/wiki/components/first.md" };
    await writeSource(root, linkConfig, JSON.stringify({ version: 1, links: [
      { source, target }, { source, target }, { source, target: { kind: "wiki", path: ".metaproject/wiki/missing.md" } },
    ] }));
    const catalog = await metaprojectExplorer(root, { action: "catalog", version: 2 });
    if (!("graph" in catalog)) throw new Error("Expected v2 catalog");
    const spec = catalog.nodes.find((node) => node.kind === "spec");
    const change = catalog.nodes.find((node) => node.kind === "change");
    if (!spec || !change) throw new Error("Expected current OpenSpec nodes");
    expect(catalog.nodes.some((node) => node.kind === "archive")).toBe(false);
    expect(catalog.edges).toContainEqual({
      from: change.id, to: spec.id, kind: "changes-spec",
      provenance: [{ path: activeDelta, digest: expect.stringMatching(digestPattern) }],
    });
    const wikiId = "wiki:components/first.md";
    const inbound = await metaprojectExplorer(root, {
      action: "neighbors", version: 2, id: wikiId, depth: 1, direction: "incoming", kinds: ["spec-context"],
      expectedSnapshotId: catalog.snapshotId,
    });
    if (!("root" in inbound)) throw new Error("Expected projection");
    expect(inbound.nodes.map((node) => node.id)).toEqual([wikiId, spec.id]);
    expect(inbound.edges).toHaveLength(1);
    expect(inbound.edges[0]?.provenance).toEqual([0, 1].map((index) => ({
      path: linkConfig, index, digest: expect.stringMatching(digestPattern),
    })));
    expect(catalog.openSpec.diagnostics.map(({ code, index }) => [code, index])).toEqual([
      ["link-duplicate", 1], ["link-target-not-found", 2],
    ]);
    const history = await metaprojectExplorer(root, { action: "openspec-history", version: 2, id: spec.id });
    if (!("entries" in history) || !("id" in history)) throw new Error("Expected history");
    const entry = history.entries[0]?.entry;
    if (!entry) throw new Error("Expected archived entry");
    const archive = await metaprojectExplorer(root, {
      action: "neighbors", version: 2, id: entry.id, depth: 1, direction: "outgoing", kinds: ["changes-spec"],
    });
    if (!("root" in archive)) throw new Error("Expected archive projection");
    expect(archive.edges).toContainEqual({
      from: entry.id, to: spec.id, kind: "changes-spec",
      provenance: [{ path: archivedDelta, digest: expect.stringMatching(digestPattern) }],
    });
  });

  test("pages a shared snapshot and opens the matching source section", async () => {
    const root = await fixture();
    const shared = "Shared heading";
    await Promise.all(Array.from({ length: 101 }, (_, index) =>
      writeSource(root, `openspec/specs/rule-${index}/spec.md`, `### Requirement: ${shared}\nBody.\n`)));
    await writeSource(root, archivedDelta, `## ADDED Requirements\n### Requirement: ${shared}\nHistoric.\n`);
    const query: Extract<MetaprojectRequestV2, { action: "search" }> = { action: "search", version: 2, query: shared };
    const first = await metaprojectExplorer(root, query);
    if (first.schemaVersion !== 2 || !("hits" in first) || !first.nextCursor) throw new Error("Expected first page and next cursor");
    expect(first.hits).toHaveLength(100);
    expect(first.hits.every(({ scope }) => scope === "spec")).toBe(true);
    const selected = first.hits[0];
    if (!selected?.source || !selected.section) throw new Error("Expected a section hit");
    const detail = await metaprojectExplorer(root, {
      action: "detail", version: 2, id: selected.node.id, artifact: selected.source.path,
      section: selected.section, digest: selected.source.digest, expectedSnapshotId: first.snapshotId,
    });
    if (!("node" in detail)) throw new Error("Expected detail");
    expect(detail.openSpec?.artifact?.section).toBe(selected.section);
    const next = await metaprojectExplorer(root, { ...query, cursor: first.nextCursor });
    if (!("hits" in next)) throw new Error("Expected second page");
    expect(next.hits).toHaveLength(1);
    await expect(metaprojectExplorer(root, { ...query, cursor: first.nextCursor, scopes: ["spec"] }))
      .rejects.toMatchObject({ code: "invalid-input" });
    const archived = await metaprojectExplorer(root, { ...query, scopes: ["archive"] });
    expect("hits" in archived && archived.hits[0]?.scope).toBe("archive");
    await writeSource(root, selected.source.path, "### Requirement: Updated\n");
    await expect(metaprojectExplorer(root, { ...query, cursor: first.nextCursor }))
      .rejects.toMatchObject({ code: "stale-snapshot" });
    await expect(metaprojectExplorer(root, {
      action: "detail", version: 2, id: selected.node.id, artifact: selected.source.path,
      section: selected.section, digest: selected.source.digest,
    })).rejects.toMatchObject({ code: "stale-section" });
  });

  test("keeps Wiki accessible when the OpenSpec root is unavailable", async () => {
    const root = await fixture();
    await symlink(path.join(root, ".metaproject/wiki"), path.join(root, "openspec"));
    const catalog = await metaprojectExplorer(root, { action: "catalog", version: 2 });
    if (!("graph" in catalog)) throw new Error("Expected v2 catalog");
    expect(catalog.openSpec.availability).toBe("unavailable");
    expect(catalog.nodes.some((node) => node.id === "wiki:components/first.md")).toBe(true);
    const result = await metaprojectExplorer(root, { action: "search", version: 2, query: "Searchable", scopes: ["wiki"] });
    if (!("hits" in result)) throw new Error("Expected search results");
    expect(result.hits.some(({ scope }) => scope === "wiki")).toBe(true);
  });
});
