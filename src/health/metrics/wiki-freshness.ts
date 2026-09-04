// LWG-15 wiki freshness as a health metric (flow 228, phase 5).
//
// Documentation drift is measurable and repairable, and until now it was
// invisible unless someone remembered to run a command. This surfaces it
// beside lint, types, tests and complexity.
//
// HEALTH READS, IT DOES NOT COMPUTE. The number is lifted from the last
// `keryx wiki freshness` report. Recomputing here would start a graph
// traversal inside a command people expect to be fast, and would couple two
// subsystems that today share only a file.
//
// THE FAILURE THIS IS MOST EXPOSED TO is a missing report reading as a clean
// one, so every not-measured case is represented explicitly and none of them
// produces a number. A ratio of 1.0 conjured from an absent report would be
// the exact bug this package has now caught in itself three times.

import { readFile, stat } from "node:fs/promises";
import path from "node:path";

/** Evidence older than this is reported with its age rather than as current. */
export const DEFAULT_STALE_EVIDENCE_DAYS = 7;

export type FreshnessMetricStatus =
  | "measured"
  | "no-report"
  | "unreadable-report"
  | "stale-evidence";

export interface WikiFreshnessMetric {
  status: FreshnessMetricStatus;
  /** Why the metric is not a number. Absent when `status` is `measured`. */
  reason?: string;
  pagesTotal?: number;
  pagesFresh?: number;
  /** Pages excluded from scoring for having an empty describe-set. */
  pagesUndecidable?: number;
  /** Pages the report says need attention above advisory strength. */
  actionable?: number;
  /**
   * fresh / (total - undecidable), 0..1.
   *
   * The denominator excludes undecidable pages ON PURPOSE, and the count is
   * reported next to it: a ratio that quietly counted pages it cannot judge
   * as fresh would flatter itself, and one that counted them as stale would
   * accuse them of a fault nobody has established.
   */
  ratio?: number;
  /** When the underlying freshness report was generated. */
  reportGeneratedAt?: string;
  /** Age of that report in whole days. */
  reportAgeDays?: number;
}

export function freshnessReportPath(cwd: string): string {
  return path.join(cwd, ".metaproject", "data", "wiki", "freshness", "latest.json");
}

/**
 * Read the last freshness report and project it into a health metric.
 *
 * Never throws, and never returns a number it did not read. `staleAfterDays`
 * of 0 disables the staleness check.
 */
export async function readWikiFreshnessMetric(
  cwd: string,
  options: { staleAfterDays?: number; now?: () => Date } = {},
): Promise<WikiFreshnessMetric> {
  const file = freshnessReportPath(cwd);
  const staleAfterDays = options.staleAfterDays ?? DEFAULT_STALE_EVIDENCE_DAYS;
  const now = (options.now ?? (() => new Date()))();

  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch {
    return {
      status: "no-report",
      reason:
        "no wiki freshness report has been produced; run `keryx wiki freshness`. This is not evidence that the wiki is fresh.",
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      status: "unreadable-report",
      reason: `${path.relative(cwd, file)} is not valid JSON; re-run \`keryx wiki freshness\`.`,
    };
  }

  const report = parsed as {
    generatedAt?: unknown;
    totals?: { pagesTotal?: unknown; pagesFresh?: unknown; pagesUndecidable?: unknown };
    pages?: Array<{ confidence?: unknown }>;
  };
  const totals = report.totals ?? {};
  const pagesTotal = numberOr(totals.pagesTotal);
  const pagesFresh = numberOr(totals.pagesFresh);

  if (pagesTotal === null || pagesFresh === null) {
    return {
      status: "unreadable-report",
      reason: `${path.relative(cwd, file)} is missing its totals; re-run \`keryx wiki freshness\`.`,
    };
  }

  const pagesUndecidable = numberOr(totals.pagesUndecidable) ?? 0;
  const actionable = Array.isArray(report.pages)
    ? report.pages.filter((page) => page.confidence !== "fyi").length
    : 0;

  const scorable = pagesTotal - pagesUndecidable;
  const ratio = scorable > 0 ? pagesFresh / scorable : undefined;

  const generatedAt = typeof report.generatedAt === "string" ? report.generatedAt : undefined;
  const ageDays = await reportAgeDays(file, generatedAt, now);

  const base: WikiFreshnessMetric = {
    status: "measured",
    pagesTotal,
    pagesFresh,
    pagesUndecidable,
    actionable,
    ...(ratio === undefined ? {} : { ratio }),
    ...(generatedAt ? { reportGeneratedAt: generatedAt } : {}),
    ...(ageDays === null ? {} : { reportAgeDays: ageDays }),
  };

  if (staleAfterDays > 0 && ageDays !== null && ageDays > staleAfterDays) {
    // The numbers are still carried — they are the last thing known — but the
    // status says they are not current evidence. Presenting a month-old report
    // as today's state is a quieter lie than having none.
    return {
      ...base,
      status: "stale-evidence",
      reason: `the freshness report is ${ageDays} day(s) old; re-run \`keryx wiki freshness\` before trusting it.`,
    };
  }

  return base;
}

function numberOr(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

async function reportAgeDays(
  file: string,
  generatedAt: string | undefined,
  now: Date,
): Promise<number | null> {
  const stamped = generatedAt ? Date.parse(generatedAt) : Number.NaN;
  if (Number.isFinite(stamped)) {
    return Math.floor((now.getTime() - stamped) / 86_400_000);
  }
  // Fall back to the file's mtime rather than giving up on the age: an
  // unstamped report is old-format, not ageless.
  try {
    const info = await stat(file);
    return Math.floor((now.getTime() - info.mtimeMs) / 86_400_000);
  } catch {
    return null;
  }
}

/** One line for the health artifact and the dashboard. */
export function renderWikiFreshnessLine(metric: WikiFreshnessMetric): string {
  if (metric.status !== "measured" && metric.status !== "stale-evidence") {
    return `wiki freshness: not measured — ${metric.reason ?? "no reason recorded"}`;
  }
  const pct = metric.ratio === undefined ? "n/a" : `${Math.round(metric.ratio * 100)}%`;
  const undecidable =
    metric.pagesUndecidable && metric.pagesUndecidable > 0
      ? `, ${metric.pagesUndecidable} undecidable (excluded)`
      : "";
  const suffix = metric.status === "stale-evidence" ? `  [STALE EVIDENCE: ${metric.reason}]` : "";
  return (
    `wiki freshness: ${pct} (${metric.pagesFresh}/${(metric.pagesTotal ?? 0) - (metric.pagesUndecidable ?? 0)} scorable pages` +
    `${undecidable}), ${metric.actionable ?? 0} needing attention${suffix}`
  );
}
