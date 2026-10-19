// The operator's confirmation of a review plan (flow 457, AC6): `<package>/plan-confirmation.json`.
//
// `keryx review estimate` says how many dispatches and minutes a round needs. A plan over the threshold does not
// start until the operator has seen those numbers and said yes, through the `review_confirm_plan` card in keryx
// shell or at a terminal. The record binds to the plan it confirmed (`planKey`), so a re-cut plan asks again.
// One implementation: the plan key, the threshold and the stored record are estimate.ts's, so a confirmation the
// card or the terminal writes is exactly what dispatch-check and the ledger accept.

import path from "node:path";
import { writeFileAtomic } from "../lib/fs";
import {
  DEFAULT_MAX_DISPATCHES,
  DEFAULT_MAX_MINUTES,
  PLAN_CONFIRMATION_FILE,
  estimatePackage,
  planConfirmed as estimatePlanConfirmed,
  planKeyOf as estimatePlanKeyOf,
  readPlanConfirmation as estimateReadPlanConfirmation,
  type RoundEstimate,
} from "./estimate";
import type { OperatorDecisionVia } from "./operator-decisions";
import { cardPressFields, type CardPress } from "./types";

export { PLAN_CONFIRMATION_FILE };

export type PlanConfirmation = {
  planKey: string;
  dispatches: number;
  minutes: [number, number];
  quote: string;
  confirmedVia: OperatorDecisionVia;
  at: string;
} & CardPress;

/** The default threshold, as estimate.ts holds it (routing.config.json may change it per project). */
export const DEFAULT_PLAN_THRESHOLD = { dispatches: DEFAULT_MAX_DISPATCHES, minutes: DEFAULT_MAX_MINUTES } as const;

/** What the plan confirmation needs from an estimate: the numbers the operator sees and what they bind to. */
export type PlanNumbers = Pick<RoundEstimate, "dispatches" | "minutes" | "perRole" | "slicePlan" | "overThreshold">;

/** Whether `estimate` needs the operator's confirmation: the estimate's own verdict. */
export function planOverThreshold(estimate: PlanNumbers): boolean {
  return estimate.overThreshold;
}

export function planKeyOf(estimate: PlanNumbers): string {
  return estimatePlanKeyOf(estimate);
}

/** The package's plan estimate, the library call `keryx review estimate --json` prints. */
export function estimatePlan(packageDir: string): Promise<RoundEstimate> {
  return estimatePackage(packageDir);
}

export async function readPlanConfirmation(packageDir: string): Promise<PlanConfirmation | undefined> {
  return estimateReadPlanConfirmation(packageDir) as PlanConfirmation | undefined;
}

/** Whether the operator confirmed exactly this plan. */
export async function planConfirmed(packageDir: string, estimate: PlanNumbers): Promise<boolean> {
  return estimatePlanConfirmed(packageDir, estimate);
}

export async function recordPlanConfirmation(
  packageDir: string,
  estimate: PlanNumbers,
  confirmation: { quote: string; confirmedVia: OperatorDecisionVia; at: string } & CardPress,
): Promise<PlanConfirmation> {
  if (confirmation.quote.trim() === "") throw new Error("a plan confirmation needs the operator's own words");
  const record: PlanConfirmation = {
    planKey: planKeyOf(estimate),
    dispatches: estimate.dispatches,
    minutes: [estimate.minutes.min, estimate.minutes.max],
    quote: confirmation.quote.trim(),
    confirmedVia: confirmation.confirmedVia,
    ...cardPressFields(confirmation),
    at: confirmation.at,
  };
  await writeFileAtomic(path.join(packageDir, PLAN_CONFIRMATION_FILE), `${JSON.stringify(record, null, 2)}\n`);
  return record;
}
