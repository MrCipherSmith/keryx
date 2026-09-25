// Numeric confidence model (W3 spec, "Numeric confidence model"). All
// constants are literal and checked into this file — never a runtime
// parameter an agent can tune (spec: "any change to them is itself a
// documented decision").
import type { ConfidenceLevel, EvidenceKind } from "./types";

/** Seed confidence for a deterministic extractor's first candidate. */
export const SEED_DETERMINISTIC = 0.4;
/** Seed confidence for the (capability-gated) model-backed extractor — lower, since it is not grounded in a directly matched signal. */
export const SEED_MODEL_BACKED = 0.3;
export const REINFORCE_RATE = 0.35;
export const CONTRADICT_RATE = 0.5;
export const DECAY_RATE = 0.02;
/** Ceiling for a single evidence item's `weight` — the strongest deterministic signal (failing-to-passing test pair). */
export const MAX_EVIDENCE_WEIGHT = 1.5;

export const LEVEL_MEDIUM_MIN = 0.5;
export const LEVEL_HIGH_MIN = 0.8;

const ROUND_DECIMALS = 10;
const ROUND_FACTOR = 10 ** ROUND_DECIMALS;

/** Round to 10 decimal places to keep the documented constants exact (e.g. 0.4 -> 0.61) despite float noise. */
function round(value: number): number {
  return Math.round(value * ROUND_FACTOR) / ROUND_FACTOR;
}

function clamp01(value: number): number {
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

/**
 * Apply one evidence item to `confidence` per the documented formula:
 *
 *   confidence' = clamp(
 *     confidence + (kind == "reinforcement"
 *       ? (1 - confidence) * REINFORCE_RATE * weight
 *       : -confidence * CONTRADICT_RATE * weight),
 *     0, 1
 *   )
 *
 * `weight` defaults to 1.0 and is clamped to [0, MAX_EVIDENCE_WEIGHT] before
 * use, matching the schema's own bound on `evidence[].weight`.
 */
export function applyEvidence(confidence: number, kind: EvidenceKind, weight = 1): number {
  const clampedWeight = Math.min(Math.max(weight, 0), MAX_EVIDENCE_WEIGHT);
  const delta =
    kind === "reinforcement"
      ? (1 - confidence) * REINFORCE_RATE * clampedWeight
      : -confidence * CONTRADICT_RATE * clampedWeight;
  return round(clamp01(confidence + delta));
}

/**
 * Time-based decay, run once per UTC day a record has had no new evidence:
 * `confidence' = confidence * (1 - DECAY_RATE) ^ days_since_last_evidence`.
 * `days < 1` leaves `confidence` unchanged (decay is counted in whole UTC
 * days). Only meaningful for `status: candidate`/`status: accepted` records —
 * callers are responsible for not calling this on a rejected/superseded one.
 */
export function applyDecay(confidence: number, days: number): number {
  const wholeDays = Math.floor(days);
  if (wholeDays < 1) return confidence;
  return round(clamp01(confidence * Math.pow(1 - DECAY_RATE, wholeDays)));
}

/** Derived confidenceLevel bucket: low < 0.5 <= medium < 0.8 <= high. */
export function confidenceLevelFor(confidence: number): ConfidenceLevel {
  if (confidence >= LEVEL_HIGH_MIN) return "high";
  if (confidence >= LEVEL_MEDIUM_MIN) return "medium";
  return "low";
}
