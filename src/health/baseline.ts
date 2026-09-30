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
 * Sources added to keryx after baselines existed but before they recorded
 * `sources`. A baseline without the field is taken to have measured what the
 * current run measures, minus these: it was taken on the same project and
 * config, and cannot have seen a source keryx did not have yet.
 */
export const SOURCES_ADDED_AFTER_LEGACY_BASELINES: readonly string[] = ["oxlint"];

/** The sources of a run that produced a result: the set a baseline records. */
export function measuredSources(sources: readonly SourceRunInfo[]): string[] {
  return sources.filter((s) => !didNotProduceResult(s)).map((s) => s.source).sort();
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
 * The sources the stored baseline measured, given what this run measured;
 * `null` when there is no baseline. A baseline without the field is resolved
 * through `SOURCES_ADDED_AFTER_LEGACY_BASELINES`.
 */
export async function loadBaselineSources(cwd: string, measuredNow: readonly string[]): Promise<Set<string> | null> {
  const data = await readBaselineFile(cwd);
  if (data === null) return null;
  if (Array.isArray(data.sources)) return new Set(data.sources);
  return new Set(measuredNow.filter((source) => !SOURCES_ADDED_AFTER_LEGACY_BASELINES.includes(source)));
}

export async function loadBaseline(
  cwd: string,
): Promise<Map<string, BaselineEntry>> {
  const file = baselinePath(cwd);
  if (!(await pathExists(file))) {
    return new Map();
  }
  try {
    const data = JSON.parse(await readFile(file, "utf8")) as BaselineFile;
    return new Map(Object.entries(data.scopes ?? {}));
  } catch {
    return new Map();
  }
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

  const file = baselinePath(cwd);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(
    file,
    `${JSON.stringify(
      { generatedAt, scopes, ...(recordedSources !== undefined ? { sources: [...recordedSources] } : {}) },
      null,
      2,
    )}\n`,
    "utf8",
  );
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
