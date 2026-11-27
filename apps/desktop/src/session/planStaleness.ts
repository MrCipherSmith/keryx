import type { PlanEntry } from "../acp/types";

/** How long a plan may go unchanged while the agent works before the card says so. */
export const PLAN_STALE_AFTER_MS = 3 * 60_000;

/**
 * Whole minutes the plan has gone unchanged while the agent keeps working, or null while that is not worth saying:
 * the agent is idle, the plan has no open step, or it changed within `PLAN_STALE_AFTER_MS`. The card shows the plan
 * the agent last wrote, and a plan the agent stopped moving would otherwise look like live progress.
 */
export function planStaleMinutes(plan: readonly PlanEntry[], updatedAt: number | null, busy: boolean, now: number): number | null {
  if (!busy || updatedAt === null || !plan.some(entry => entry.status === "pending" || entry.status === "in_progress")) return null;
  const quiet = now - updatedAt;
  return quiet >= PLAN_STALE_AFTER_MS ? Math.floor(quiet / 60_000) : null;
}
