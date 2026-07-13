// Metric reliability assessment (flow 009, W7 / S4, task-R0-02).
//
// Backs the "metrics never fabricated" clause of the frozen AC4 and the
// scenarios @SC_R16_EXACT_ESTIMATED_UNKNOWN_METRICS /
// @SC_R16_UNRELIABLE_METRIC_NOT_TREATED_AS_EXACT. A metric may legitimately be
// absent (`value: null`) as long as it does not *claim* to be exact and it
// records where an estimate/unknown came from. Fabrication is:
//   - claiming `reliability: "exact"` with no reported value, or
//   - reporting an `estimated`/`unknown` value with no recorded `source`.
//
// This is a PURE helper. It is deliberately NOT wired into
// `evaluateCompletion`'s pass/fail decision (AC4 treats reliability as a
// separate clause); the completion gate may choose to surface a violation as an
// extra, non-required check. Deterministic: no `Date.now`, `Math.random`,
// network, or filesystem access — output depends only on the input.

/** A single reported metric with its self-declared reliability. */
export interface MetricEntry {
  value: number | null;
  reliability: "exact" | "estimated" | "unknown";
  source?: string;
}

/** A bag of named metric entries. */
export type MetricsRecord = Record<string, MetricEntry>;

/** A reliability violation for one metric. */
export interface MetricReliabilityFlag {
  metric: string;
  reason: string;
}

/** Aggregate reliability verdict over a `MetricsRecord`. */
export interface MetricsReliabilityResult {
  reliable: boolean;
  flags: MetricReliabilityFlag[];
}

/**
 * Assess whether a metrics record fabricates any value. Iterates metric names
 * in sorted order so the returned `flags` are deterministic regardless of
 * insertion order.
 */
export function assessMetricsReliability(metrics: MetricsRecord): MetricsReliabilityResult {
  const flags: MetricReliabilityFlag[] = [];

  for (const metric of Object.keys(metrics).sort()) {
    const entry = metrics[metric];
    if (entry === undefined) continue;

    // "exact" must be backed by a reported value; an exact-with-null claim is
    // a fabricated exact metric.
    if (entry.reliability === "exact" && entry.value === null) {
      flags.push({
        metric,
        reason: "reliability 'exact' requires a reported value, but value is null",
      });
      continue;
    }

    // Anything not exact must record where the estimate/unknown came from.
    if (entry.reliability !== "exact") {
      const source = entry.source;
      if (source === undefined || source.length === 0) {
        flags.push({
          metric,
          reason: `reliability '${entry.reliability}' requires a recorded source`,
        });
      }
    }
  }

  return { reliable: flags.length === 0, flags };
}

/** Reliability ordered from most to least trustworthy (worst-case wins). */
const RELIABILITY_RANK: Record<MetricEntry["reliability"], number> = {
  exact: 0,
  estimated: 1,
  unknown: 2,
};

/**
 * Reduce a `MetricsRecord` to the single coarse reliability enum carried by a
 * persisted `harness-run-output` `metrics` object, using a documented
 * worst-case-reliability-wins rule: the aggregate is only as trustworthy as its
 * least reliable member. An empty record is `"exact"` (nothing degrades it).
 */
export function reduceReliability(metrics: MetricsRecord): MetricEntry["reliability"] {
  let worst: MetricEntry["reliability"] = "exact";
  for (const entry of Object.values(metrics)) {
    if (RELIABILITY_RANK[entry.reliability] > RELIABILITY_RANK[worst]) {
      worst = entry.reliability;
    }
  }
  return worst;
}
