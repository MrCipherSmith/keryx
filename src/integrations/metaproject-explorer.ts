import { createHash } from "node:crypto";
import { lstat, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { gdgraphStorageDir } from "../gdgraph/data-dir";
import { checkGraphStaleness } from "../gdgraph/staleness";
import type { CallEdge, DescribesEdge, GraphEdge, GraphNode, SymbolNode } from "../gdgraph/types";
import { readContainedFile } from "../lib/contained-read";
import { WIKI_PAGE_TYPES } from "../wiki/types";
import { unwrapFencedPage } from "../wiki/page-invariants";
import { rankMetaprojectSearchHits, METAPROJECT_SCHEMA, MetaprojectRequestError } from "./metaproject-explorer-contract";
import { indexMetaprojectGraph, projectMetaprojectGraph } from "./metaproject-projection";
import type { MetaprojectAnyRequest, MetaprojectCatalog, MetaprojectEdge, MetaprojectNode, MetaprojectRequest, MetaprojectRequestV2, MetaprojectResponse, MetaprojectV2Response } from "./metaproject-explorer-contract";

import { metaprojectExplorerV2 } from "./metaproject-explorer-v2";

const CATALOG_NODES = 12_000;
const CATALOG_EDGES = 40_000;
const MAX_FILE_BYTES = 128 * 1024 * 1024;
const fileId = (value: string): string => `file:${value}`;
const wikiId = (value: string): string => `wiki:${value}`;
const symbolId = (value: string): string => `symbol:${value}`;

async function safeRead(root: string, relative: string, maxBytes = MAX_FILE_BYTES): Promise<string> {
  return (await readContainedFile(root, path.resolve(root, relative), { maxBytes })).toString("utf8");
}

async function jsonl<T>(root: string, relative: string, required = false): Promise<T[]> {
  let text: string;
  try { text = await safeRead(root, relative); } catch (error) {
    if (!required && (error as { code?: string }).code === "CONTAINED_READ_NOT_FOUND") return [];
    throw error;
  }
  const records: T[] = [];
  for (const line of text.split("\n")) {
    if (line.trim()) records.push(JSON.parse(line) as T);
  }
  return records;
}

async function exists(root: string, relative: string): Promise<boolean> {
  try {
    const resolved = await realpath(path.resolve(root, relative));
    const rel = path.relative(root, resolved);
    if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) throw new Error("Path outside project");
    await stat(resolved);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function wikiDetail(content: string): string {
  const unwrapped = unwrapFencedPage(content);
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(unwrapped);
  if (!match || !/^(?:Title|Type|Status):/im.test(match[1] ?? "")) return unwrapped;
  return unwrapped.slice(match[0].length).replace(/^(?:\r?\n)+/, "");
}

async function wikiPages(root: string, request: MetaprojectRequest, observation?: ExplorerReadObservation): Promise<Array<{ node: MetaprojectNode; links: string[]; digest: string; snippet?: string; headingMatch?: boolean; markdown?: string }>> {
  const result: Array<{ node: MetaprojectNode; links: string[]; digest: string; snippet?: string; headingMatch?: boolean; markdown?: string }> = [];
  let retainedBytes = 0;
  for (const { folder, type } of WIKI_PAGE_TYPES) {
    const dir = `.metaproject/wiki/${folder}`;
    await observation?.track(dir);
    if (!(await exists(root, dir))) continue;
    const names = (await readdir(path.join(root, dir))).filter((name) => name.endsWith(".md")).sort();
    for (const name of names) {
      const relative = `${folder}/${name}`;
      let content: string;
      await observation?.track(`${dir}/${name}`);
      try { content = await safeRead(root, `${dir}/${name}`, 8 * 1024 * 1024); } catch (error) {
        if ((error as { code?: string }).code === "CONTAINED_READ_OUTSIDE" || (error as { code?: string }).code === "CONTAINED_READ_NOT_FOUND") continue;
        throw error;
      }
      const title = content.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? relative;
      const status = content.match(/^Status:\s*(.+)$/im)?.[1]?.trim();
      const node: MetaprojectNode = { id: wikiId(relative), kind: "wiki", title, path: `.metaproject/wiki/${relative}`, pageType: type, ...(status ? { status } : {}) };
      const links = [...content.matchAll(/\]\(([^)#?]+)(?:#[^)]*)?\)/g)].map((match) => match[1]).filter((target): target is string => !!target && !/^(?:[a-z]+:|\/)/i.test(target)).map((target) => path.posix.normalize(path.posix.join(path.posix.dirname(node.path), target)));
      const query = request.action === "search" ? request.query.trim().toLowerCase() : "";
      const searchText = observation ? content.normalize("NFC") : content;
      const index = query ? searchText.toLowerCase().indexOf(query) : -1;
      const snippet = index >= 0 ? searchText.slice(Math.max(0, index - 80), index + query.length + 120) : undefined;
      let headingMatch = false;
      if (observation && index >= 0) {
        for (const match of searchText.matchAll(/^#{1,6}\s+(.+)$/gm)) {
          if (match[1]?.toLowerCase().includes(query)) { headingMatch = true; break; }
        }
      }
      retainedBytes += Buffer.byteLength(JSON.stringify({ node, links, snippet })) + 64;
      if (result.length >= CATALOG_NODES || retainedBytes > 16 * 1024 * 1024) throw new Error("Wiki catalog exceeds explorer limits");
      result.push({ node, links, digest: createHash("sha256").update(content).digest("hex"), ...(snippet !== undefined ? { snippet } : {}), ...(headingMatch && { headingMatch }), ...(request.action === "detail" && request.id === node.id ? { markdown: wikiDetail(content) } : {}) });
    }
  }
  return result;
}

export async function loadExplorerGraph(root: string, request: MetaprojectRequest, observation?: ExplorerReadObservation) {
  const storage = path.relative(root, gdgraphStorageDir(root));
  let graphPresent: boolean;
  let graphError: string | undefined;
  let files: GraphNode[] = [];
  let imports: GraphEdge[] = [];
  let describes: DescribesEdge[] = [];
  const pages = await wikiPages(root, request, observation);
  await observation?.trackGraph(storage);
  try {
    graphPresent = await exists(root, `${storage}/nodes.jsonl`) && await exists(root, `${storage}/edges.jsonl`);
    if (graphPresent) {
      [files, imports] = await Promise.all([
        jsonl<GraphNode>(root, `${storage}/nodes.jsonl`), jsonl<GraphEdge>(root, `${storage}/edges.jsonl`),
      ]);
      if (files.some((file) => typeof file.path !== "string") || imports.some((edge) => typeof edge.from !== "string" || typeof edge.to !== "string")) throw new Error("Invalid graph record");
    }
  } catch {
    graphPresent = false;
    files = [];
    imports = [];
    graphError = "Graph storage could not be read; rebuild the graph";
  }
  if (graphPresent) {
    try {
      describes = await jsonl<DescribesEdge>(root, `${storage}/describes.jsonl`);
      if (describes.some((edge) => typeof edge.from !== "string" || typeof edge.to !== "string" || typeof edge.origin !== "string" || typeof edge.pattern !== "string")) throw new Error("Invalid describes record");
    } catch {
      describes = [];
      graphError = "Wiki graph relationships could not be read; rebuild the graph";
    }
  }
  const nodes: MetaprojectNode[] = pages.map(({ node }) => node);
  let edges: MetaprojectEdge[] = [];
  const modules = new Set<string>();
  for (const file of files) modules.add(path.posix.dirname(file.path));
  for (const module of modules) nodes.push({ id: `module:${module}`, kind: "module", title: path.posix.basename(module), path: module });
  for (const file of files) {
    const module = path.posix.dirname(file.path);
    nodes.push({ id: fileId(file.path), kind: "file", title: path.posix.basename(file.path), path: file.path, module: `module:${module}` });
    edges.push({ from: `module:${module}`, to: fileId(file.path), kind: "contains" });
  }
  const filePaths = new Set(files.map((file) => file.path));
  const moduleImports = new Map<string, { from: string; to: string; count: number; evidence: string[] }>();
  for (const edge of imports) {
    if (edge.kind !== "imports" || !filePaths.has(edge.from) || !filePaths.has(edge.to)) continue;
    const from = path.posix.dirname(edge.from);
    const to = path.posix.dirname(edge.to);
    if (from === to) continue;
    const key = JSON.stringify([from, to]);
    const aggregate = moduleImports.get(key) ?? { from: `module:${from}`, to: `module:${to}`, count: 0, evidence: [] };
    aggregate.count++;
    if (aggregate.evidence.length < 3) aggregate.evidence.push(`${edge.from} → ${edge.to}`);
    moduleImports.set(key, aggregate);
  }
  // Module relationships precede file edges so they survive a capped catalog.
  const moduleEdges: MetaprojectEdge[] = [...moduleImports.values()].map((edge) => ({ ...edge, kind: "imports" }));
  edges = moduleEdges.concat(edges);
  for (const edge of imports) if (edge.kind === "imports" || edge.kind === "asset") edges.push({ from: fileId(edge.from), to: fileId(edge.to), kind: edge.kind });
  for (const edge of describes) edges.push({ from: edge.from, to: fileId(edge.to), kind: "describes", evidence: [edge.origin, edge.pattern] });
  const pagesByPath = new Map(pages.map((page) => [page.node.path, page.node]));
  for (const page of pages) {
    for (const target of page.links) {
      const found = pagesByPath.get(target);
      if (found) edges.push({ from: page.node.id, to: found.id, kind: "links" });
    }
  }
  let freshness: Awaited<ReturnType<typeof checkGraphStaleness>> | null = null;
  if (graphPresent) {
    try {
      const provenance = ".metaproject/data/gdgraph/.provenance.json";
      if (await exists(root, provenance)) await safeRead(root, provenance, 1024 * 1024);
      freshness = await checkGraphStaleness(root);
    } catch {
      freshness = { status: "unknown", reasons: ["Graph provenance could not be read within the project"] };
    }
  }
  // A cheap change detector, not an atomic snapshot across concurrent writes.
  const layerStats = await Promise.all(["symbols.jsonl", "calls.jsonl", "wiki-pages.jsonl"].map(async (name) => {
    try {
      const relative = `${storage}/${name}`;
      if (!(await exists(root, relative))) return null;
      const info = await stat(path.join(root, relative));
      return [info.size, info.mtimeMs, info.ctimeMs, info.ino];
    } catch { return null; }
  }));
  const snapshotId = createHash("sha256").update(JSON.stringify({ nodes, edges, pages: pages.map(({ digest }) => digest), layerStats })).digest("hex");
  const base = { schemaVersion: METAPROJECT_SCHEMA, snapshotId } as const;
  const hasSymbolLayer = layerStats[0] !== null && layerStats[1] !== null;
  const hasWikiLayer = layerStats[2] !== null;
  const wantsRelationships = request.action === "neighbors" && request.kinds.some((kind) => kind === "calls" || kind === "defines");
  const requiresSymbols = (request.action === "detail" || request.action === "neighbors") && (request.id.startsWith("symbol:") || (!observation && wantsRelationships));
  if (requiresSymbols && !hasSymbolLayer) throw new Error("Symbol layer could not be read; rebuild the graph");
  if (hasSymbolLayer && (request.action === "search" || (request.action === "detail" && request.id.startsWith("symbol:")) || (request.action === "neighbors" && (request.id.startsWith("symbol:") || request.kinds.some((kind) => kind === "calls" || kind === "defines"))))) {
    try {
      const symbols = await jsonl<SymbolNode>(root, `${storage}/symbols.jsonl`, true);
      if (symbols.some((symbol) => typeof symbol.id !== "string" || typeof symbol.path !== "string" || typeof symbol.name !== "string")) throw new Error("Invalid symbol record");
      for (const symbol of symbols) nodes.push({ id: symbolId(symbol.id), kind: "symbol", title: symbol.name, path: symbol.path, line: symbol.startLine });
      if (request.action === "neighbors" && wantsRelationships) {
        const calls = await jsonl<CallEdge>(root, `${storage}/calls.jsonl`, true);
        const symbolIds = new Set(symbols.map((symbol) => symbol.id));
        if (calls.some((call) => typeof call.from !== "string" || typeof call.to !== "string" || !["calls", "defines", "unresolved-call"].includes(call.kind))) throw new Error("Invalid call record");
        for (const call of calls) if (call.kind !== "unresolved-call") edges.push({ from: symbolIds.has(call.from) ? symbolId(call.from) : fileId(call.from), to: symbolId(call.to), kind: call.kind });
      }
    } catch {
      // A broken optional symbol layer must not hide the graph or wiki search.
      if (requiresSymbols) throw new Error("Symbol layer could not be read; rebuild the graph");
    }
  }
  const graph: MetaprojectCatalog["graph"] = graphError ? "unknown" : freshness ? freshness.status === "fresh" ? "ready" : freshness.status : "missing";
  const graphReason = graphError ?? freshness?.reasons.join("; ");
  return { base, nodes, edges, pages, hasSymbolLayer, hasWikiLayer, graph, graphReason,
    counts: { files: files.length, wiki: pages.length, modules: modules.size } };
}

export async function metaprojectExplorer(projectRoot: string, request: MetaprojectRequestV2): Promise<MetaprojectV2Response>;
export async function metaprojectExplorer(projectRoot: string, request: MetaprojectRequest): Promise<MetaprojectResponse>;
export async function metaprojectExplorer(projectRoot: string, request: MetaprojectAnyRequest): Promise<MetaprojectResponse | MetaprojectV2Response>;
export async function metaprojectExplorer(projectRoot: string, request: MetaprojectAnyRequest): Promise<MetaprojectResponse | MetaprojectV2Response> {
  if ("version" in request) {
    return metaprojectExplorerV2(projectRoot, request, async (root, graphRequest) => {
      const observation = new ExplorerReadObservation(root);
      const graph = await loadExplorerGraph(root, graphRequest, observation);
      return { graph, confirm: () => observation.confirm(), track: (target) => observation.track(target) };
    });
  }
  const model = await loadExplorerGraph(await realpath(projectRoot), request);
  const { base, nodes, edges, pages, graph, graphReason, hasSymbolLayer, hasWikiLayer, counts } = model;
  if (request.action === "catalog") {
    const boundedNodes = nodes.slice(0, CATALOG_NODES);
    const ids = new Set(boundedNodes.map((node) => node.id));
    const eligible = edges.filter((edge) => ids.has(edge.from) && ids.has(edge.to));
    const catalog: MetaprojectCatalog = { ...base, nodes: boundedNodes, edges: eligible.slice(0, CATALOG_EDGES), truncated: nodes.length > CATALOG_NODES || eligible.length > CATALOG_EDGES, graph, ...(graphReason ? { graphReason } : {}), hasWikiLayer, hasSymbolLayer, counts };
    return catalog;
  }
  if (request.action === "search") {
    if (!request.query.trim()) return { ...base, hits: [] };
    const wikiText = pages.flatMap(({ node, snippet }) => snippet !== undefined ? [{ node, snippet }] : []);
    return { ...base, hits: rankMetaprojectSearchHits(request.query, nodes, wikiText) };
  }
  const node = nodes.find((item) => item.id === request.id);
  if (!node) throw new Error("Unknown Metaproject node");
  if (request.action === "detail") {
    const page = pages.find((item) => item.node.id === node.id);
    return { ...base, node, ...(page?.markdown !== undefined ? { markdown: page.markdown } : {}) };
  }
  const projection = projectMetaprojectGraph(indexMetaprojectGraph(nodes, edges), base, request);
  if (!projection) throw new Error("Unknown Metaproject node");
  return projection;
}

/** Check the legacy source paths that contributed to a v2 read, including missing paths. */
export class ExplorerReadObservation {
  private readonly fingerprints = new Map<string, string>();

  constructor(private readonly root: string) {}

  async track(relative: string): Promise<void> {
    if (!this.fingerprints.has(relative)) this.fingerprints.set(relative, await this.fingerprint(relative));
  }

  async trackGraph(storage: string): Promise<void> {
    await this.track(storage);
    for (const name of ["nodes", "edges", "describes", "symbols", "calls", "wiki-pages"]) {
      await this.track(`${storage}/${name}.jsonl`);
    }
    await this.track(".metaproject/data/gdgraph/.provenance.json");
  }

  async confirm(): Promise<void> {
    for (const [relative, value] of this.fingerprints) {
      if (value !== await this.fingerprint(relative)) {
        throw new MetaprojectRequestError("stale-snapshot", "Metaproject sources changed during the read. Refresh to retry.");
      }
    }
  }

  private async fingerprint(relative: string): Promise<string> {
    try {
      const info = await lstat(path.resolve(this.root, relative), { bigint: true });
      return [info.dev, info.ino, info.mode, info.size, info.mtimeNs, info.ctimeNs].join(":");
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return "missing";
      return "unavailable";
    }
  }
}
