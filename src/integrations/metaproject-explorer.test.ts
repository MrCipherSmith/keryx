import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmod, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { recordProvenance } from "../sync/provenance";
import {
  METAPROJECT_CAPABILITIES, parseExplorerRequestV1, type MetaprojectAnyRequest, type MetaprojectCatalog,
  type MetaprojectRequest, type MetaprojectRequestV2,
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

function git(cwd: string, ...args: string[]): void {
  const identity = ["-c", "user.email=explorer@example.invalid", "-c", "user.name=Explorer", "-c", "commit.gpgsign=false"];
  execFileSync("git", [...identity, ...args], { cwd, stdio: "ignore" });
}

/** A committed checkout whose graph was built at HEAD, so its freshness starts as `ready`. */
async function builtCheckout(): Promise<string> {
  const root = await fixture();
  const storage = ".metaproject/data/gdgraph/storage";
  await writeSource(root, "src/a.ts", "export const a = 1;\n");
  await writeSource(root, `${storage}/nodes.jsonl`, JSON.stringify({ id: "a", kind: "file", path: "src/a.ts", language: "typescript" }));
  await writeSource(root, `${storage}/edges.jsonl`, "");
  git(root, "init", "-q");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "fixture");
  await recordProvenance(root, "gdgraph", new Date().toISOString());
  return root;
}

/** Put a recording `git` first on PATH for one read and return the arguments of every call it made. */
async function withRecordedGit<T>(read: () => Promise<T>): Promise<{ result: T; calls: string[] }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "keryx-explorer-git-"));
  roots.push(dir);
  const realGit = Bun.which("git");
  if (!realGit) throw new Error("Expected git on PATH");
  const log = path.join(dir, "calls.log");
  const wrapper = path.join(dir, "git");
  await writeFile(wrapper, `#!/bin/sh\necho "$*" >> "${log}"\nexec "${realGit}" "$@"\n`);
  await chmod(wrapper, 0o755);
  const previous = process.env.PATH;
  process.env.PATH = `${dir}${path.delimiter}${previous ?? ""}`;
  let result: T;
  try {
    result = await read();
  } finally {
    if (previous === undefined) delete process.env.PATH;
    else process.env.PATH = previous;
  }
  const recorded = await readFile(log, "utf8").catch(() => "");
  return { result, calls: recorded.split("\n").filter(Boolean) };
}

describe("metaproject explorer graph freshness", () => {
  test("keeps the v2 snapshot when only graph freshness changes", async () => {
    const root = await builtCheckout();
    const request = { action: "catalog", version: 2 } as const;
    const built = await metaprojectExplorer(root, request);
    if (!("graph" in built)) throw new Error("Expected v2 catalog");
    expect(built.graph).toBe("ready");
    expect(built.graphReason).toBeUndefined();

    await writeFile(path.join(root, "notes.txt"), "An untracked note.\n");
    const stale = await metaprojectExplorer(root, request);
    if (!("graph" in stale)) throw new Error("Expected v2 catalog");
    expect(stale.graph).toBe("stale");
    expect(stale.graphReason).toContain("notes.txt");
    expect(stale.snapshotId).toBe(built.snapshotId);

    // A read pinned to the earlier snapshot, as a paged search is, still answers.
    const search = await metaprojectExplorer(root, {
      action: "search", version: 2, query: "a.ts", expectedSnapshotId: built.snapshotId,
    });
    if (!("hits" in search)) throw new Error("Expected search results");
    expect(search.snapshotId).toBe(built.snapshotId);
    expect(search.hits.map(({ node }) => node.id)).toContain("file:src/a.ts");

    // Data changes still retire the snapshot.
    await writeFile(path.join(root, ".metaproject/wiki/components/second.md"), "# Second\n\nRevised.\n");
    const changed = await metaprojectExplorer(root, request);
    expect("snapshotId" in changed && changed.snapshotId).not.toBe(built.snapshotId);
  }, 30_000);

  test("checks graph freshness only for a catalog", async () => {
    const root = await builtCheckout();
    const id = "file:src/a.ts";
    const neighbors: Extract<MetaprojectRequest, { action: "neighbors" }> = {
      action: "neighbors", id, depth: 1, direction: "both", kinds: ["imports"],
    };
    const reads: MetaprojectAnyRequest[] = [
      { action: "detail", id },
      { action: "search", query: "a.ts" },
      neighbors,
      { version: 2, action: "detail", id },
      { version: 2, action: "search", query: "a.ts" },
      { version: 2, ...neighbors },
      // These two load the graph with the request a catalog uses, yet report no freshness.
      { version: 2, action: "search", query: "a.ts", scopes: ["spec"] },
      { version: 2, action: "openspec-list", collection: "spec" },
    ];
    for (const request of reads) {
      const { calls } = await withRecordedGit(() => metaprojectExplorer(root, request));
      expect({ request, calls }).toEqual({ request, calls: [] });
    }
    // The wrapper does see a freshness check, and passes it through to the real git.
    const catalogs: MetaprojectAnyRequest[] = [{ action: "catalog" }, { action: "catalog", version: 2 }];
    for (const request of catalogs) {
      const { result, calls } = await withRecordedGit(() => metaprojectExplorer(root, request));
      expect(calls.some((call) => call.startsWith("status "))).toBe(true);
      expect("graph" in result && result.graph).toBe("ready");
    }
  }, 30_000);
});
