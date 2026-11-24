import {
  METAPROJECT_ERROR_CODES, METAPROJECT_PAGE_SIZE_V2, METAPROJECT_RESPONSE_BYTES_V2,
  MetaprojectRequestError, isMetaprojectEdgeKind, isMetaprojectRelativePath, isMetaprojectScope, isMetaprojectTreeScope,
  isMetaprojectV2EdgeKind, isOpenSpecKind, isSha256, type MetaprojectRequest, type MetaprojectRequestV2,
  type MetaprojectResponse, type MetaprojectTreeScope, type MetaprojectTreeV2, type MetaprojectV2Response,
} from "../../../../src/integrations/metaproject-explorer-contract";
import { errMessage } from "../lib/format";
import { invoke, isTauri } from "./backend";

type RecordValue = Record<string, unknown>;
const object = (value: unknown): value is RecordValue => value !== null && typeof value === "object" && !Array.isArray(value);
const optionalString = (value: unknown) => value === undefined || typeof value === "string";
const nonnegativeInteger = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

function validNode(value: unknown): boolean {
  return object(value) && typeof value.id === "string" && typeof value.title === "string" && typeof value.path === "string"
    && typeof value.kind === "string" && ["wiki", "module", "file", "symbol"].includes(value.kind)
    && optionalString(value.module) && optionalString(value.pageType) && optionalString(value.status)
    && (value.line === undefined || nonnegativeInteger(value.line));
}

function validEdge(value: unknown): boolean {
  return object(value) && typeof value.from === "string" && typeof value.to === "string"
    && isMetaprojectEdgeKind(value.kind)
    && (value.evidence === undefined || (Array.isArray(value.evidence) && value.evidence.length <= 400 && value.evidence.every((item: unknown) => typeof item === "string")))
    && (value.count === undefined || nonnegativeInteger(value.count));
}

function validProjection(value: RecordValue, nodeLimit: number, edgeLimit: number): boolean {
  return Array.isArray(value.nodes) && value.nodes.length <= nodeLimit && value.nodes.every(validNode)
    && Array.isArray(value.edges) && value.edges.length <= edgeLimit && value.edges.every(validEdge)
    && typeof value.truncated === "boolean";
}

export function isMetaprojectResponse(value: unknown, action: MetaprojectRequest["action"]): value is MetaprojectResponse {
  if (!object(value) || value.schemaVersion !== 1 || typeof value.snapshotId !== "string") return false;
  switch (action) {
    case "catalog":
      return validProjection(value, 12_000, 40_000) && typeof value.graph === "string"
        && ["ready", "stale", "missing", "unknown"].includes(value.graph) && optionalString(value.graphReason)
        && typeof value.hasWikiLayer === "boolean" && typeof value.hasSymbolLayer === "boolean"
        && object(value.counts) && nonnegativeInteger(value.counts.files) && nonnegativeInteger(value.counts.wiki)
        && nonnegativeInteger(value.counts.modules);
    case "detail":
      return validNode(value.node) && optionalString(value.markdown);
    case "search":
      return Array.isArray(value.hits) && value.hits.length <= 200 && value.hits.every((hit: unknown) =>
        object(hit) && validNode(hit.node) && optionalString(hit.snippet) && optionalString(hit.section));
    case "neighbors":
      return typeof value.root === "string" && validProjection(value, 200, 400);
  }
}

export async function requestMetaproject<T extends MetaprojectResponse = MetaprojectResponse>(cwd: string, request: MetaprojectRequest): Promise<T> {
  let response: unknown;
  try {
    response = await invoke("metaproject_request", { cwd, request });
  } catch (error) {
    if (/unknown (command|subcommand).*metaproject|did not return a valid Review response/i.test(errMessage(error))) {
      throw new Error("This CLI does not support Metaproject Explorer. Choose the bundled CLI in Desktop Settings.");
    }
    throw error;
  }
  if (!isMetaprojectResponse(response, request.action)) {
    throw new Error("Incompatible Metaproject response. Choose the bundled CLI in Desktop Settings.");
  }
  return response as T;
}

const list = (value: unknown, limit: number, valid: (item: unknown) => boolean): boolean =>
  Array.isArray(value) && value.length <= limit && value.every(valid);
const positiveInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;
const entryKind = (value: unknown) => isOpenSpecKind(value);

function validV2Node(value: unknown): boolean {
  if (!object(value) || (!isMetaprojectRelativePath(value.path) && !(value.kind === "module" && value.path === "."))) return false;
  return validNode(value) || (entryKind(value.kind) && typeof value.id === "string" && typeof value.title === "string");
}

function validEvidence(value: unknown): boolean {
  return object(value) && isMetaprojectRelativePath(value.path) && isSha256(value.digest)
    && (value.index === undefined || nonnegativeInteger(value.index));
}

function validV2Edge(value: unknown): boolean {
  if (!object(value) || !isMetaprojectV2EdgeKind(value.kind)) return false;
  if (value.kind !== "changes-spec" && value.kind !== "spec-context") return validEdge(value);
  return typeof value.from === "string" && typeof value.to === "string"
    && list(value.provenance, 3, (evidence) => validEvidence(evidence)
      && object(evidence) && (value.kind === "spec-context" ? nonnegativeInteger(evidence.index) : evidence.index === undefined))
    && Array.isArray(value.provenance) && value.provenance.length > 0;
}

function validV2Projection(value: RecordValue): boolean {
  return list(value.nodes, 200, validV2Node) && list(value.edges, 400, validV2Edge)
    && typeof value.truncated === "boolean";
}

function validDiagnostic(value: unknown): boolean {
  return object(value) && typeof value.code === "string" && typeof value.message === "string"
    && (value.path === undefined || isMetaprojectRelativePath(value.path))
    && (value.index === undefined || nonnegativeInteger(value.index))
    && (value.retryable === undefined || typeof value.retryable === "boolean")
    && (value.line === undefined || positiveInteger(value.line))
    && (value.endLine === undefined || positiveInteger(value.endLine));
}

function validSource(value: unknown): boolean {
  return object(value) && isMetaprojectRelativePath(value.path) && isSha256(value.digest)
    && ((value.startLine === undefined && value.endLine === undefined)
      || (positiveInteger(value.startLine) && positiveInteger(value.endLine) && value.startLine <= value.endLine));
}

function validEntry(value: unknown): boolean {
  return object(value) && entryKind(value.kind) && typeof value.id === "string" && typeof value.title === "string"
    && isMetaprojectRelativePath(value.path) && optionalString(value.archiveDate);
}

function validOpenSpecState(value: unknown): boolean {
  return object(value) && typeof value.availability === "string"
    && ["missing", "empty", "ready", "partial", "unavailable"].includes(value.availability)
    && typeof value.truncated === "boolean" && list(value.diagnostics, 65, validDiagnostic)
    && object(value.counts) && nonnegativeInteger(value.counts.spec) && nonnegativeInteger(value.counts.change)
    && nonnegativeInteger(value.counts.archive);
}

function validSection(value: unknown): boolean {
  return object(value) && typeof value.title === "string" && typeof value.section === "string" && validSource(value.source);
}

function validRequirement(value: unknown): boolean {
  return object(value) && validSection(value) && list(value.scenarios, 10_000, validSection)
    && (value.operation === undefined || (typeof value.operation === "string" && ["added", "modified", "removed", "renamed"].includes(value.operation)))
    && optionalString(value.renamedTo)
    && (value.baseline === undefined || (object(value.baseline) && typeof value.baseline.state === "string"
      && ["matched", "absent", "unresolved"].includes(value.baseline.state)
      && (value.baseline.source === undefined || validSource(value.baseline.source))));
}

function validOpenSpecDetail(value: unknown): boolean {
  return object(value) && isSha256(value.snapshotId) && validEntry(value.entry)
    && list(value.artifacts, 10_000, validSource) && list(value.diagnostics, 10_000, validDiagnostic)
    && list(value.relatedSpecs, 10_000, (item) => object(item) && typeof item.changeId === "string"
      && isMetaprojectRelativePath(item.specPath) && validSource(item.source))
    && list(value.deltas, 10_000, (item) => object(item)
      && isMetaprojectRelativePath(item.specPath) && validSource(item.source)
      && list(item.requirements, 10_000, validRequirement))
    && typeof value.partial === "boolean"
    && (value.artifact === undefined || (object(value.artifact) && validSource(value.artifact.source)
      && typeof value.artifact.markdown === "string" && optionalString(value.artifact.section)
      && list(value.artifact.requirements, 10_000, validRequirement)));
}

function validV2Hit(value: unknown): boolean {
  if (!object(value) || !object(value.node) || !validV2Node(value.node) || !isMetaprojectScope(value.scope)
    || !optionalString(value.snippet) || !optionalString(value.section)) return false;
  if (value.scope === "graph") return value.node.kind === "module" || value.node.kind === "file" || value.node.kind === "symbol";
  if (value.scope === "wiki") return value.node.kind === "wiki";
  const matches = value.matchType === "title" || value.matchType === "path" || value.matchType === "heading" || value.matchType === "body";
  return value.node.kind === value.scope && matches
    && (value.source === undefined
      ? value.section === undefined && (value.matchType === "title" || value.matchType === "path")
      : validSource(value.source));
}

/**
 * The actions Desktop sends to every protocol-2 CLI; a CLI must offer all of them. Optional actions
 * (`tree`) are used only when the answering CLI lists them, so an older CLI still negotiates.
 */
export const METAPROJECT_REQUIRED_ACTIONS = [
  "catalog", "detail", "search", "neighbors", "openspec-list", "openspec-history",
] as const;

/** A CLI may list more actions than this Desktop uses; it has to cover every action Desktop always sends. */
function validCapabilities(value: RecordValue): boolean {
  const { actions } = value;
  return Object.keys(value).length === 2 && value.schemaVersion === 2
    && Array.isArray(actions) && actions.every((action: unknown) => typeof action === "string")
    && METAPROJECT_REQUIRED_ACTIONS.every((action) => actions.includes(action));
}

/** Graph pages hold folders and file nodes; wiki roots hold page-type groups, a group holds wiki nodes. */
function validTreeEntry(value: unknown, scope: MetaprojectTreeScope, parent: string | null): boolean {
  if (!object(value)) return false;
  switch (value.type) {
    case "folder":
      return scope === "graph" && isMetaprojectRelativePath(value.path) && typeof value.name === "string"
        && value.name.length > 0 && positiveInteger(value.files)
        && (value.module === undefined || (validV2Node(value.module) && object(value.module)
          && value.module.kind === "module" && value.module.path === value.path));
    case "group":
      return scope === "wiki" && parent === null && typeof value.key === "string" && value.key.length > 0
        && typeof value.name === "string" && positiveInteger(value.pages);
    case "node":
      return validV2Node(value.node) && object(value.node) && value.node.kind === (scope === "graph" ? "file" : "wiki");
    default:
      return false;
  }
}

function validTree(value: RecordValue): boolean {
  const { scope, parent } = value;
  const parentKey = typeof parent === "string" && parent.length > 0 ? parent : parent === null ? null : undefined;
  return isMetaprojectTreeScope(scope) && parentKey !== undefined
    && typeof value.partial === "boolean" && optionalString(value.nextCursor)
    && list(value.entries, METAPROJECT_PAGE_SIZE_V2, (entry) => validTreeEntry(entry, scope, parentKey));
}

export function isMetaprojectV2Response(value: unknown, action: MetaprojectRequestV2["action"]): value is MetaprojectV2Response {
  if (!object(value) || value.schemaVersion !== 2) return false;
  if (action === "capabilities") return validCapabilities(value);
  if (!isSha256(value.snapshotId)) return false;
  switch (action) {
    case "catalog":
      return validV2Projection(value) && typeof value.graph === "string" && ["ready", "stale", "missing", "unknown"].includes(value.graph)
        && optionalString(value.graphReason) && typeof value.hasWikiLayer === "boolean" && typeof value.hasSymbolLayer === "boolean"
        && object(value.counts) && nonnegativeInteger(value.counts.files) && nonnegativeInteger(value.counts.wiki)
        && nonnegativeInteger(value.counts.modules) && validOpenSpecState(value.openSpec);
    case "neighbors":
      return typeof value.root === "string" && validV2Projection(value) && validOpenSpecState(value.openSpec);
    case "detail":
      return validV2Node(value.node) && optionalString(value.markdown)
        && (value.openSpec === undefined || (validOpenSpecDetail(value.openSpec) && object(value.openSpec)
          && value.openSpec.snapshotId === value.snapshotId && object(value.openSpec.entry) && object(value.node)
          && value.openSpec.entry.id === value.node.id))
        && (value.relationships === undefined || list(value.relationships, 40, (row) =>
          object(row) && validV2Node(row.node) && validV2Edge(row.edge)));
    case "search":
      return typeof value.partial === "boolean" && optionalString(value.nextCursor)
        && list(value.hits, METAPROJECT_PAGE_SIZE_V2, validV2Hit);
    case "openspec-list":
      return entryKind(value.collection) && validOpenSpecState(value.openSpec) && typeof value.partial === "boolean"
        && optionalString(value.nextCursor) && list(value.entries, METAPROJECT_PAGE_SIZE_V2,
          (entry) => object(entry) && validEntry(entry) && entry.kind === value.collection);
    case "openspec-history":
      return typeof value.id === "string" && typeof value.partial === "boolean" && optionalString(value.nextCursor)
        && list(value.entries, METAPROJECT_PAGE_SIZE_V2, (row) => object(row) && object(row.entry)
          && row.entry.kind === "archive" && validEntry(row.entry) && validSource(row.source)
          && list(row.requirements, 10_000, validRequirement));
    case "tree":
      return validTree(value);
  }
}

type InvokeExplorer = (request: MetaprojectRequest | MetaprojectRequestV2) => Promise<unknown>;
const invokeFor = (cwd: string): InvokeExplorer => (request) => invoke("metaproject_request", { cwd, request });

/** What the capability probe settled: the protocol, and the optional actions the answering CLI offers. */
export interface MetaprojectNegotiation {
  protocol: 1 | 2;
  /** The CLI lists `tree`; without it the explorer shows the flat list. */
  supportsTree: boolean;
}

/** A legacy handshake can occur only after this fixed probe. */
export async function negotiateMetaprojectExplorer(cwd: string, call: InvokeExplorer = invokeFor(cwd)): Promise<MetaprojectNegotiation> {
  let response: unknown;
  try {
    response = await call({ version: 2, action: "capabilities" });
  } catch (error) {
    const reason = errMessage(error);
    if (reason !== "Invalid request" && !/^unsupported-version: .+$/.test(reason)) throw error;
    const legacy = await call({ action: "catalog" });
    if (!isMetaprojectResponse(legacy, "catalog")) throw new Error("The selected CLI returned an incompatible legacy Metaproject catalog.");
    return { protocol: 1, supportsTree: false };
  }
  if (isMetaprojectV2Response(response, "capabilities") && "actions" in response) {
    return { protocol: 2, supportsTree: response.actions.includes("tree") };
  }
  // Tauri validates and caches the handshake against the authorized checkout and actual executable.
  if (isTauri() && object(response) && Object.keys(response).length === 2 && response.schemaVersion === 1
    && response.legacyHandshake === true) return { protocol: 1, supportsTree: false };
  throw new Error("The selected CLI returned invalid Metaproject capabilities.");
}

export type MetaprojectTreeRequest = Omit<Extract<MetaprojectRequestV2, { action: "tree" }>, "version" | "action">;

/** One page of one tree parent; call only when the negotiation reported `supportsTree`. */
export function requestMetaprojectTree(
  cwd: string, request: MetaprojectTreeRequest, call: InvokeExplorer = invokeFor(cwd),
): Promise<MetaprojectTreeV2> {
  return requestMetaprojectV2<MetaprojectTreeV2>(cwd, { ...request, version: 2, action: "tree" }, call);
}

export async function requestMetaprojectV2<T extends MetaprojectV2Response = MetaprojectV2Response>(
  cwd: string, request: MetaprojectRequestV2, call: InvokeExplorer = invokeFor(cwd),
): Promise<T> {
  let response: unknown;
  try {
    response = await call(request);
  } catch (error) {
    const reason = errMessage(error);
    const code = METAPROJECT_ERROR_CODES.find((candidate) => reason.startsWith(`${candidate}: `));
    if (code) throw new MetaprojectRequestError(code, reason.slice(code.length + 2));
    throw error;
  }
  if (!isMetaprojectV2Response(response, request.action)
    || !matchesRequest(response, request)
    || new TextEncoder().encode(JSON.stringify(response)).length > METAPROJECT_RESPONSE_BYTES_V2) {
    throw new Error("Incompatible Metaproject v2 response. Choose the bundled CLI in Desktop Settings.");
  }
  // A well-formed answer for another snapshot than the one pinned is the CLI having moved on.
  if ("expectedSnapshotId" in request && request.expectedSnapshotId !== undefined
    && (!("snapshotId" in response) || response.snapshotId !== request.expectedSnapshotId)) {
    throw new MetaprojectRequestError("stale-snapshot", "Project knowledge changed while loading.");
  }
  return response as T;
}

function matchesRequest(response: MetaprojectV2Response, request: MetaprojectRequestV2): boolean {
  switch (request.action) {
    case "detail": return "node" in response && response.node.id === request.id;
    case "neighbors": return "root" in response && response.root === request.id;
    case "openspec-list": return "collection" in response && response.collection === request.collection;
    case "openspec-history": return "id" in response && response.id === request.id;
    case "tree": return "scope" in response && "entries" in response
      && response.scope === request.scope && response.parent === (request.parent ?? null);
    case "search": return "hits" in response && response.hits.every((hit) => !request.scopes || request.scopes.includes(hit.scope));
    default: return true;
  }
}
