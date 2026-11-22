import { createHash } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";

import type { OpenSpecDiagnostic, OpenSpecKind } from "../openspec/catalog";
import { OpenSpecReadError, normalizeOpenSpecSearchText, readOpenSpec, type OpenSpecEntrySummary, type OpenSpecSnapshot } from "../openspec/service";
import {
  METAPROJECT_CAPABILITIES, METAPROJECT_EDGE_LIMIT, METAPROJECT_NODE_LIMIT, METAPROJECT_PAGE_SIZE_V2,
  METAPROJECT_RESPONSE_BYTES_V2, METAPROJECT_SCHEMA_V2, METAPROJECT_SCOPES, MetaprojectRequestError,
  isMetaprojectRelativePath, isOpenSpecKind, type MetaprojectEdge, type MetaprojectEdgeEvidence,
  type MetaprojectHitV2, type MetaprojectNode, type MetaprojectOpenSpecState, type MetaprojectProjection,
  type MetaprojectRequest, type MetaprojectRequestV2, type MetaprojectScope, type MetaprojectV2Response,
} from "./metaproject-explorer-contract";
import type { loadExplorerGraph } from "./metaproject-explorer";
import { indexMetaprojectGraph, projectMetaprojectGraph } from "./metaproject-projection";

type DataRequest = Exclude<MetaprojectRequestV2, { action: "capabilities" }>;
type SearchRequest = Extract<DataRequest, { action: "search" }>;
type GraphModel = Awaited<ReturnType<typeof loadExplorerGraph>>;
type LoadGraph = (root: string, request: MetaprojectRequest) => Promise<{ graph: GraphModel; confirm: () => Promise<void>; track: (relative: string) => Promise<void> }>;

const DEFAULT_SCOPES: readonly MetaprojectScope[] = ["graph", "wiki", "spec", "change"];
const MAX_DIAGNOSTICS = 64;
const MAX_EDGE_EVIDENCE = 3;
const MAX_DETAIL_RELATIONSHIPS = 40;
const CATALOG_METADATA_BYTES = 128 * 1024;
const SEARCH_ITEMS_BYTES = 900 * 1024;
const MAX_LEGACY_HITS_PER_SCOPE = 12_000;

const bytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value));
const hash = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const compareText = (a: string, b: string): number => a < b ? -1 : Number(a > b);

function safeGraphNode(node: MetaprojectNode): boolean {
  return isMetaprojectRelativePath(node.path) || (node.kind === "module" && node.path === ".");
}

function entryNode(entry: OpenSpecEntrySummary): MetaprojectNode {
  return { id: entry.id, kind: entry.kind, title: entry.title, path: entry.path };
}

function checkSnapshot(actual: string, expected?: string): void {
  if (expected !== undefined && actual !== expected) {
    throw new MetaprojectRequestError("stale-snapshot", "Metaproject changed. Refresh and retry.");
  }
}

function boundedItems<T>(items: readonly T[], limit: number, byteLimit: number): T[] {
  const bounded: T[] = [];
  let used = 2;
  for (const item of items) {
    if (bounded.length >= limit) break;
    used += bytes(item) + 1;
    if (used > byteLimit) break;
    bounded.push(item);
  }
  return bounded;
}

function cursor(snapshotId: string, key: string, continuation: string | number): string {
  return Buffer.from(JSON.stringify([snapshotId, key, continuation])).toString("base64url");
}

function cursorValue(
  snapshotId: string, key: string, value?: string,
): string | number | undefined {
  if (value === undefined) return undefined;
  try {
    const decoded = Buffer.from(value, "base64url");
    if (decoded.toString("base64url") !== value) throw new Error("encoding");
    const input: unknown = JSON.parse(decoded.toString("utf8"));
    if (!Array.isArray(input) || input.length !== 3 || input[1] !== key || typeof input[0] !== "string"
      || !/^[a-f0-9]{64}$/.test(input[0])) throw new Error("fields");
    const continuation: unknown = input[2];
    if (typeof continuation !== "string" && (typeof continuation !== "number"
      || continuation < 1 || !Number.isSafeInteger(continuation))) throw new Error("offset");
    checkSnapshot(snapshotId, input[0]);
    return continuation;
  } catch (error) {
    if (error instanceof MetaprojectRequestError) throw error;
    throw new MetaprojectRequestError("invalid-input", "The Metaproject cursor does not match this request.");
  }
}

function graphRequest(request: DataRequest): MetaprojectRequest {
  switch (request.action) {
    case "detail": return { action: request.action, id: request.id };
    case "neighbors": return { action: request.action, id: request.id, depth: request.depth, direction: request.direction, kinds: request.kinds };
    case "search": return request.scopes?.every(isOpenSpecKind)
      ? { action: "catalog" }
      : { action: request.action, query: request.query.normalize("NFC") };
    default: return { action: "catalog" };
  }
}

async function knownLinkTarget(node: MetaprojectNode, root: string): Promise<boolean> {
  // A stale index can name a removed path or a directory redirected by a symlink.
  const candidate = path.resolve(root, node.path);
  const relative = path.relative(root, candidate);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return false;
  try {
    if (await realpath(candidate) !== candidate) return false;
    const info = await stat(candidate);
    return node.kind === "module" ? info.isDirectory() : info.isFile();
  } catch {
    return false;
  }
}

function appendEdge(
  edges: Map<string, MetaprojectEdge>, from: string, to: string,
  kind: "changes-spec" | "spec-context", provenance: MetaprojectEdgeEvidence,
): void {
  const key = JSON.stringify([from, to, kind]);
  const previous = edges.get(key);
  if ((previous?.provenance?.length ?? 0) >= MAX_EDGE_EVIDENCE) return;
  edges.set(key, { from, to, kind, provenance: [...previous?.provenance ?? [], provenance] });
}

async function buildRelationships(
  source: OpenSpecSnapshot, model: GraphModel, root: string, track: (relative: string) => Promise<void>,
): Promise<{ edges: MetaprojectEdge[]; diagnostics: OpenSpecDiagnostic[] }> {
  const edges = new Map<string, MetaprojectEdge>();
  const bySourcePath = new Map(source.catalog.entries.map((entry) => [entry.path, entry]));
  const targets = new Map(model.nodes.map((node) => [JSON.stringify([node.kind, node.path]), node]));
  const diagnostics: OpenSpecDiagnostic[] = [];
  for (const delta of source.relationships.deltas) {
    const spec = bySourcePath.get(delta.specPath);
    if (spec?.kind === "spec") {
      appendEdge(edges, delta.changeId, spec.id, "changes-spec", { path: delta.source.path, digest: delta.source.digest });
    }
  }

  const checkedTargets = new Map<string, boolean>();
  const declared = new Set<string>();
  for (const link of source.relationships.links) {
    const from = bySourcePath.get(link.source.path);
    const to = targets.get(JSON.stringify([link.target.kind, link.target.path]));
    if (to && !checkedTargets.has(to.id)) {
      await track(to.path);
      checkedTargets.set(to.id, await knownLinkTarget(to, root));
    }
    if (!from || !to || !checkedTargets.get(to.id)) {
      diagnostics.push({ code: "link-target-not-found", path: link.path, index: link.index, message: "OpenSpec link target is unavailable in this checkout's catalog." });
      continue;
    }
    const key = JSON.stringify([from.id, to.id]);
    if (declared.has(key)) {
      diagnostics.push({ code: "link-duplicate", path: link.path, index: link.index, message: "OpenSpec link duplicates an earlier relationship." });
    }
    declared.add(key);
    appendEdge(edges, from.id, to.id, "spec-context", { path: link.path, digest: link.digest, index: link.index });
  }
  return { edges: [...edges.values()], diagnostics };
}

function sourceState(source: OpenSpecSnapshot, linkDiagnostics: OpenSpecDiagnostic[]): MetaprojectOpenSpecState {
  const { availability, counts, diagnostics, truncated } = source.catalog;
  const allDiagnostics = [...diagnostics, ...linkDiagnostics];
  const bounded = boundedItems(allDiagnostics, MAX_DIAGNOSTICS, 72 * 1024);
  if (bounded.length < allDiagnostics.length) {
    bounded.push({ code: "diagnostic-limit", message: "Additional OpenSpec diagnostics were omitted." });
  }
  return {
    availability: linkDiagnostics.length && availability === "ready" ? "partial" : availability,
    counts,
    diagnostics: bounded,
    truncated: truncated || bounded.length < allDiagnostics.length,
  };
}

function capProjection(nodes: MetaprojectNode[], edges: MetaprojectEdge[], inheritedTruncation = false): MetaprojectProjection {
  const keptNodes = boundedItems(nodes, METAPROJECT_NODE_LIMIT, 500 * 1024);
  const ids = new Set(keptNodes.map(({ id }) => id));
  const candidates = edges.filter((edge) => ids.has(edge.from) && ids.has(edge.to));
  const keptEdges = boundedItems(candidates, METAPROJECT_EDGE_LIMIT, METAPROJECT_RESPONSE_BYTES_V2 - CATALOG_METADATA_BYTES - bytes(keptNodes));
  return { nodes: keptNodes, edges: keptEdges, truncated: inheritedTruncation || keptNodes.length < nodes.length || keptEdges.length < candidates.length };
}

function legacySearch(model: GraphModel, needle: string, scopes: readonly MetaprojectScope[]) {
  const items: Array<{ rank: number; hit: MetaprojectHitV2 }> = [];
  if (!needle) return { items, partial: false };
  const pages = new Map(model.pages.map((page) => [page.node.id, page]));
  const counts = { wiki: 0, graph: 0 };
  let partial = false;
  for (const node of model.nodes) {
    const scope = node.kind === "wiki" ? "wiki" : "graph";
    if (!scopes.includes(scope)) continue;
    const page = pages.get(node.id);
    const sourcePath = normalizeOpenSpecSearchText(node.path);
    const title = normalizeOpenSpecSearchText(node.title);
    const rank = sourcePath === needle || title === needle ? 0
      : sourcePath.includes(needle) || title.includes(needle) || page?.headingMatch ? 1 : 2;
    if (rank === 2 && page?.snippet === undefined) continue;
    if (counts[scope] >= MAX_LEGACY_HITS_PER_SCOPE) {
      partial = true;
      continue;
    }
    counts[scope]++;
    items.push({ rank, hit: { node, scope, ...(page?.snippet !== undefined && { snippet: page.snippet }) } });
  }
  return { items, partial };
}

function interleave(matches: Array<{ rank: number; hit: MetaprojectHitV2 }>): MetaprojectHitV2[] {
  const result: MetaprojectHitV2[] = [];
  const seen = new Set<string>();
  for (const rank of [0, 1, 2]) {
    const groups = METAPROJECT_SCOPES.map((scope) => matches
      .filter((item) => item.rank === rank && item.hit.scope === scope)
      .map(({ hit }) => hit)
      .sort((a, b) => compareText(a.node.kind, b.node.kind) || compareText(a.node.path, b.node.path)
        || compareText(a.source?.path ?? "", b.source?.path ?? "")
        || (a.source?.startLine ?? a.node.line ?? 0) - (b.source?.startLine ?? b.node.line ?? 0)
        || compareText(a.node.id, b.node.id)));
    const max = Math.max(...groups.map((group) => group.length));
    for (let i = 0; i < max; i++) {
      for (const group of groups) {
        const hit = group[i];
        if (!hit) continue;
        const key = JSON.stringify([hit.node.id, hit.section]);
        if (!seen.has(key)) {
          result.push(hit);
          seen.add(key);
        }
      }
    }
  }
  return result;
}

class V2Read {
  private readonly base: { schemaVersion: 2; snapshotId: string };
  private readonly state: MetaprojectOpenSpecState;
  private readonly openNodes: MetaprojectNode[];

  constructor(
    private readonly model: GraphModel,
    private readonly source: OpenSpecSnapshot,
    private readonly openEdges: MetaprojectEdge[],
    diagnostics: OpenSpecDiagnostic[],
  ) {
    this.base = { schemaVersion: METAPROJECT_SCHEMA_V2, snapshotId: hash([model.base.snapshotId, source.catalog.snapshotId, model.graph, model.graphReason, openEdges, diagnostics]) };
    this.state = sourceState(source, diagnostics);
    this.openNodes = source.catalog.entries.map(entryNode);
  }

  read(request: DataRequest): MetaprojectV2Response {
    checkSnapshot(this.base.snapshotId, request.expectedSnapshotId);
    switch (request.action) {
      case "catalog": return this.catalog();
      case "detail": return this.detail(request);
      case "neighbors": return this.neighbors(request);
      case "search": return this.search(request);
      case "openspec-list": return this.list(request.collection, request.cursor);
      case "openspec-history": return this.history(request.id, request.cursor);
    }
  }

  private catalog() {
    const { graph, graphReason, hasWikiLayer, hasSymbolLayer, counts } = this.model;
    const groups = [
      this.model.nodes.filter((node) => node.kind === "wiki"),
      this.model.nodes.filter((node) => node.kind !== "wiki"),
      this.openNodes.filter((node) => node.kind === "spec"),
      this.openNodes.filter((node) => node.kind === "change"),
    ];
    const nodes: MetaprojectNode[] = [];
    for (let i = 0; i < Math.max(...groups.map((group) => group.length)) && nodes.length <= METAPROJECT_NODE_LIMIT; i++) {
      for (const group of groups) {
        const node = group[i];
        if (node) nodes.push(node);
      }
    }
    return { ...this.base, ...capProjection(nodes, [...this.openEdges, ...this.model.edges]), graph,
      ...(graphReason && { graphReason }), hasWikiLayer, hasSymbolLayer, counts, openSpec: this.state };
  }

  private detail(request: Extract<DataRequest, { action: "detail" }>) {
    const node = this.openNodes.find(({ id }) => id === request.id) ?? this.model.nodes.find(({ id }) => id === request.id);
    if (!node) throw new MetaprojectRequestError("not-found", "Unknown Metaproject node.");
    const { artifact, section, digest } = request;
    const openSpec = isOpenSpecKind(node.kind) ? this.source.detail({
      id: node.id, ...(artifact !== undefined && { artifactPath: artifact }),
      ...(section !== undefined && { section }), ...(digest !== undefined && { expectedDigest: digest }),
    }) : undefined;
    if (!openSpec && (artifact !== undefined || section !== undefined || digest !== undefined)) {
      throw new MetaprojectRequestError("invalid-input", "Artifact and section options require an OpenSpec entry.");
    }
    const selected = this.model.pages.find((page) => page.node.id === node.id);
    const byId = new Map([...this.openNodes, ...this.model.nodes].map((item) => [item.id, item]));
    const related = this.openEdges.flatMap((edge) => {
      const other = edge.from === node.id ? byId.get(edge.to) : edge.to === node.id ? byId.get(edge.from) : undefined;
      return other ? [{ node: other, edge }] : [];
    });
    const payload = { ...this.base, node, ...(openSpec && { openSpec: { ...openSpec, snapshotId: this.base.snapshotId } }),
      ...(selected?.markdown !== undefined && { markdown: selected.markdown }) };
    const relationships = boundedItems(related, MAX_DETAIL_RELATIONSHIPS, METAPROJECT_RESPONSE_BYTES_V2 - bytes(payload) - 256);
    return { ...payload, ...(relationships.length && { relationships }) };
  }

  private neighbors(request: Extract<DataRequest, { action: "neighbors" }>) {
    const openNodes = this.openNodes.filter((node) => node.kind !== "archive" || request.includeArchive || node.id === request.id);
    const index = indexMetaprojectGraph([...this.model.nodes, ...openNodes], [...this.openEdges, ...this.model.edges]);
    const projection = projectMetaprojectGraph(index, this.base, request);
    if (!projection) throw new MetaprojectRequestError("not-found", "Unknown Metaproject node.");
    return { ...projection, ...capProjection(projection.nodes, projection.edges, projection.truncated), openSpec: this.state };
  }

  private search(request: SearchRequest) {
    const needle = normalizeOpenSpecSearchText(request.query.trim());
    const scopes = request.scopes ?? DEFAULT_SCOPES;
    const key = hash(["search", needle, [...scopes].sort()]);
    const offset = cursorValue(this.base.snapshotId, key, request.cursor) ?? 0;
    const scope = scopes.filter(isOpenSpecKind);
    const { items, partial } = this.openSpecSearch(needle, scope, scopes);
    const legacy = legacySearch(this.model, needle, scopes);
    const hits = interleave([
      ...legacy.items,
      ...items.map(({ entry, rank, source, snippet, section, matchType }) => ({
        rank, hit: { node: entryNode(entry), scope: entry.kind, ...(source !== undefined && { source }),
          snippet, matchType, ...(section !== undefined && { section }) },
      })),
    ]);
    if (typeof offset !== "number" || (offset > 0 && offset >= hits.length)) {
      throw new MetaprojectRequestError("invalid-input", "The Metaproject search cursor offset is out of range.");
    }
    const page = boundedItems(hits.slice(offset), METAPROJECT_PAGE_SIZE_V2, SEARCH_ITEMS_BYTES);
    if (!page.length && offset < hits.length) throw new MetaprojectRequestError("response-limit", "Metaproject search hit exceeds the response limit.");
    const next = offset + page.length;
    return { ...this.base, hits: page, partial: partial || legacy.partial,
      ...(next < hits.length && { nextCursor: cursor(this.base.snapshotId, key, next) }) };
  }

  private openSpecSearch(needle: string, scope: OpenSpecKind[], scopes: readonly MetaprojectScope[]) {
    if (!needle || !scope.length) return { items: [], partial: false };
    const changed = this.source.catalog.diagnostics.some((diagnostic) => diagnostic.code === "source-changed" && diagnostic.retryable);
    if (changed && (scopes.includes("graph") || scopes.includes("wiki"))) return { items: [], partial: true };
    const result = this.source.searchHits({ query: needle, scope });
    return { ...result, partial: result.partial || this.state.availability === "partial" || this.state.availability === "unavailable" };
  }

  private list(collection: OpenSpecKind, previous?: string) {
    const key = hash(["list", collection]);
    const inner = this.sourceCursor(key, previous);
    const result = this.source.list({ kind: collection, ...(inner !== undefined && { cursor: inner }) });
    return { ...this.base, collection, entries: result.items, partial: result.partial, openSpec: this.state,
      ...(result.nextCursor && { nextCursor: cursor(this.base.snapshotId, key, result.nextCursor) }) };
  }

  private history(id: string, previous?: string) {
    const key = hash(["history", id]);
    const inner = this.sourceCursor(key, previous);
    const result = this.source.history({ id, ...(inner !== undefined && { cursor: inner }) });
    return { ...this.base, id, entries: result.items, partial: result.partial,
      ...(result.nextCursor && { nextCursor: cursor(this.base.snapshotId, key, result.nextCursor) }) };
  }

  private sourceCursor(key: string, previous?: string): string | undefined {
    const decoded = cursorValue(this.base.snapshotId, key, previous);
    if (typeof decoded === "number") throw new MetaprojectRequestError("invalid-input", "Invalid OpenSpec cursor.");
    return decoded;
  }
}

export async function metaprojectExplorerV2(
  projectRoot: string, request: MetaprojectRequestV2, load: LoadGraph,
): Promise<MetaprojectV2Response> {
  if (request.action === "capabilities") return { schemaVersion: METAPROJECT_SCHEMA_V2, actions: METAPROJECT_CAPABILITIES };
  try {
    const root = await realpath(projectRoot);
    const [{ graph: loaded, confirm, track }, source] = await Promise.all([
      load(root, graphRequest(request)),
      readOpenSpec(root),
    ]);
    const graph = { ...loaded, nodes: loaded.nodes.filter(safeGraphNode) };
    const { edges, diagnostics } = await buildRelationships(source, graph, root, track);
    await confirm();
    const response = new V2Read(graph, source, edges, diagnostics).read(request);
    if (bytes(response) + 1 > METAPROJECT_RESPONSE_BYTES_V2) {
      throw new MetaprojectRequestError("response-limit", "Metaproject response exceeds the byte limit.");
    }
    return response;
  } catch (error) {
    if (error instanceof MetaprojectRequestError) throw error;
    if (error instanceof OpenSpecReadError) throw new MetaprojectRequestError(error.code, error.message);
    throw new MetaprojectRequestError("source-unavailable", "Metaproject sources could not be read.");
  }
}
