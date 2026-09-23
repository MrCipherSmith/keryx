// Flow 291 — per-project aggregation and filtering (AC1, AC2, AC3, AC4, AC7,
// AC9). Read-only: every function here reads already-recorded artifacts
// (`flow.json`, review manifests, the trigger ledger) and writes nothing
// (AC5).

import { flowIdOf, listFlowDirs, readFlow } from "../flow/store";
import { readFlowReviewManifests, readProjectTriggerSpend, summarizeReviewSpend } from "./spend";
import { summarizeConfirmations, summarizeGateOutcomes } from "./accountability";
import type { FlowGovernance, GovernanceFilters, PolicyDecisionsSummary, ProjectGovernance } from "./types";

/** AC9: stated once, everywhere the report surfaces policy decisions. */
export const POLICY_DECISIONS_NOT_RECORDED: PolicyDecisionsSummary = {
  recorded: false,
  reason:
    "no durable log of allow/ask/deny policy decisions or unattended-run denials exists in this build; " +
    "flow 290 (unattended denials) is a future source, not a dependency of this report",
};

/** Every flow in `cwd`'s `.metaproject/flows/`, aggregated, unfiltered. */
export async function collectFlowGovernance(cwd: string): Promise<FlowGovernance[]> {
  const dirs = await listFlowDirs(cwd);
  const flows: FlowGovernance[] = [];
  for (const dir of dirs) {
    const flow = await readFlow(cwd, dir);
    const manifests = await readFlowReviewManifests(cwd, dir);
    flows.push({
      id: flow.id,
      dir,
      slug: flow.slug,
      title: flow.title,
      status: flow.status,
      createdAt: flow.createdAt,
      updatedAt: flow.updatedAt,
      owner: flow.owner,
      spend: summarizeReviewSpend(manifests),
      confirmations: summarizeConfirmations(flow),
      gateOutcomes: summarizeGateOutcomes(flow),
    });
  }
  return flows;
}

/**
 * AC7: `--flow`, `--owner`, `--since`/`--until` — applied to each flow's own
 * timestamp (`updatedAt`, the flow's most recent recorded activity).
 * `--flow` matches the bare id (e.g. `291`); `--owner` matches the owner
 * identity's value exactly, and excludes a flow with no owner set.
 */
export function filterFlows(flows: readonly FlowGovernance[], filters: GovernanceFilters): FlowGovernance[] {
  return flows.filter((flow) => {
    if (filters.flow !== undefined && flow.id !== filters.flow) {
      return false;
    }
    if (filters.owner !== undefined && flow.owner?.value !== filters.owner) {
      return false;
    }
    if (filters.since !== undefined && flow.updatedAt < filters.since) {
      return false;
    }
    if (filters.until !== undefined && flow.updatedAt > filters.until) {
      return false;
    }
    return true;
  });
}

/**
 * One project's governance slice: its flows (filtered), project-wide trigger
 * spend, and the static policy-decisions note. `--since`/`--until` also
 * bound which trigger runs are summed, by the run's own `at` — the same
 * "each record's own timestamp" rule AC7 states.
 */
export async function collectProjectGovernance(
  root: string,
  filters: GovernanceFilters,
  displayName?: string,
): Promise<ProjectGovernance> {
  // A project with no flows yet reads as an empty `flows` array below — a
  // real, reportable state, not a skip. `.metaproject` itself missing (or
  // unreadable) is what `state: "skipped"` on the CALLER side is for — see
  // `collectAllProjectsGovernance` in `report.ts`, which wraps this call in
  // a try/catch per project so one bad registry entry cannot fail the whole
  // report.
  const flows = filterFlows(await collectFlowGovernance(root), filters);
  const triggerSpend = await readProjectTriggerSpend(root);
  return {
    root,
    displayName,
    state: "ok",
    reason: undefined,
    flows,
    triggerSpend,
    policyDecisions: POLICY_DECISIONS_NOT_RECORDED,
  };
}

/** Re-export for callers that only need the bare id from a flow dir name. */
export { flowIdOf };
