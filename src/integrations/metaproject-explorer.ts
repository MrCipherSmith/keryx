import { createHash } from "node:crypto";
import { readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { gdgraphStorageDir } from "../gdgraph/data-dir";
import { checkGraphStaleness } from "../gdgraph/staleness";
import type { CallEdge, DescribesEdge, GraphEdge, GraphNode, SymbolNode } from "../gdgraph/types";
import { readContainedFile } from "../lib/contained-read";
import { WIKI_PAGE_TYPES } from "../wiki/types";
import { METAPROJECT_EDGE_LIMIT, METAPROJECT_NODE_LIMIT, METAPROJECT_SCHEMA } from "./metaproject-explorer-contract";
import type { MetaprojectCatalog, MetaprojectEdge, MetaprojectNode, MetaprojectRequest, MetaprojectResponse } from "./metaproject-explorer-contract";

const CATALOG_NODES = 12_000;
const CATALOG_EDGES = 40_000;
const MAX_FILE_BYTES = 128 * 1024 * 1024;
const fileId = (value: string): string => `file:${value}`;
const wikiId = (value: string): string => `wiki:${value}`;
const symbolId = (value: string): string => `symbol:${value}`;

async function safeRead(root: string, relative: string, maxBytes = MAX_FILE_BYTES): Promise<string> {
  return (await readContainedFile(root, path.resolve(root, relative), { maxBytes })).toString("utf8");
}

async function jsonl<T>(root: string, relative: string): Promise<T[]> {
  let text: string;
  try { text = await safeRead(root, relative); } catch (error) {
    if ((error as { code?: string }).code === "CONTAINED_READ_NOT_FOUND") return [];
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

async function wikiPages(root: string): Promise<Array<{ node: MetaprojectNode; content: string }>> {
  const result: Array<{ node: MetaprojectNode; content: string }> = [];
  for (const { folder, type } of WIKI_PAGE_TYPES) {
    const dir = `.metaproject/wiki/${folder}`;
    if (!(await exists(root, dir))) continue;
    const names = (await readdir(path.join(root, dir))).filter((name) => name.endsWith(".md")).sort();
    for (const name of names) {
      const relative = `${folder}/${name}`;
      let content: string;
      try { content = await safeRead(root, `${dir}/${name}`, 8 * 1024 * 1024); } catch (error) {
        if ((error as { code?: string }).code === "CONTAINED_READ_OUTSIDE" || (error as { code?: string }).code === "CONTAINED_READ_NOT_FOUND") continue;
        throw error;
      }
      const title = content.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? relative;
      const status = content.match(/^Status:\s*(.+)$/im)?.[1]?.trim();
      result.push({ node: { id: wikiId(relative), kind: "wiki", title, path: `.metaproject/wiki/${relative}`, pageType: type, ...(status ? { status } : {}) }, content });
    }
  }
  return result;
}

export async function metaprojectExplorer(projectRoot: string, request: MetaprojectRequest): Promise<MetaprojectResponse> {
  const root = await realpath(projectRoot);
  const storage = path.relative(root, gdgraphStorageDir(root));
  let graphPresent = false;
  let graphError: string | undefined;
  let files: GraphNode[] = [];
  let imports: GraphEdge[] = [];
  let describes: DescribesEdge[] = [];
  const pages = await wikiPages(root);
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
    if (edge.kind === "unresolved" || !filePaths.has(edge.from) || !filePaths.has(edge.to)) continue;
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
  for (const edge of imports) if (edge.kind !== "unresolved") edges.push({ from: fileId(edge.from), to: fileId(edge.to), kind: "imports" });
  for (const edge of describes) edges.push({ from: edge.from, to: fileId(edge.to), kind: "describes", evidence: [edge.origin, edge.pattern] });
  const pagesByPath = new Map(pages.map((page) => [page.node.path, page.node]));
  for (const page of pages) {
    const base = page.node.path;
    for (const match of page.content.matchAll(/\]\(([^)#?]+)(?:#[^)]*)?\)/g)) {
      const target = match[1];
      if (!target || /^(?:[a-z]+:|\/)/i.test(target)) continue;
      const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(base), target));
      const found = pagesByPath.get(resolved);
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
  const snapshotId = createHash("sha256").update(JSON.stringify({ nodes, edges, pages: pages.map(({ content }) => content), layerStats })).digest("hex");
  const base = { schemaVersion: METAPROJECT_SCHEMA, snapshotId } as const;
  const hasSymbolLayer = layerStats[0] !== null && layerStats[1] !== null;
  const hasWikiLayer = layerStats[2] !== null;
  if (request.action === "catalog") {
    const boundedNodes = nodes.slice(0, CATALOG_NODES);
    const ids = new Set(boundedNodes.map((node) => node.id));
    const eligible = edges.filter((edge) => ids.has(edge.from) && ids.has(edge.to));
    const catalog: MetaprojectCatalog = { ...base, nodes: boundedNodes, edges: eligible.slice(0, CATALOG_EDGES), truncated: nodes.length > CATALOG_NODES || eligible.length > CATALOG_EDGES, graph: graphError ? "unknown" : freshness ? freshness.status === "fresh" ? "ready" : freshness.status : "missing", ...((graphError || freshness?.reasons.length) ? { graphReason: graphError ?? freshness?.reasons.join("; ") ?? "" } : {}), hasWikiLayer, hasSymbolLayer, counts: { files: files.length, wiki: pages.length, modules: modules.size } };
    return catalog;
  }
  if (hasSymbolLayer && (request.action === "search" || (request.action === "detail" && request.id.startsWith("symbol:")) || (request.action === "neighbors" && (request.id.startsWith("symbol:") || request.kinds.some((kind) => kind === "calls" || kind === "defines"))))) {
    try {
      const symbols = await jsonl<SymbolNode>(root, `${storage}/symbols.jsonl`);
      if (symbols.some((symbol) => typeof symbol.id !== "string" || typeof symbol.path !== "string" || typeof symbol.name !== "string")) throw new Error("Invalid symbol record");
      for (const symbol of symbols) nodes.push({ id: symbolId(symbol.id), kind: "symbol", title: symbol.name, path: symbol.path, line: symbol.startLine });
      if (request.action === "neighbors") {
        const calls = await jsonl<CallEdge>(root, `${storage}/calls.jsonl`);
        const symbolIds = new Set(symbols.map((symbol) => symbol.id));
        for (const call of calls) if (call.kind !== "unresolved-call") edges.push({ from: symbolIds.has(call.from) ? symbolId(call.from) : fileId(call.from), to: symbolId(call.to), kind: call.kind });
      }
    } catch {
      // A broken optional symbol layer must not hide the graph or wiki search.
      if (request.action !== "search" && request.id.startsWith("symbol:")) throw new Error("Symbol layer could not be read; rebuild the graph");
    }
  }
  if (request.action === "search") {
    const query = request.query.trim().toLowerCase();
    const exact = query ? nodes.filter((node) => node.title.toLowerCase() === query || node.path.toLowerCase() === query).map((node) => ({ node })) : [];
    const bodyHits: Array<{ node: MetaprojectNode; snippet: string }> = [];
    for (const page of pages) {
      const index = page.content.toLowerCase().indexOf(query);
      if (query && index >= 0 && !exact.some((hit) => hit.node.id === page.node.id)) bodyHits.push({ node: page.node, snippet: page.content.slice(Math.max(0, index - 80), index + query.length + 120) });
    }
    const seen = new Set([...exact, ...bodyHits].map((hit) => hit.node.id));
    const broad = query ? nodes.filter((node) => !seen.has(node.id) && `${node.title} ${node.path}`.toLowerCase().includes(query)).map((node) => ({ node })) : [];
    const hits = [...exact, ...bodyHits, ...broad];
    return { ...base, hits: hits.slice(0, METAPROJECT_NODE_LIMIT) };
  }
  const node = nodes.find((item) => item.id === request.id);
  if (!node) throw new Error("Unknown Metaproject node");
  if (request.action === "detail") {
    const page = pages.find((item) => item.node.id === node.id);
    return { ...base, node, ...(page ? { markdown: page.content } : {}) };
  }
  const visited = new Set([node.id]);
  let frontier = new Set([node.id]);
  const selected: MetaprojectEdge[] = [];
  for (let step = 0; step < request.depth; step++) {
    const next = new Set<string>();
    for (const edge of edges) {
      if (!request.kinds.includes(edge.kind)) continue;
      if ((request.direction !== "incoming" && frontier.has(edge.from)) || (request.direction !== "outgoing" && frontier.has(edge.to))) {
        selected.push(edge);
        if (!visited.has(edge.from)) next.add(edge.from);
        if (!visited.has(edge.to)) next.add(edge.to);
      }
    }
    for (const id of next) visited.add(id);
    frontier = next;
  }
  const selectedNodes = [node, ...nodes.filter((item) => item.id !== node.id && visited.has(item.id))];
  const bounded = selectedNodes.slice(0, METAPROJECT_NODE_LIMIT);
  const ids = new Set(bounded.map((item) => item.id));
  const eligible = [...new Map(selected.filter((edge) => ids.has(edge.from) && ids.has(edge.to)).map((edge) => [JSON.stringify(edge), edge])).values()];
  return { ...base, root: node.id, nodes: bounded, edges: eligible.slice(0, METAPROJECT_EDGE_LIMIT), truncated: selectedNodes.length > bounded.length || eligible.length > METAPROJECT_EDGE_LIMIT };
}
