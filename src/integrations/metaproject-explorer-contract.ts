/** Desktop projection of local project knowledge. Graph and Wiki own the source data. */
export const METAPROJECT_SCHEMA = 1;
export const METAPROJECT_NODE_LIMIT = 200;
export const METAPROJECT_EDGE_LIMIT = 400;

export type MetaprojectNodeKind = "wiki" | "module" | "file" | "symbol" | MetaprojectOpenSpecKind;
export const METAPROJECT_EDGE_KINDS = ["imports", "asset", "describes", "links", "contains", "defines", "calls"] as const;
export const METAPROJECT_EDGE_KINDS_V2 = [...METAPROJECT_EDGE_KINDS, "changes-spec", "spec-context"] as const;
export type MetaprojectEdgeKind = typeof METAPROJECT_EDGE_KINDS_V2[number];

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
  provenance?: readonly MetaprojectEdgeEvidence[];
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

/** Parse an actual unversioned request exactly as a v1 CLI would. */
export function parseExplorerRequestV1(value: unknown): MetaprojectRequest {
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

export const METAPROJECT_SCHEMA_V2 = 2;
export const METAPROJECT_RESPONSE_BYTES_V2 = 1024 * 1024;
export const METAPROJECT_PAGE_SIZE_V2 = 100;
export const METAPROJECT_CAPABILITIES = [
  "catalog", "detail", "search", "neighbors", "openspec-list", "openspec-history",
] as const;
export const METAPROJECT_SCOPES = ["graph", "wiki", "spec", "change", "archive"] as const;
export type MetaprojectScope = typeof METAPROJECT_SCOPES[number];

export interface MetaprojectEdgeEvidence {
  path: string;
  digest: string;
  index?: number;
}

/** Transport DTOs are checked independently from the filesystem service. */
export type MetaprojectOpenSpecKind = "spec" | "change" | "archive";

export interface MetaprojectSourceRef {
  path: string;
  digest: string;
  startLine?: number;
  endLine?: number;
}

export interface MetaprojectOpenSpecEntry {
  id: string;
  kind: MetaprojectOpenSpecKind;
  title: string;
  path: string;
  archiveDate?: string;
}

export interface MetaprojectOpenSpecDiagnostic {
  code: string;
  message: string;
  path?: string;
  index?: number;
  retryable?: boolean;
  line?: number;
  endLine?: number;
}

interface MetaprojectOpenSpecSection {
  title: string;
  section: string;
  source: MetaprojectSourceRef;
}

export interface MetaprojectOpenSpecRequirement extends MetaprojectOpenSpecSection {
  operation?: "added" | "modified" | "removed" | "renamed";
  renamedTo?: string;
  baseline?: { state: "matched" | "absent" | "unresolved"; source?: MetaprojectSourceRef };
  scenarios: MetaprojectOpenSpecSection[];
}

export interface MetaprojectOpenSpecDetail {
  snapshotId: string;
  entry: MetaprojectOpenSpecEntry;
  artifacts: MetaprojectSourceRef[];
  artifact?: {
    source: MetaprojectSourceRef;
    markdown: string;
    requirements: MetaprojectOpenSpecRequirement[];
    section?: string;
  };
  diagnostics: MetaprojectOpenSpecDiagnostic[];
  relatedSpecs: { changeId: string; specPath: string; source: MetaprojectSourceRef }[];
  deltas: { specPath: string; source: MetaprojectSourceRef; requirements: MetaprojectOpenSpecRequirement[] }[];
  partial: boolean;
}

export interface MetaprojectOpenSpecHistoryItem {
  entry: MetaprojectOpenSpecEntry;
  source: MetaprojectSourceRef;
  requirements: MetaprojectOpenSpecRequirement[];
}

export interface MetaprojectOpenSpecState {
  availability: "missing" | "empty" | "ready" | "partial" | "unavailable";
  counts: Record<MetaprojectOpenSpecKind, number>;
  diagnostics: MetaprojectOpenSpecDiagnostic[];
  truncated: boolean;
}

interface SnapshotV2 {
  schemaVersion: 2;
  snapshotId: string;
}

export interface MetaprojectCatalogV2 extends Omit<MetaprojectCatalog, "schemaVersion">, SnapshotV2 {
  openSpec: MetaprojectOpenSpecState;
}

export interface MetaprojectNeighborsV2 extends Omit<MetaprojectNeighbors, "schemaVersion">, SnapshotV2 {
  openSpec: MetaprojectOpenSpecState;
}

export interface MetaprojectDetailV2 extends Omit<MetaprojectDetail, "schemaVersion">, SnapshotV2 {
  openSpec?: MetaprojectOpenSpecDetail;
  relationships?: { node: MetaprojectNode; edge: MetaprojectEdge }[];
}

export interface MetaprojectHitV2 extends MetaprojectHit {
  scope: MetaprojectScope;
  source?: MetaprojectSourceRef;
  matchType?: "title" | "path" | "heading" | "body";
}

export interface MetaprojectSearchV2 extends SnapshotV2 {
  hits: MetaprojectHitV2[];
  nextCursor?: string;
  partial: boolean;
}

export interface MetaprojectOpenSpecList extends SnapshotV2 {
  collection: MetaprojectOpenSpecKind;
  entries: MetaprojectOpenSpecEntry[];
  nextCursor?: string;
  partial: boolean;
  openSpec: MetaprojectOpenSpecState;
}

export interface MetaprojectOpenSpecHistory extends SnapshotV2 {
  id: string;
  entries: MetaprojectOpenSpecHistoryItem[];
  nextCursor?: string;
  partial: boolean;
}

export interface MetaprojectCapabilities {
  schemaVersion: 2;
  /** Every action the answering reader serves. A client requires the ones it sends and ignores the rest. */
  actions: readonly string[];
}

export type MetaprojectV2Response =
  | MetaprojectCapabilities | MetaprojectCatalogV2 | MetaprojectDetailV2 | MetaprojectSearchV2
  | MetaprojectNeighborsV2 | MetaprojectOpenSpecList | MetaprojectOpenSpecHistory;

type V2Data<T> = T & { version: 2; expectedSnapshotId?: string };
export type MetaprojectRequestV2 =
  | { version: 2; action: "capabilities" }
  | V2Data<{ action: "catalog" }>
  | V2Data<{ action: "detail"; id: string; artifact?: string; section?: string; digest?: string }>
  | V2Data<{ action: "search"; query: string; scopes?: MetaprojectScope[]; cursor?: string }>
  | V2Data<Extract<MetaprojectRequest, { action: "neighbors" }> & { includeArchive?: boolean }>
  | V2Data<{ action: "openspec-list"; collection: MetaprojectOpenSpecKind; cursor?: string }>
  | V2Data<{ action: "openspec-history"; id: string; cursor?: string }>;

export type MetaprojectAnyRequest = MetaprojectRequest | MetaprojectRequestV2;

export const METAPROJECT_ERROR_CODES = [
  "unsupported-version", "invalid-input", "stale-snapshot", "stale-section", "not-found", "source-changed", "source-unavailable", "response-limit",
] as const;
export type MetaprojectErrorCode = typeof METAPROJECT_ERROR_CODES[number];

export class MetaprojectRequestError extends Error {
  constructor(readonly code: MetaprojectErrorCode, message: string) {
    super(message);
    this.name = "MetaprojectRequestError";
  }
}

export function isMetaprojectScope(value: unknown): value is MetaprojectScope {
  return METAPROJECT_SCOPES.some((scope) => scope === value);
}

export function isMetaprojectV2EdgeKind(value: unknown): value is MetaprojectEdgeKind {
  return METAPROJECT_EDGE_KINDS_V2.some((kind) => kind === value);
}

export function isOpenSpecKind(value: unknown): value is MetaprojectOpenSpecKind {
  return value === "spec" || value === "change" || value === "archive";
}

export function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

export function isMetaprojectRelativePath(value: unknown): value is string {
  return typeof value === "string" && value.length <= 4096 && !/^[a-z]:/i.test(value)
    && !value.includes("\\") && [...value].every((char) => char >= " " && char !== "\x7f")
    && value.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

function validId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 4096;
}

function validDirection(value: unknown): value is MetaprojectDirection {
  return value === "both" || value === "incoming" || value === "outgoing";
}

function parseV2(input: Record<string, unknown>): MetaprojectRequestV2 {
  const keys = Object.keys(input);
  const exact = (...allowed: string[]): boolean => keys.every((key) => allowed.includes(key));
  if (input.action === "capabilities" && exact("action", "version")) return { action: "capabilities", version: 2 };
  const common = ["action", "version", "expectedSnapshotId"];
  const allowed = (...specific: string[]) => exact(...common, ...specific);
  const invalid = () => new MetaprojectRequestError("invalid-input", "Invalid Metaproject v2 request.");
  if (input.expectedSnapshotId !== undefined && !isSha256(input.expectedSnapshotId)) throw invalid();
  const base = { version: 2 as const, ...(input.expectedSnapshotId !== undefined && { expectedSnapshotId: input.expectedSnapshotId }) };
  const { action, id, artifact, section, digest, scopes, query, collection, cursor, depth, kinds, direction, includeArchive } = input;
  switch (action) {
    case "catalog":
      if (allowed()) return { ...base, action };
      break;
    case "detail":
      if (allowed("id", "artifact", "section", "digest") && validId(id)
        && (artifact === undefined || isMetaprojectRelativePath(artifact))
        && (section === undefined || validId(section))
        && (digest === undefined || isSha256(digest))) {
        return { ...base, action, id, ...(artifact !== undefined && { artifact }),
          ...(section !== undefined && { section }), ...(digest !== undefined && { digest }) };
      }
      break;
    case "search":
      if (allowed("query", "scopes", "cursor") && typeof query === "string" && query.length <= 4096
        && (scopes === undefined || (Array.isArray(scopes) && scopes.length > 0 && scopes.length <= METAPROJECT_SCOPES.length
          && scopes.every(isMetaprojectScope) && new Set(scopes).size === scopes.length))
        && (cursor === undefined || validId(cursor))) {
        return { ...base, action, query, ...(scopes !== undefined && { scopes }), ...(cursor !== undefined && { cursor }) };
      }
      break;
    case "neighbors":
      if (allowed("id", "depth", "direction", "kinds", "includeArchive") && validId(id)
        && (depth === 1 || depth === 2) && validDirection(direction) && Array.isArray(kinds)
        && kinds.length <= METAPROJECT_EDGE_KINDS_V2.length && kinds.every(isMetaprojectV2EdgeKind)
        && (includeArchive === undefined || typeof includeArchive === "boolean")) {
        return { ...base, action, id, depth, direction, kinds, ...(includeArchive !== undefined && { includeArchive }) };
      }
      break;
    case "openspec-list":
      if (allowed("collection", "cursor") && isOpenSpecKind(collection) && (cursor === undefined || validId(cursor))) {
        return { ...base, action, collection, ...(cursor !== undefined && { cursor }) };
      }
      break;
    case "openspec-history":
      if (allowed("id", "cursor") && validId(id) && (cursor === undefined || validId(cursor))) {
        return { ...base, action, id, ...(cursor !== undefined && { cursor }) };
      }
      break;
  }
  throw invalid();
}

export function parseExplorerRequest(value: unknown): MetaprojectAnyRequest {
  if (!value || typeof value !== "object" || Array.isArray(value) || !("version" in value)) return parseExplorerRequestV1(value);
  if (value.version !== 2) throw new MetaprojectRequestError("unsupported-version", "Unsupported Metaproject request version.");
  return parseV2(value as Record<string, unknown>);
}
