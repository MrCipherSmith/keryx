import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathExists } from "../lib/fs";
import { didNotProduceResult } from "./gate";
import type { ScopeMetrics, ScopeSelector, SourceRunInfo } from "./types";

export type BaselineEntry = { health_score: number; risk_score: number };
export type BaselineFile = {
  generatedAt: string;
  scopes: Record<string, BaselineEntry>;
  /**
   * The sources that produced a result when these scores were taken. A score
   * is only comparable against findings from the same sources: a source the
   * baseline never measured would otherwise show up as a regression of code
   * that did not change. Absent in baselines written before it existed.
   */
  sources?: string[];
};

/**
 * What a baseline written before `sources` existed is taken to have measured:
 * every source keryx had before flow 352 (everything except oxlint). It is a
 * fact about history, so it is FROZEN -- do not add a source here. A source
 * added to keryx later is absent from it and so reads as new against a legacy
 * baseline, which is exactly right; `keryx health baseline update` replaces
 * the legacy resolution with a recorded set.
 *
 * Deliberately the whole pre-352 set, not "what this run measured": a source
 * the old baseline measured but that is missing now must stay in the set, or
 * its return would read as a new source and its regression would be hidden.
 */
export const LEGACY_BASELINE_SOURCES: readonly string[] = Object.freeze([
  "complexity",
  "coverage",
  "dependencyAudit",
  "eslint",
  "sonarqube",
  "tests",
  "typescript",
]);

/**
 * The sources whose output shaped a run's scores -- the set a baseline
 * records. Coverage data is applied to the scores whenever a report is on
 * disk, whatever the coverage source's mode or a --sources filter says, so it
 * counts whenever it was applied. Computed here and nowhere else.
 */
export function scoredSources(sources: readonly unknown[], coverageApplied: boolean): string[] {
  // Coverage is decided by applied data alone: an `available` report with no
  // line percentages (e.g. coverage-final.json only) shaped nothing, and
  // recording it would make a later real report read as a regression.
  const others = measuredSources(sources).filter((source) => source !== "coverage");
  return [...others, ...(coverageApplied ? ["coverage"] : [])].sort();
}

/**
 * The scored set of a stored report: its recorded `scoredSources`, or, for a
 * report written before that field existed, the same rule applied to what it
 * holds (a scope with a coverage value means coverage was applied).
 */
export function scoredSourcesOfReport(report: { sources: readonly unknown[]; metrics: readonly unknown[]; scoredSources?: unknown }): string[] {
  if (Array.isArray(report.scoredSources)) {
    return report.scoredSources.filter((s): s is string => typeof s === "string").sort();
  }
  const coverageApplied = report.metrics.some(
    (m) => m !== null && typeof m === "object" && typeof (m as { coverage?: unknown }).coverage === "number",
  );
  return scoredSources(report.sources, coverageApplied);
}

/** The sources of a run that produced a result. */
export function measuredSources(sources: readonly unknown[]): string[] {
  return sources
    // A hand-edited or damaged report can hold non-objects; they measured nothing.
    .filter((s): s is SourceRunInfo => s !== null && typeof s === "object")
    .filter((s) => !didNotProduceResult(s))
    .map((s) => s.source)
    .sort();
}

function baselinePath(cwd: string): string {
  return path.join(cwd, ".metaproject", "health", "baselines", "scores.json");
}

async function readBaselineFile(cwd: string): Promise<BaselineFile | null> {
  const file = baselinePath(cwd);
  if (!(await pathExists(file))) {
    return null;
  }
  try {
    return JSON.parse(await readFile(file, "utf8")) as BaselineFile;
  } catch {
    return null;
  }
}

/**
 * The sources the stored baseline measured (`LEGACY_BASELINE_SOURCES` for a
 * baseline written before they were recorded), or `null` when there is none.
 * Read-only: only the first run and `health baseline update` write a baseline.
 */
export async function loadBaselineSources(cwd: string): Promise<Set<string> | null> {
  const data = await readBaselineFile(cwd);
  if (data === null) return null;
  return new Set(Array.isArray(data.sources) ? data.sources : LEGACY_BASELINE_SOURCES);
}

async function writeBaselineFile(cwd: string, data: BaselineFile): Promise<void> {
  const file = baselinePath(cwd);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

export async function loadBaseline(
  cwd: string,
): Promise<Map<string, BaselineEntry>> {
  const data = await readBaselineFile(cwd);
  return new Map(Object.entries(data?.scopes ?? {}));
}

export async function hasBaseline(cwd: string): Promise<boolean> {
  return pathExists(baselinePath(cwd));
}

export async function writeBaseline(
  cwd: string,
  metrics: ScopeMetrics[],
  generatedAt: string,
  selector?: ScopeSelector,
  sources?: readonly string[],
): Promise<string[]> {
  const existing = await loadBaseline(cwd);
  // Without a measured set from the caller, keep whatever the file recorded.
  const recordedSources = sources ?? (await readBaselineFile(cwd))?.sources;
  const updated: string[] = [];

  for (const metric of metrics) {
    if (selector && !scopeMatches(selector, metric)) {
      continue;
    }
    existing.set(metric.key, {
      health_score: metric.health_score,
      risk_score: metric.risk_score,
    });
    updated.push(metric.key);
  }

  const scopes: Record<string, BaselineEntry> = {};
  for (const [key, value] of [...existing.entries()].sort()) {
    scopes[key] = value;
  }

  await writeBaselineFile(cwd, {
    generatedAt,
    scopes,
    ...(recordedSources !== undefined ? { sources: [...recordedSources].sort() } : {}),
  });
  return updated;
}

function scopeMatches(selector: ScopeSelector, metric: ScopeMetrics): boolean {
  switch (selector.kind) {
    case "project":
      return true;
    case "module":
      return metric.kind === "module" && metric.name === selector.name;
    case "file":
      return metric.kind === "file" && metric.name === selector.path;
    case "changed":
      return true;
  }
}
