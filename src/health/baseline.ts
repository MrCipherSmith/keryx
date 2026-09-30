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
 * fact about history, so it is FROZEN -- do not add a source here. A legacy
 * baseline gets this set written into its file on the first whole-project
 * run (`recordBaselineSources`), so no source added later is ever resolved
 * through this list.
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

/** The sources of a run that produced a result: the set a baseline records. */
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
 * The sources the stored baseline measured, and whether the file recorded
 * them (`false` for a legacy baseline, resolved to `LEGACY_BASELINE_SOURCES`);
 * `null` when there is no baseline.
 */
export async function loadBaselineSources(cwd: string): Promise<{ sources: Set<string>; recorded: boolean } | null> {
  const data = await readBaselineFile(cwd);
  if (data === null) return null;
  if (Array.isArray(data.sources)) return { sources: new Set(data.sources), recorded: true };
  return { sources: new Set(LEGACY_BASELINE_SOURCES), recorded: false };
}

/** Write the recorded source set without touching any score. */
export async function recordBaselineSources(cwd: string, sources: Iterable<string>): Promise<void> {
  const data = await readBaselineFile(cwd);
  if (data === null) return;
  await writeBaselineFile(cwd, { ...data, sources: [...new Set(sources)].sort() });
}

/**
 * A source measured for the first time adds its OWN effect to the baseline,
 * and nothing else. For every scope the baseline already holds, the new value
 * is the score without the new sources' findings (what `regression_score`
 * compared against) plus their current effect -- i.e. `health_score +
 * regression_score`. Drift in sources the baseline already measured is not
 * absorbed (it stays a regression), and from the next run the new source is
 * compared like any other, so its own growth counts. Folded on its first
 * whole-project run, whether or not anything else regressed.
 */
export async function foldNewSources(
  cwd: string,
  metrics: readonly ScopeMetrics[],
  recorded: ReadonlySet<string>,
  newSources: readonly string[],
): Promise<void> {
  const data = await readBaselineFile(cwd);
  if (data === null) return;
  const scopes = { ...data.scopes };
  for (const metric of metrics) {
    const entry = scopes[metric.key];
    if (entry === undefined) continue;
    // The previous value minus the new sources' own effect, from raw penalties
    // (a scope clamped at 0 still records the full effect).
    const effect = metric.new_source_effect ?? 0;
    const folded = Math.min(100, Math.max(0, Math.round(entry.health_score - effect)));
    scopes[metric.key] = { ...entry, health_score: folded };
  }
  await writeBaselineFile(cwd, { ...data, scopes, sources: [...new Set([...recorded, ...newSources])].sort() });
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
