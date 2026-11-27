import type { PlanEntry } from "../acp/types";

/** How long a plan may go unchanged while the agent works before the card says so. */
export const PLAN_STALE_AFTER_MS = 3 * 60_000;

/**
 * An entry's status as keryx wrote it. The ACP status folds proposed/blocked into pending and skipped into
 * completed; keryx keeps the real one in `_meta.keryx.status`. An entry without it (an older keryx) has only the ACP one.
 */
export function keryxPlanStatus(entry: PlanEntry): string {
  return entry._meta?.keryx?.status ?? entry.status;
}

/**
 * Work the agent still owes: the same rule as the harness's `hasActionableExecutionPlanItems`. A `proposed` step awaits
 * the operator's approval and a `blocked` one cannot move, so neither makes an unchanged plan stale.
 */
function hasOpenStep(plan: readonly PlanEntry[]): boolean {
  return plan.some(entry => {
    const status = keryxPlanStatus(entry);
    return status === "pending" || status === "in_progress";
  });
}

/**
 * Whole minutes the plan has gone unchanged while the agent keeps working, or null while that is not worth saying:
 * the agent is idle, the plan has no open step, or it changed within `PLAN_STALE_AFTER_MS`. The quiet time starts at
 * the later of the plan's last change and the current turn's start, so time spent between turns never counts, as the
 * harness starts its own count afresh on each turn. The card shows the plan the agent last wrote, and a plan the agent
 * stopped moving would otherwise look like live progress.
 */
export function planStaleMinutes(plan: readonly PlanEntry[], clock: {
  updatedAt: number | null; turnStartedAt: number | null; busy: boolean; now: number;
}): number | null {
  const { updatedAt, turnStartedAt, busy, now } = clock;
  if (!busy || updatedAt === null || !hasOpenStep(plan)) return null;
  const quiet = now - Math.max(updatedAt, turnStartedAt ?? updatedAt);
  return quiet >= PLAN_STALE_AFTER_MS ? Math.floor(quiet / 60_000) : null;
}
