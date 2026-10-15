// The operator's confirmation of a review plan (flow 457, AC6): `<package>/plan-confirmation.json`.
//
// `keryx review estimate` says how many dispatches and minutes a round needs. A plan over the threshold does not
// start until the operator has seen those numbers and said yes, through the `review_confirm_plan` card in keryx
// shell or at a terminal. The record binds to the plan it confirmed (`planKey`), so a re-cut plan asks again.
// dispatch-check and the ledger read `planConfirmed`.

import { createHash } from "node:crypto";
import path from "node:path";
import { writeFileAtomic } from "../lib/fs";
import { readJsonFileOr } from "../lib/json";
import { estimatePackage, type RoundEstimate } from "./estimate";
import type { OperatorDecisionVia } from "./operator-decisions";

export const PLAN_CONFIRMATION_FILE = "plan-confirmation.json";

export type PlanConfirmation = {
  planKey: string;
  dispatches: number;
  minutes: [number, number];
  quote: string;
  confirmedVia: OperatorDecisionVia;
  at: string;
};

/** A plan needs the operator's yes past either number (the estimate's own threshold, when it carries one, wins). */
export const DEFAULT_PLAN_THRESHOLD = { dispatches: 40, minutes: 90 } as const;

/** Whether `estimate` is over the threshold: its own `overThreshold` flag when present, else the default numbers. */
export function planOverThreshold(estimate: PlanNumbers & { overThreshold?: unknown }): boolean {
  if (typeof estimate.overThreshold === "boolean") return estimate.overThreshold;
  return estimate.dispatches > DEFAULT_PLAN_THRESHOLD.dispatches || estimate.minutes.max > DEFAULT_PLAN_THRESHOLD.minutes;
}

/** What the plan confirmation needs from an estimate: the numbers the operator sees and what they bind to. */
export type PlanNumbers = Pick<RoundEstimate, "dispatches" | "minutes" | "perRole" | "waveBytes" | "manifest" | "depth">;

/** A stable key for a plan: the same roles, slices per role, waves and wave budget give the same key. */
export function planKeyOf(estimate: PlanNumbers): string {
  const shape = {
    depth: estimate.depth,
    manifest: estimate.manifest ?? null,
    waveBytes: estimate.waveBytes ?? null,
    roles: estimate.perRole.map((role) => [role.role, role.slices, role.waves]),
    dispatches: estimate.dispatches,
  };
  return createHash("sha256").update(JSON.stringify(shape)).digest("hex").slice(0, 16);
}

/** The package's plan estimate, the library call `keryx review estimate --json` prints. */
export function estimatePlan(packageDir: string): Promise<RoundEstimate> {
  return estimatePackage(packageDir);
}

export async function readPlanConfirmation(packageDir: string): Promise<PlanConfirmation | undefined> {
  const value = await readJsonFileOr<unknown>(path.join(packageDir, PLAN_CONFIRMATION_FILE), undefined);
  if (value === null || typeof value !== "object") return undefined;
  const v = value as Record<string, unknown>;
  const minutes = v.minutes;
  if (typeof v.planKey !== "string" || typeof v.dispatches !== "number" || !Array.isArray(minutes) || minutes.length !== 2) return undefined;
  if (typeof v.quote !== "string" || typeof v.at !== "string") return undefined;
  if (v.confirmedVia !== "tui-card" && v.confirmedVia !== "remote-card" && v.confirmedVia !== "terminal") return undefined;
  return { planKey: v.planKey, dispatches: v.dispatches, minutes: [Number(minutes[0]), Number(minutes[1])], quote: v.quote, confirmedVia: v.confirmedVia, at: v.at };
}

/** Whether the operator confirmed exactly this plan. */
export async function planConfirmed(packageDir: string, estimate: PlanNumbers): Promise<boolean> {
  return (await readPlanConfirmation(packageDir))?.planKey === planKeyOf(estimate);
}

export async function recordPlanConfirmation(
  packageDir: string,
  estimate: PlanNumbers,
  confirmation: { quote: string; confirmedVia: OperatorDecisionVia; at: string },
): Promise<PlanConfirmation> {
  if (confirmation.quote.trim() === "") throw new Error("a plan confirmation needs the operator's own words");
  const record: PlanConfirmation = {
    planKey: planKeyOf(estimate),
    dispatches: estimate.dispatches,
    minutes: [estimate.minutes.min, estimate.minutes.max],
    quote: confirmation.quote.trim(),
    confirmedVia: confirmation.confirmedVia,
    at: confirmation.at,
  };
  await writeFileAtomic(path.join(packageDir, PLAN_CONFIRMATION_FILE), `${JSON.stringify(record, null, 2)}\n`);
  return record;
}
