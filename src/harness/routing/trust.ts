// Flow 305 AC11 — project routing trust.
//
// `routing.config.json` is a COMMITTED, project-scoped file, exactly the
// shape `.keryx/mcp-servers.json` is (`src/mcp-servers/trust.ts`, whose
// design this reuses): `git clone … && cd … && keryx review tier` must not
// let a repository silently steer which model reviews its own diff. A
// project entry therefore takes effect only after the operator has seen its
// CURRENT content and approved it once — recorded as a content fingerprint in
// the operator's own config directory, never in the repository, keyed by
// project root (routing.config.json has no per-server name to key on the way
// MCP's store does; one file, one project, one key). Editing the file after
// approval — any category, class, provider, classifier or execution change —
// changes the fingerprint and
// voids the approval; a pure reformat (whitespace, key order) does not, since
// the fingerprint is computed over the VALIDATED LAYER, not the raw bytes —
// the same "what will actually apply" reasoning `serverFingerprint` documents
// for MCP.
import path from "node:path";
import {
  ensureKeryxConfigDir,
  isDefiniteAbsence,
  readConfigFile,
  type ConfigReadResult,
} from "../../lib/config-dir";
import { updateConfigFile } from "../../lib/config-update";
import { routingDigest, type RoutingAssignment, type RoutingConfigLayer } from "./config";

export function routingTrustFile(configDir?: string): string {
  return path.join(configDir ?? ensureKeryxConfigDir(), "routing-config-trust.json");
}

/** `{ approvals: { "<project root>": "<fingerprint>" } }` */
export type RoutingTrustStore = { approvals?: Record<string, string> };

/**
 * What the operator is actually approving: the validated routing layer, not
 * the raw file bytes, so whitespace and key order never force re-approval but
 * any change to categories, classes, providers, classifier or execution does.
 */
export function routingLayerFingerprint(layer: RoutingConfigLayer): string {
  return routingDigest(layer);
}

/** A layer that sets nothing beyond its schema version gives an operator nothing to approve. */
export function isEmptyRoutingLayer(layer: RoutingConfigLayer | undefined): boolean {
  return layer === undefined || Object.keys(layer).every((key) => key === "schemaVersion");
}

/** The key an approval is filed under: the project root, normalized. */
export function routingTrustKey(cwd: string): string {
  return path.resolve(cwd);
}

export function loadRoutingTrustStore(configDir?: string): Record<string, string> {
  return parseRoutingTrustStore(readConfigFile(routingTrustFile(configDir)));
}

function parseRoutingTrustStore(read: ConfigReadResult): Record<string, string> {
  if (!read.ok) return {};
  try {
    const parsed = JSON.parse(read.text) as RoutingTrustStore;
    const approvals = parsed.approvals;
    if (approvals === undefined) return {};
    const clean: Record<string, string> = {};
    for (const [key, value] of Object.entries(approvals)) {
      if (typeof value === "string") clean[key] = value;
    }
    return clean;
  } catch {
    // A trust store that cannot be read grants nothing (fail closed) — same
    // rule `loadTrustStore` (MCP) already applies.
    return {};
  }
}

/**
 * Is `layer` (the project layer's CURRENT content) approved for `cwd`? An empty
 * layer needs no approval — there is nothing for an operator to have seen.
 */
export function isProjectRoutingApproved(cwd: string, layer: RoutingConfigLayer | undefined, configDir?: string): boolean {
  if (isEmptyRoutingLayer(layer)) return true;
  const approvals = loadRoutingTrustStore(configDir);
  return approvals[routingTrustKey(cwd)] === routingLayerFingerprint(layer!);
}

export type RoutingTrustResult =
  | { readonly ok: true; readonly file: string }
  | { readonly ok: false; readonly error: string };

/**
 * Apply one approval change to the store as it is at write time, under the
 * store lock (`updateConfigFile`): several keryx processes approve and revoke
 * other projects in this same file, and a write built from an earlier read
 * dropped their entries or brought a revoked approval back.
 */
function updateRoutingTrust(
  file: string,
  change: (approvals: Record<string, string>) => void,
): RoutingTrustResult {
  let unreadable: string | undefined;
  const outcome = updateConfigFile(file, (read) => {
    unreadable = !read.ok && !isDefiniteAbsence(read.reason) ? read.reason : undefined;
    if (unreadable !== undefined) return undefined;
    const approvals = parseRoutingTrustStore(read);
    change(approvals);
    return `${JSON.stringify({ approvals }, null, 2)}\n`;
  });
  if (unreadable !== undefined) {
    return { ok: false, error: `${file} could not be read (${unreadable}); nothing was written` };
  }
  if (outcome === "failed") {
    return { ok: false, error: `${file} kept changing under concurrent keryx writers; nothing was written — try again` };
  }
  return { ok: true, file };
}

/** Record approval for exactly this layer as it validates today. */
export function approveProjectRouting(cwd: string, layer: RoutingConfigLayer, configDir?: string): RoutingTrustResult {
  const key = routingTrustKey(cwd);
  const fingerprint = routingLayerFingerprint(layer);
  return updateRoutingTrust(routingTrustFile(configDir), (approvals) => {
    approvals[key] = fingerprint;
  });
}

/** Withdraw approval. An unapproved project layer is ignored again. */
export function revokeProjectRouting(cwd: string, configDir?: string): RoutingTrustResult {
  const key = routingTrustKey(cwd);
  return updateRoutingTrust(routingTrustFile(configDir), (approvals) => {
    delete approvals[key];
  });
}

/** What `keryx routing trust` and `/routing`'s approve action show BEFORE recording anything. */
export function describeLayerForApproval(layer: RoutingConfigLayer): string[] {
  const lines = Object.entries(layer.categories ?? {})
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([category, assignment]) => `${category}: ${describeRoutingAssignment(assignment)}`);
  for (const key of ["classes", "providers", "classifier", "execution"] as const) {
    if (layer[key] !== undefined) lines.push(`${key}: ${JSON.stringify(layer[key])}`);
  }
  return lines;
}

/** One assignment in operator words. */
export function describeRoutingAssignment(assignment: RoutingAssignment): string {
  switch (assignment.mode) {
    case "auto":
      return "auto (classified per task)";
    case "baseline":
      return assignment.fallbackClass === undefined ? "session model" : `session model (fallback class ${assignment.fallbackClass})`;
    case "class":
      return `class ${assignment.modelClass}`;
    case "model": {
      const target = `${assignment.target.providerId}/${assignment.target.modelId}`;
      return assignment.fallbackClass === undefined ? target : `${target} (fallback class ${assignment.fallbackClass})`;
    }
    default: {
      const exhaustive: never = assignment;
      return exhaustive;
    }
  }
}

/** Standard notice shown wherever a project layer's entries are ignored pending approval. */
export const ROUTING_TRUST_NOTICE =
  "routing.config.json has unapproved routing settings — ignored. Run `keryx routing trust` (or approve it in /routing) to review and apply them.";
