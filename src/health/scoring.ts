import type { FileHotspot, HealthConfig, Priority } from "./types";

export function riskScore(
  byPriority: Record<Priority, number>,
  weights: Record<Priority, number>,
): number {
  return (Object.keys(weights) as Priority[]).reduce(
    (sum, priority) => sum + (byPriority[priority] ?? 0) * weights[priority],
    0,
  );
}

export function coveragePenalty(
  coverage: number | null,
  config: HealthConfig,
): number {
  if (coverage === null) {
    return 0;
  }
  return Math.max(0, config.metrics.coverageTarget - coverage) *
    config.scoring.coverageWeight;
}

export function complexityPenalty(
  functionComplexities: number[],
  config: HealthConfig,
): number {
  // Count of functions above the threshold, weighted. Count-based (not
  // sum-of-excess) so the penalty stays stable across codebase size and is
  // tamed by the per-LOC normalization in healthScore.
  const threshold = config.metrics.complexityThreshold;
  const above = functionComplexities.filter((value) => value > threshold).length;
  return above * config.scoring.complexityWeight;
}

// D1: additive hotspot penalty (specification.md §8.1). Count of files whose
// churn×complexity score exceeds `metrics.hotspotThreshold`, times
// `scoring.hotspotWeight`. Count-based (like `complexityPenalty`) so it is
// tamed by the same per-LOC normalization in `healthScore`. When
// `hotspotWeight === 0` (the default) the result is EXACTLY 0 — the term is
// multiplied by the weight before it is added, so the score stays byte-
// identical to pre-D1 (`C0-7`).
export function hotspotPenalty(
  fileHotspots: FileHotspot[],
  config: HealthConfig,
): number {
  const weight = config.scoring.hotspotWeight;
  if (weight === 0) {
    return 0;
  }
  const threshold = config.metrics.hotspotThreshold;
  const hot = fileHotspots.filter((entry) => entry.score > threshold).length;
  return hot * weight;
}

export function healthScore(
  penalties: {
    risk: number;
    coverage: number;
    complexity: number;
    loc: number;
    hotspot?: number;
  },
  config: HealthConfig,
): number {
  const total =
    penalties.risk +
    penalties.coverage +
    penalties.complexity +
    (penalties.hotspot ?? 0);
  const normalized =
    (total * config.scoring.normalizePerLoc) /
    Math.max(penalties.loc, config.scoring.normalizePerLoc);
  return clamp(Math.round(100 - normalized), 0, 100);
}

export function trendOf(
  current: number,
  baseline: number | null,
): "improved" | "stable" | "regressed" | "unknown" {
  if (baseline === null) {
    return "unknown";
  }
  const delta = current - baseline;
  if (delta > 2) {
    return "improved";
  }
  if (delta < -2) {
    return "regressed";
  }
  return "stable";
}

export function regressionScore(
  current: number,
  baseline: number | null,
): number {
  if (baseline === null) {
    return 0;
  }
  return baseline - current;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
