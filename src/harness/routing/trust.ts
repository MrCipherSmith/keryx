// Flow 305 AC11 — project routing-table trust.
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
// approval — any category/assignment change — changes the fingerprint and
// voids the approval; a pure reformat (whitespace, key order) does not, since
// the fingerprint is computed over the VALIDATED TABLE, not the raw bytes —
// the same "what will actually apply" reasoning `serverFingerprint` documents
// for MCP.
import { createHash } from "node:crypto";
import path from "node:path";
import {
  ensureKeryxConfigDir,
  isDefiniteAbsence,
  readConfigFile,
  writeOwnerOnlyFileAtomic,
} from "../../lib/config-dir";
import type { CategoryAssignment, RoutingTable } from "./table";

export function routingTrustFile(configDir?: string): string {
  return path.join(configDir ?? ensureKeryxConfigDir(), "routing-config-trust.json");
}

/** `{ approvals: { "<project root>": "<fingerprint>" } }` */
export type RoutingTrustStore = { approvals?: Record<string, string> };

/** Key-order-independent: a pure reformat of `routing.config.json` does not void approval. */
function sortedAssignment(assignment: CategoryAssignment): Array<[string, unknown]> {
  return Object.entries(assignment).sort(([a], [b]) => a.localeCompare(b));
}

/**
 * What the operator is actually approving: the validated category table, not
 * the raw file bytes (so whitespace/key-order changes don't force
 * re-approval, but any actual category/assignment change does).
 */
export function routingTableFingerprint(table: RoutingTable): string {
  const categories = Object.keys(table).sort();
  const material = JSON.stringify(categories.map((c) => [c, sortedAssignment(table[c as keyof RoutingTable]!)]));
  return createHash("sha256").update(material).digest("hex");
}

/** The key an approval is filed under: the project root, normalized. */
export function routingTrustKey(cwd: string): string {
  return path.resolve(cwd);
}

export function loadRoutingTrustStore(configDir?: string): Record<string, string> {
  const read = readConfigFile(routingTrustFile(configDir));
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
 * Is `table` (the project layer's CURRENT content) approved for `cwd`? Empty
 * tables need no approval — there is nothing for an operator to have seen.
 */
export function isProjectRoutingApproved(cwd: string, table: RoutingTable, configDir?: string): boolean {
  if (Object.keys(table).length === 0) return true;
  const approvals = loadRoutingTrustStore(configDir);
  return approvals[routingTrustKey(cwd)] === routingTableFingerprint(table);
}

export type RoutingTrustResult =
  | { readonly ok: true; readonly file: string }
  | { readonly ok: false; readonly error: string };

/** Record approval for exactly this table as it validates today. */
export function approveProjectRouting(cwd: string, table: RoutingTable, configDir?: string): RoutingTrustResult {
  const file = routingTrustFile(configDir);
  const read = readConfigFile(file);
  if (!read.ok && !isDefiniteAbsence(read.reason)) {
    return { ok: false, error: `${file} could not be read (${read.reason}); nothing was written` };
  }
  const approvals = loadRoutingTrustStore(configDir);
  approvals[routingTrustKey(cwd)] = routingTableFingerprint(table);
  writeOwnerOnlyFileAtomic(file, `${JSON.stringify({ approvals }, null, 2)}\n`);
  return { ok: true, file };
}

/** Withdraw approval. An unapproved project layer is ignored again. */
export function revokeProjectRouting(cwd: string, configDir?: string): RoutingTrustResult {
  const file = routingTrustFile(configDir);
  const approvals = loadRoutingTrustStore(configDir);
  delete approvals[routingTrustKey(cwd)];
  writeOwnerOnlyFileAtomic(file, `${JSON.stringify({ approvals }, null, 2)}\n`);
  return { ok: true, file };
}

/** One line per category, for `keryx routing trust`/`/routing`'s approve action to show BEFORE recording anything. */
export function describeTableForApproval(table: RoutingTable): string[] {
  return Object.entries(table)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([category, assignment]) => `${category}: ${describeAssignmentForApproval(assignment)}`);
}

function describeAssignmentForApproval(assignment: CategoryAssignment): string {
  switch (assignment.kind) {
    case "session-default":
      return "session default";
    case "model":
      return `${assignment.providerId}/${assignment.modelId}`;
    case "provider-default":
      return `${assignment.providerId} (provider default)`;
    default: {
      const exhaustive: never = assignment;
      return exhaustive;
    }
  }
}

/** Standard notice shown wherever a project layer's entries are ignored pending approval. */
export const ROUTING_TRUST_NOTICE =
  "routing.config.json has unapproved entries — ignored. Run `keryx routing trust` (or approve it in /routing) to review and apply them.";
