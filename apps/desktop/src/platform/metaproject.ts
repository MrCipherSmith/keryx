import type { MetaprojectRequest, MetaprojectResponse } from "../../../../src/integrations/metaproject-explorer-contract";
import { errMessage } from "../lib/format";
import { invoke } from "./backend";

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
    && typeof value.kind === "string" && ["imports", "describes", "links", "contains", "defines", "calls"].includes(value.kind)
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
