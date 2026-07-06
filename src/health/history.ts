import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { pathExists } from "../lib/fs";
import { dataRoot } from "./util";
import type { HealthReport } from "./types";

// Multi-run trend analysis over data/health/history/<timestamp>.json snapshots,
// beyond the single accept-current baseline.

export type HistoryPoint = {
  generatedAt: string;
  gate: string;
  projectScore: number | null;
  scores: Record<string, number>; // scopeKey -> health_score
};

export type TrendDirection = "improving" | "declining" | "stable" | "unknown";

export type TrendSummary = {
  scope: string;
  count: number;
  first: number | null;
  current: number | null;
  delta: number | null;
  min: number | null;
  max: number | null;
  direction: TrendDirection;
  series: number[];
};

export async function loadHistory(
  cwd: string,
  limit = 20,
): Promise<HistoryPoint[]> {
  const dir = path.join(dataRoot(cwd), "history");
  if (!(await pathExists(dir))) {
    return [];
  }

  const files = (await readdir(dir))
    .filter((file) => file.endsWith(".json"))
    .sort();

  const points: HistoryPoint[] = [];
  for (const file of files.slice(-limit)) {
    try {
      const report = JSON.parse(
        await readFile(path.join(dir, file), "utf8"),
      ) as HealthReport;
      const scores: Record<string, number> = {};
      for (const metric of report.metrics ?? []) {
        scores[metric.key] = metric.health_score;
      }
      points.push({
        generatedAt: report.generatedAt,
        gate: report.gate?.status ?? "unknown",
        projectScore: scores.project ?? null,
        scores,
      });
    } catch {
      // skip corrupt snapshot
    }
  }
  return points;
}

export function computeTrend(
  points: HistoryPoint[],
  scopeKey: string,
): TrendSummary {
  const series = points
    .map((point) => point.scores[scopeKey])
    .filter((value): value is number => typeof value === "number");

  if (series.length === 0) {
    return {
      scope: scopeKey,
      count: 0,
      first: null,
      current: null,
      delta: null,
      min: null,
      max: null,
      direction: "unknown",
      series: [],
    };
  }

  const first = series[0] as number;
  const current = series[series.length - 1] as number;
  const delta = current - first;
  const direction: TrendDirection =
    series.length < 2
      ? "unknown"
      : delta > 2
        ? "improving"
        : delta < -2
          ? "declining"
          : "stable";

  return {
    scope: scopeKey,
    count: series.length,
    first,
    current,
    delta,
    min: Math.min(...series),
    max: Math.max(...series),
    direction,
    series,
  };
}
