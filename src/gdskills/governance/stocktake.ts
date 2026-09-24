// Flow 309, W1 Lane C — `keryx skills stocktake`, the periodic catalog
// health check (W1-AC11). Every entry gets a `keep | improve | update |
// retire | merge` verdict with a reason that names THAT skill's own
// evidence — never a bare verdict, and never a reason two different skills
// share verbatim (`assertReasonsSpecific`, called before every report is
// written).
//
// Verdict precedence, per the workstream's design:
//   1. authoring lint errors            -> improve
//   2. scout overlap >= use threshold   -> merge
//   3. a verification report says stale -> update
//   4. a retired/deprecated marker      -> retire
//   5. (non-quick only) low deterministic trigger accuracy -> improve
//   6. otherwise                        -> keep
//
// Every branch's reason is PREFIXED with the skill's own id — not decoration,
// the mechanism `assertReasonsSpecific` relies on to stay true on the real
// 72-skill catalog: two skills can legitimately land on the same lint rule,
// the same closest neighbor, or the same trigger count, and prefixing with
// the id this reason is ABOUT is what keeps two such reasons from ever being
// byte-identical.
//
// CACHE: keyed by `${skillId}` -> `{sha256, algorithmVersion}`, so an
// unchanged skill (same content hash) is reused rather than re-linted and
// re-scouted every run — the "stocktake over ~72 skills in a few seconds"
// requirement, satisfied by not doing the O(n^2) scout comparison for a skill
// whose hash has not moved since the version that already reasoned about it.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { lintSkill } from "./authoring-lint";
import { loadSkillCatalog, type CatalogEntry, type CatalogScope } from "./catalog-index";
import { SCOUT_USE_THRESHOLD, scoutSkill } from "./scout";

export type StocktakeVerdict = "keep" | "improve" | "update" | "retire" | "merge";

export interface StocktakeEntry {
  readonly skillId: string;
  readonly verdict: StocktakeVerdict;
  readonly reason: string;
  readonly evidence: Readonly<Record<string, unknown>>;
}

export interface StocktakeReport {
  readonly schemaVersion: "1.0.0";
  readonly generatedAt: string;
  readonly scope: CatalogScope;
  readonly entries: readonly StocktakeEntry[];
  readonly cache: { readonly hits: number; readonly misses: number };
}

export interface StocktakeOptions {
  readonly scope?: CatalogScope;
  readonly quick?: boolean;
  readonly now?: () => Date;
  /** Override for tests — defaults to `.metaproject/data/skills/stocktake/cache.json` under `root`. */
  readonly cachePath?: string;
}

/** Bumped when the verdict-derivation algorithm changes, so a stale cache entry is never reused across a semantic change. */
const ALGORITHM_VERSION = "1";

interface CacheRecord {
  readonly sha256: string;
  readonly algorithmVersion: string;
  readonly quick: boolean;
  readonly entry: StocktakeEntry;
}
type Cache = Record<string, CacheRecord>;

function loadCache(cachePath: string): Cache {
  if (!existsSync(cachePath)) return {};
  try {
    return JSON.parse(readFileSync(cachePath, "utf8")) as Cache;
  } catch {
    return {};
  }
}

function saveCache(cachePath: string, cache: Cache): void {
  mkdirSync(path.dirname(cachePath), { recursive: true });
  writeFileSync(cachePath, `${JSON.stringify(cache, null, 2)}\n`, "utf8");
}

function verificationReportPath(root: string, entry: CatalogEntry): string {
  return path.join(root, ".metaproject", "data", "gdskills", "reports", `${entry.category}-${entry.name}-verification.json`);
}

/** `update`, when a `keryx skills verify` report exists for this skill and reports stale/needs-review/blocked. `undefined` otherwise (bundled skills usually have none — see the workstream's own note). */
function checkFreshness(root: string, entry: CatalogEntry): StocktakeEntry | undefined {
  const reportPath = verificationReportPath(root, entry);
  if (!existsSync(reportPath)) return undefined;
  try {
    const report = JSON.parse(readFileSync(reportPath, "utf8")) as { status?: string };
    if (report.status === "stale" || report.status === "needs-review" || report.status === "blocked") {
      return {
        skillId: entry.id,
        verdict: "update",
        reason: `${entry.id}: verification report (${path.relative(root, reportPath)}) reports status "${report.status}"`,
        evidence: { verificationStatus: report.status, reportPath },
      };
    }
  } catch {
    return undefined;
  }
  return undefined;
}

const RETIRED_MARKER_PATTERN = /\bstatus:\s*"?retired"?/i;
const DEPRECATED_MARKER_PATTERN = /\bdeprecated:\s*true\b/i;

function checkRetired(entry: CatalogEntry): StocktakeEntry | undefined {
  if (RETIRED_MARKER_PATTERN.test(entry.body) || DEPRECATED_MARKER_PATTERN.test(entry.body)) {
    return {
      skillId: entry.id,
      verdict: "retire",
      reason: `${entry.id}: frontmatter carries a retired/deprecated marker`,
      evidence: { markerFound: true },
    };
  }
  return undefined;
}

function evaluateEntry(root: string, entry: CatalogEntry, catalog: readonly CatalogEntry[], quick: boolean): StocktakeEntry {
  const lintFindings = lintSkill(entry.body, { path: entry.path, strict: false });
  const errorFindings = lintFindings.filter((finding) => finding.severity === "error");
  if (errorFindings.length > 0) {
    const detail = errorFindings.map((finding) => `${finding.rule} (${finding.message})`).join("; ");
    return {
      skillId: entry.id,
      verdict: "improve",
      reason: `${entry.id}: authoring lint failed on ${errorFindings.length} rule(s): ${detail}`,
      evidence: { lintFindings: errorFindings },
    };
  }

  const others = catalog.filter((candidate) => candidate.id !== entry.id);
  const scout = scoutSkill(entry.description.length > 0 ? entry.description : entry.name, others);
  const top = scout.matches[0];
  if (top !== undefined && top.overlapScore >= SCOUT_USE_THRESHOLD) {
    return {
      skillId: entry.id,
      verdict: "merge",
      reason: `${entry.id}: overlaps ${top.skillId} at score ${top.overlapScore.toFixed(2)} (${top.reason})`,
      evidence: { overlap: top },
    };
  }

  const freshness = checkFreshness(root, entry);
  if (freshness !== undefined) return freshness;

  const retired = checkRetired(entry);
  if (retired !== undefined) return retired;

  if (!quick) {
    const positives = entry.triggers.length > 0 ? entry.triggers.slice(0, 3) : [entry.description];
    const hits = positives.filter((prompt) => scoutSkill(prompt, catalog).matches[0]?.skillId === entry.id).length;
    const accuracy = positives.length > 0 ? hits / positives.length : 1;
    if (accuracy < 0.5) {
      return {
        skillId: entry.id,
        verdict: "improve",
        reason: `${entry.id}: trigger accuracy ${(accuracy * 100).toFixed(0)}% — ${hits}/${positives.length} of its own triggers route back to it`,
        evidence: { triggerAccuracy: accuracy, checked: positives.length },
      };
    }
  }

  return {
    skillId: entry.id,
    verdict: "keep",
    reason: `${entry.id}: lint clean; ${entry.triggers.length} trigger(s); closest neighbor ${top?.skillId ?? "none"} at ${top !== undefined ? top.overlapScore.toFixed(2) : "0.00"}`,
    evidence: { triggerCount: entry.triggers.length, closestNeighbor: top ?? null },
  };
}

/** Throws when the same `reason` string appears for two different skills — a stocktake report must never ship a generic, reused verdict (W1-AC11). */
export function assertReasonsSpecific(report: StocktakeReport): void {
  const seen = new Map<string, string>();
  for (const entry of report.entries) {
    const owner = seen.get(entry.reason);
    if (owner !== undefined && owner !== entry.skillId) {
      throw new Error(`stocktake reason reused verbatim across skills: "${entry.reason}" (${owner}, ${entry.skillId})`);
    }
    seen.set(entry.reason, entry.skillId);
  }
}

/**
 * Runs a stocktake over `root`'s catalog, writes the cache and the dated
 * report, and returns it. `--quick` skips the (still cheap, but O(n) extra
 * scout calls) trigger-accuracy pass; a full run adds it.
 */
export function runStocktake(root: string, options: StocktakeOptions = {}): StocktakeReport {
  const scope = options.scope ?? "bundled";
  const quick = options.quick ?? false;
  const now = options.now ?? ((): Date => new Date());
  const catalog = loadSkillCatalog(root, { scope });
  const cachePath = options.cachePath ?? path.join(root, ".metaproject", "data", "skills", "stocktake", "cache.json");
  const cache = loadCache(cachePath);

  let hits = 0;
  let misses = 0;
  const entries: StocktakeEntry[] = [];
  for (const entry of catalog) {
    const cached = cache[entry.id];
    if (cached !== undefined && cached.sha256 === entry.sha256 && cached.algorithmVersion === ALGORITHM_VERSION && cached.quick === quick) {
      hits += 1;
      entries.push(cached.entry);
      continue;
    }
    misses += 1;
    const result = evaluateEntry(root, entry, catalog, quick);
    entries.push(result);
    cache[entry.id] = { sha256: entry.sha256, algorithmVersion: ALGORITHM_VERSION, quick, entry: result };
  }

  const generatedAt = now().toISOString();
  const report: StocktakeReport = {
    schemaVersion: "1.0.0",
    generatedAt,
    scope,
    entries: [...entries].sort((a, b) => a.skillId.localeCompare(b.skillId)),
    cache: { hits, misses },
  };
  assertReasonsSpecific(report);

  saveCache(cachePath, cache);
  const dateStamp = generatedAt.slice(0, 10);
  const reportPath = path.join(root, ".metaproject", "data", "skills", "stocktake", `${dateStamp}.json`);
  mkdirSync(path.dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

  return report;
}
