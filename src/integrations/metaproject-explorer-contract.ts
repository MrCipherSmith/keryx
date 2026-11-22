/** Desktop projection of local project knowledge. Graph and Wiki own the source data. */
export const METAPROJECT_SCHEMA = 1;
export const METAPROJECT_NODE_LIMIT = 200;
export const METAPROJECT_EDGE_LIMIT = 400;

export type MetaprojectNodeKind = "wiki" | "module" | "file" | "symbol";
export const METAPROJECT_EDGE_KINDS = ["imports", "asset", "describes", "links", "contains", "defines", "calls"] as const;
export type MetaprojectEdgeKind = typeof METAPROJECT_EDGE_KINDS[number];

export function isMetaprojectEdgeKind(value: unknown): value is MetaprojectEdgeKind {
  return METAPROJECT_EDGE_KINDS.some(kind => kind === value);
}
export type MetaprojectDirection = "both" | "incoming" | "outgoing";

export interface MetaprojectNode {
  /** Opaque, checkout-scoped identity. */
  id: string;
  kind: MetaprojectNodeKind;
  title: string;
  path: string;
  /** The enclosing module node ID where known. */
  module?: string;
  pageType?: string;
  status?: string;
  line?: number;
}

export interface MetaprojectEdge {
  from: string;
  to: string;
  kind: MetaprojectEdgeKind;
  evidence?: readonly string[];
  count?: number;
}

export interface MetaprojectProjection {
  nodes: MetaprojectNode[];
  edges: MetaprojectEdge[];
  truncated: boolean;
}

interface SnapshotResponse {
  schemaVersion: typeof METAPROJECT_SCHEMA;
  snapshotId: string;
}

export interface MetaprojectCatalog extends SnapshotResponse, MetaprojectProjection {
  graph: "ready" | "stale" | "missing" | "unknown";
  graphReason?: string;
  hasWikiLayer: boolean;
  hasSymbolLayer: boolean;
  counts: { files: number; wiki: number; modules: number };
}

export interface MetaprojectDetail extends SnapshotResponse {
  node: MetaprojectNode;
  markdown?: string;
}

export interface MetaprojectHit {
  node: MetaprojectNode;
  snippet?: string;
  section?: string;
}

export interface MetaprojectSearch extends SnapshotResponse {
  hits: MetaprojectHit[];
}

export interface MetaprojectNeighbors extends SnapshotResponse, MetaprojectProjection {
  root: string;
}

export type MetaprojectRequest =
  | { action: "catalog" }
  | { action: "detail"; id: string }
  | { action: "search"; query: string }
  | {
      action: "neighbors";
      id: string;
      depth: 1 | 2;
      direction: MetaprojectDirection;
      kinds: MetaprojectEdgeKind[];
    };

export type MetaprojectResponse =
  | MetaprojectCatalog
  | MetaprojectDetail
  | MetaprojectSearch
  | MetaprojectNeighbors;

export function parseExplorerRequest(value: unknown): MetaprojectRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid request");
  const input = value as Record<string, unknown>;
  const keys = Object.keys(input);
  const exact = (...allowed: string[]): boolean => keys.every((key) => allowed.includes(key));
  if (input.action === "catalog" && exact("action")) return { action: "catalog" };
  if (input.action === "detail" && exact("action", "id") && typeof input.id === "string" && input.id.length <= 4096) return { action: "detail", id: input.id };
  if (input.action === "search" && exact("action", "query") && typeof input.query === "string" && input.query.length <= 4096) return { action: "search", query: input.query };
  if (input.action === "neighbors" && exact("action", "id", "depth", "direction", "kinds") && typeof input.id === "string" && input.id.length <= 4096 && (input.depth === 1 || input.depth === 2) && (input.direction === "both" || input.direction === "incoming" || input.direction === "outgoing") && Array.isArray(input.kinds) && input.kinds.length <= METAPROJECT_EDGE_KINDS.length && input.kinds.every(isMetaprojectEdgeKind)) {
    return { action: "neighbors", id: input.id, depth: input.depth, direction: input.direction, kinds: input.kinds };
  }
  throw new Error("Invalid request");
}

/** Merge metadata and text matches before applying the shared result limit. */
export function rankMetaprojectSearchHits(
  query: string,
  nodes: Iterable<MetaprojectNode>,
  hits: readonly MetaprojectHit[],
): MetaprojectHit[] {
  const needle = query.trim().toLowerCase();
  const indexed = new Map(hits.map(hit => [hit.node.id, hit]));
  for (const node of nodes) {
    if (indexed.has(node.id)) continue;
    if (node.title.toLowerCase().includes(needle) || node.path.toLowerCase().includes(needle)) {
      indexed.set(node.id, { node });
    }
  }

  if (!needle) return [...indexed.values()].slice(0, METAPROJECT_NODE_LIMIT);

  const paths: MetaprojectHit[] = [];
  const names: MetaprojectHit[] = [];
  const wikiText: MetaprojectHit[] = [];
  const partial: MetaprojectHit[] = [];
  for (const hit of indexed.values()) {
    const { node, snippet } = hit;
    if (node.kind !== "symbol" && node.path.toLowerCase() === needle) paths.push(hit);
    else if (node.title.toLowerCase() === needle) names.push(hit);
    else if (node.kind === "wiki" && snippet !== undefined) wikiText.push(hit);
    else partial.push(hit);
  }

  const result = paths.slice(0, METAPROJECT_NODE_LIMIT);
  // Repeated basenames and common wiki terms must both survive a full page.
  for (let i = 0; i < Math.max(names.length, wikiText.length) && result.length < METAPROJECT_NODE_LIMIT; i++) {
    const name = names[i];
    const text = wikiText[i];
    if (name) result.push(name);
    if (text && result.length < METAPROJECT_NODE_LIMIT) result.push(text);
  }
  return result.concat(partial.slice(0, METAPROJECT_NODE_LIMIT - result.length));
}
