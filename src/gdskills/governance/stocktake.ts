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

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { lintSkill } from "./authoring-lint";
import { loadSkillCatalog, type CatalogEntry, type CatalogScope } from "./catalog-index";
import { checkSkillSelected, SCOUT_USE_THRESHOLD, scoutSkill } from "./scout";

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

/**
 * Bumped when the verdict-derivation algorithm changes, so a stale cache
 * entry is never reused across a semantic change. Bumped to "2" in flow 309
 * T12: `scoutSkill`'s scorer moved from symmetric Jaccard to IDF-weighted
 * query coverage, and the trigger-accuracy check now uses `checkSkillSelected`
 * (fork-threshold + category-family) instead of a bare top-1 match — a cache
 * entry written under "1" reflects verdicts the old, defective scoring
 * produced (e.g. spurious `improve` from trigger prompts that could never
 * clear the old, too-strict rule) and must not be served after this fix.
 *
 * Bumped to "3" (F6, flow 309 review round 1) alongside the cache-key
 * widening below: `description-only` trigger scoring (F5) is also a scoring
 * change no entry cached under "2" reflects.
 */
const ALGORITHM_VERSION = "3";

/**
 * F6 (flow 309 review round 1): the cache used to be keyed on ONLY the
 * skill's own `SKILL.md` sha256 — but `evaluateEntry` above does not just
 * lint that one file: the `merge` verdict (scout overlap) and the low
 * trigger-accuracy `improve` verdict both depend on EVERY OTHER catalog
 * entry (a new or edited NEIGHBOUR skill can push this skill's overlap
 * score across `SCOUT_USE_THRESHOLD`, or change what outranks it in the
 * trigger check, without this skill's own file changing at all), the
 * `update` verdict depends on a separate verification-report file, and a
 * skill can ship extra `references/` files that are not part of the hash
 * lint/scout run against. A cache keyed on sha256 alone served a stale
 * `keep`/`merge`/`update` verdict whenever any of those OTHER inputs moved.
 *
 * The key now also covers:
 *   - `catalogFingerprint`: a single hash of every entry's `id`+`sha256` in
 *     the catalog this run scored against (sorted, so key order never
 *     matters) — any entry added, removed, or edited anywhere invalidates
 *     every OTHER entry's cache row, not just its own.
 *   - `verificationReportHash`: hash of `checkFreshness`'s report file
 *     content, `null` when none exists — a report written/edited/removed
 *     after the last stocktake run invalidates the row.
 *   - `referencesHash`: hash of every file under the skill's own
 *     `references/` directory (sorted paths + content), `null` when none
 *     exists.
 */
interface CacheKeyInputs {
  readonly sha256: string;
  readonly catalogFingerprint: string;
  readonly verificationReportHash: string | null;
  readonly referencesHash: string | null;
}

function cacheKeyMatches(cached: CacheRecord, inputs: CacheKeyInputs, quick: boolean): boolean {
  return (
    cached.algorithmVersion === ALGORITHM_VERSION &&
    cached.quick === quick &&
    cached.sha256 === inputs.sha256 &&
    cached.catalogFingerprint === inputs.catalogFingerprint &&
    cached.verificationReportHash === inputs.verificationReportHash &&
    cached.referencesHash === inputs.referencesHash
  );
}

/** Sorted hash of every entry's `id`+`sha256` — moves whenever ANY catalog entry is added, removed, or edited, since `evaluateEntry`'s overlap/trigger checks score against neighbours, not just the entry itself. */
function catalogFingerprint(catalog: readonly CatalogEntry[]): string {
  const parts = [...catalog].map((entry) => `${entry.id}:${entry.sha256}`).sort();
  return createHash("sha256").update(parts.join("\n")).digest("hex");
}

/** Hash of `checkFreshness`'s verification-report file, `null` when none exists (the common case for bundled skills). */
function verificationReportHash(root: string, entry: CatalogEntry): string | null {
  const reportPath = verificationReportPath(root, entry);
  if (!existsSync(reportPath)) return null;
  try {
    return createHash("sha256").update(readFileSync(reportPath, "utf8")).digest("hex");
  } catch {
    return null;
  }
}

/** Hash of every file under `<skill-dir>/references/` (sorted relative path + content), `null` when the directory does not exist. */
function referencesHash(entry: CatalogEntry): string | null {
  const referencesDir = path.join(path.dirname(entry.path), "references");
  if (!existsSync(referencesDir)) return null;
  const files: string[] = [];
  const walk = (dir: string, relative: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const full = path.join(dir, name);
      const rel = relative.length > 0 ? `${relative}/${name}` : name;
      if (statSync(full).isDirectory()) {
        walk(full, rel);
      } else {
        files.push(rel);
      }
    }
  };
  walk(referencesDir, "");
  const hash = createHash("sha256");
  for (const rel of files) {
    hash.update(rel);
    hash.update("\0");
    hash.update(readFileSync(path.join(referencesDir, rel)));
    hash.update("\0");
  }
  return hash.digest("hex");
}

interface CacheRecord {
  readonly sha256: string;
  readonly algorithmVersion: string;
  readonly quick: boolean;
  readonly catalogFingerprint: string;
  readonly verificationReportHash: string | null;
  readonly referencesHash: string | null;
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
    // Same selection rule `keryx skills eval`'s trigger-accuracy check uses
    // (`checkSkillSelected` in scout.ts) — not a bare top-1 match, which
    // IDF-weighted coverage scoring can legitimately tie across many
    // same-category skills on a short trigger phrase (see that function's
    // doc comment). A trigger "routes back" here when it clears
    // `SCOUT_FORK_THRESHOLD` and no entry from a DIFFERENT category
    // outscores this skill.
    //
    // F5 (flow 309 review round 1): `field: "description-only"` — this
    // check's positives are drawn FROM `entry.triggers` itself, so scoring
    // them against an index that ALSO contains that same triggers list is
    // circular (a trigger phrase always "finds" the entry that lists it
    // verbatim). `eval.ts`'s trigger-accuracy check shares this exact
    // grader/flaw and the exact same fix — see that module's header for the
    // full rationale. This check's result is still a SYNTHESIZED signal
    // (drawn from the skill's own frontmatter, never human-authored test
    // cases), so it is used only as a demotion trigger ("improve" on low
    // accuracy) below — never treated as proof a skill's triggers are
    // correct; a "keep" verdict never cites this check as its justification,
    // only lint + overlap + freshness + retirement, each independently
    // checked above.
    const positives = entry.triggers.length > 0 ? entry.triggers.slice(0, 3) : [entry.description];
    const failing = positives.filter((prompt) => !checkSkillSelected(prompt, entry.id, catalog, { field: "description-only" }).selected);
    const hits = positives.length - failing.length;
    const accuracy = positives.length > 0 ? hits / positives.length : 1;
    if (accuracy < 0.5) {
      // F23 (flow 309 review round 1): a reason built ONLY from a
      // percentage and a fraction ("33% — 1/3") collides across two
      // UNRELATED skills that happen to share the same trigger count and
      // hit rate — real, observed on the bundled catalog (two skills both
      // landing on "1/3 of its own triggers route back to it"). Naming the
      // ACTUAL failing trigger phrases makes the reason genuinely
      // skill-specific: two skills only collide now if they also share the
      // exact same failing trigger text, which is not a coincidence worth
      // tolerating either.
      const failingList = failing.map((prompt) => JSON.stringify(prompt)).join(", ");
      return {
        skillId: entry.id,
        verdict: "improve",
        reason: `${entry.id}: trigger accuracy ${(accuracy * 100).toFixed(0)}% — ${hits}/${positives.length} of its own triggers route back to it; failing: ${failingList}`,
        evidence: { triggerAccuracy: accuracy, checked: positives.length, failing },
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

/**
 * F23 (flow 309 review round 1): every reason is prefixed `${entry.id}: `
 * (the module header explains why — it's what keeps two same-lint-rule or
 * same-closest-neighbor reasons apart at all), which meant the OLD
 * byte-for-byte comparison was satisfied BY CONSTRUCTION — two entries can
 * never collide on the id prefix alone, so the guard never actually checked
 * whether the EVIDENCE after the prefix was skill-specific. Two skills with
 * the exact same lint rule, the exact same closest neighbor, and the exact
 * same trigger count would sail through as "specific" purely because their
 * ids differ.
 *
 * The comparison now strips each entry's own id (and its bare name, the
 * `${category}/${name}` split) from its reason before comparing — what
 * remains must still differ across two DIFFERENT skills, or the reason is
 * not actually skill-specific evidence, just a decorated id.
 */
function stripSkillIdentity(reason: string, skillId: string): string {
  const name = skillId.split("/").at(-1) ?? skillId;
  return reason.split(skillId).join("<skill>").split(name).join("<skill>");
}

/** Throws when two DIFFERENT skills' reasons carry the same evidence once each one's own id/name is stripped out — a stocktake report must never ship a generic, reused verdict (W1-AC11). */
export function assertReasonsSpecific(report: StocktakeReport): void {
  const seen = new Map<string, string>();
  for (const entry of report.entries) {
    const stripped = stripSkillIdentity(entry.reason, entry.skillId);
    const owner = seen.get(stripped);
    if (owner !== undefined && owner !== entry.skillId) {
      throw new Error(
        `stocktake reason not skill-specific — identical evidence once each skill's own id is stripped, for ${owner} and ${entry.skillId}: "${entry.reason}"`,
      );
    }
    seen.set(stripped, entry.skillId);
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

  const fingerprint = catalogFingerprint(catalog);
  let hits = 0;
  let misses = 0;
  const entries: StocktakeEntry[] = [];
  for (const entry of catalog) {
    const inputs: CacheKeyInputs = {
      sha256: entry.sha256,
      catalogFingerprint: fingerprint,
      verificationReportHash: verificationReportHash(root, entry),
      referencesHash: referencesHash(entry),
    };
    const cached = cache[entry.id];
    if (cached !== undefined && cacheKeyMatches(cached, inputs, quick)) {
      hits += 1;
      entries.push(cached.entry);
      continue;
    }
    misses += 1;
    const result = evaluateEntry(root, entry, catalog, quick);
    entries.push(result);
    cache[entry.id] = { ...inputs, algorithmVersion: ALGORITHM_VERSION, quick, entry: result };
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
