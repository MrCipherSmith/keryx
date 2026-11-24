import { MODEL_TIERS, type ModelTier } from "../gdskills/model-tier";
import { ROUTING_TIERS } from "../lib/model-class";
import type { DeskReviewPool } from "./desk-run-options";
import type { SliceEntry } from "./slice";

const MECHANICAL = new Set(["review-style", "review-testing-practices", "review-jev-docs", "review-jev-comments"]);
const CRITICAL = new Set(["review-security-code", "review-premise", "review-regression"]);

export const REVIEW_ASSIGNMENT_TIERS = { light: "light", middle: "standard", strong: "deep" } as const;

export function isReviewAssignmentTier(value: unknown): value is DeskReviewPool {
  return value === "light" || value === "middle" || value === "strong";
}

function toPool(tier: ModelTier): DeskReviewPool {
  return tier === "deep" ? "strong" : tier === "standard" ? "middle" : "light";
}

export function reviewAssignmentTier(input: {
  reviewer: string;
  slices: readonly SliceEntry[];
  declared?: ModelTier | undefined;
  adaptive?: boolean;
  changedLines?: number;
  round?: number;
}) {
  const mechanical = MECHANICAL.has(input.reviewer);
  const floor = input.declared ?? (mechanical ? "light" : "standard");
  let tier: ModelTier = floor;
  let tierReason = input.declared ? "Reviewer skill declares this tier." :
    mechanical ? "Mechanical check within its assigned scope." : "Standard judgment for this reviewer’s scope.";
  const raise = (minimum: ModelTier, reason: string) => {
    if (MODEL_TIERS.indexOf(minimum) <= MODEL_TIERS.indexOf(tier)) return;
    tier = minimum;
    tierReason = reason;
  };
  if (input.adaptive !== false) {
    if (CRITICAL.has(input.reviewer)) raise("deep", "Critical review role requires deeper judgment.");
    if (input.slices.some(slice => slice.escalated)) raise("deep", "Escalated findings require a deeper check.");
    if (!mechanical) {
      if (input.slices.some(slice => (slice.risk?.score ?? 0) >= 0.7)) raise("deep", "Assigned slice has high recorded risk.");
      if ((input.changedLines ?? 0) >= 400 || input.slices.reduce((bytes, slice) => bytes + slice.bytes, 0) >= 60_000) {
        raise("deep", "Broad assigned source changes require deeper analysis.");
      }
    }
    if ((input.round ?? 1) >= 2 && input.slices.some(slice => slice.kind === "fix")) {
      raise("standard", "Repeated fixes require verification against prior findings.");
    }
  } else {
    tierReason = input.declared ? "Fixed routing uses the reviewer skill’s declared tier." : "Fixed routing uses the reviewer role’s default tier.";
  }
  const pool = toPool(tier);
  return { tier: pool, tierReason, modelClass: ROUTING_TIERS[pool] };
}
