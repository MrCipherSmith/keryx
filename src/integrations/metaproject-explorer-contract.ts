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

export function isExactMetaprojectSearchMatch(node: MetaprojectNode, query: string): boolean {
  return node.path.toLowerCase() === query
    || ((node.kind === "wiki" || node.kind === "module") && node.title.toLowerCase() === query);
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
