// RP-13 FR3+FR4: report-only lifecycle flag (flow 168, Phase 2).
//
// Nothing ties SAC content back to the code it describes once that code is
// gone: `wikiPruneOrphans` (`src/wiki/service.ts`) already removes orphaned
// `wiki/components/*.md` pages via the graph's own module-list diff, but
// workspaces, memory entries, and `wiki/decisions/*` pages have no
// equivalent signal — `keryx workspace archive` is a manual command nothing
// ever calls automatically, so SAC content can outlive the component it was
// created for indefinitely with zero discoverability.
//
// This module extends the SAME graph-diff signal (`validModuleNames`,
// `src/wiki/service.ts`) to a second, READ-ONLY consumer. It performs no
// writes to graph, wiki, memory, or SAC state — it never calls `keryx
// workspace archive`, edits a memory entry, or removes a wiki page. Acting
// on a flag stays a human decision through the existing manual commands
// (FR3/FR4's own non-goal).
import { randomUUID } from "node:crypto";
import { collectEntries } from "../memory/store";
import { moduleNameFromProjectPath, validModuleNames } from "../wiki/service";
import { collectWikiDecisionEntries } from "./decision-dedup";
import { localWorkspaceAuthorizationServer, WorkspaceService } from "./workspace-service";

export type LifecycleFlag = {
  kind: "workspace" | "memory-entry" | "wiki-decision";
  ref: string;
  missingComponent: string;
  flaggedAt: string;
};

function normalize(raw: string): string {
  return raw.replace(/^\.\//, "");
}

/**
 * `true` iff `recorded` (a workspace `component` resource uri, a
 * `MemoryEntry.scopes.module`, or a wiki decision page's `Module:` header —
 * any of which may already BE a module-grouping path, or may be a specific
 * FILE inside one) still resolves to something the graph currently sees.
 * Tries both interpretations rather than assuming one, to avoid a false
 * "missing" flag purely from that ambiguity — this package's own
 * conservative, report-only posture extends to the CHECK itself, not just
 * to what happens after a flag fires.
 */
function isStillPresent(recorded: string, valid: Set<string>): boolean {
  const normalized = normalize(recorded);
  return valid.has(normalized) || valid.has(moduleNameFromProjectPath(normalized));
}

/**
 * Every workspace/memory-entry/wiki-decision whose recorded scope resolves
 * ONLY to a component no longer in the graph. Pure read/report — see this
 * module's own doc comment. `undefined` from `validModuleNames` (graph never
 * built) short-circuits to `[]`: never flag anything when there is no
 * current graph to check against (AC5's own "never a write, never a false
 * flood" posture).
 */
export async function computeLifecycleFlags(cwd: string, now: () => Date = () => new Date()): Promise<LifecycleFlag[]> {
  const valid = await validModuleNames(cwd);
  if (valid === undefined) return [];
  const flaggedAt = now().toISOString();
  const flags: LifecycleFlag[] = [];

  const workspaceService = new WorkspaceService({
    workspaceRoot: cwd,
    authorizationServer: localWorkspaceAuthorizationServer(),
    strictGuard: { mode: "strict", availability: "available", decision: "pass", policyRevision: "local-offline-v1" },
  });
  const workspaces = await workspaceService.list({ request: undefined, requestCorrelationId: randomUUID(), includeArchived: true });
  for (const workspace of workspaces) {
    const component = workspace.resources.find((r) => r.kind === "component")?.uri;
    if (component !== undefined && !isStillPresent(component, valid)) {
      flags.push({ kind: "workspace", ref: workspace.id, missingComponent: normalize(component), flaggedAt });
    }
  }

  for (const entry of await collectEntries(cwd)) {
    const module = entry.scopes.module;
    if (module !== null && module.length > 0 && !isStillPresent(module, valid)) {
      flags.push({ kind: "memory-entry", ref: entry.relativePath, missingComponent: normalize(module), flaggedAt });
    }
  }

  for (const decision of await collectWikiDecisionEntries(cwd)) {
    const module = decision.scopes.module;
    if (module !== null && module.length > 0 && !isStillPresent(module, valid)) {
      flags.push({ kind: "wiki-decision", ref: decision.relativePath, missingComponent: normalize(module), flaggedAt });
    }
  }

  return flags;
}
