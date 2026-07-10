import type { ExecutionRunRecord, MetricValue } from "./types";

export type RunComparison = {
  run_a: string;
  run_b: string;
  metrics: Array<{
    name: string;
    a: MetricValue | null;
    b: MetricValue | null;
  }>;
  speed_claim: "not-claimed";
};

export function compareExecutionRuns(a: ExecutionRunRecord, b: ExecutionRunRecord): RunComparison {
  const names = [...new Set([...Object.keys(a.metrics), ...Object.keys(b.metrics)])].sort();
  return {
    run_a: a.run_id,
    run_b: b.run_id,
    metrics: names.map((name) => ({ name, a: a.metrics[name] ?? null, b: b.metrics[name] ?? null })),
    speed_claim: "not-claimed",
  };
}
