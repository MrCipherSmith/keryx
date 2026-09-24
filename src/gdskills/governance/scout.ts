// Flow 309, W1 Lane C — `keryx skills scout`, the pre-creation dedupe gate
// (W1-AC9). Deterministic, lexical, offline: tokenization reuses the same
// `normalizeRouteText`/`routeTokens` tokenizer the skill router itself scores
// with (`src/lib/route-tokens.ts`), so a scout decision and a live routing
// decision can never silently disagree about what counts as a shared term.
//
// SCORING (flow 309, T12 — replaces the original symmetric-Jaccard scorer)
//
// The original scorer computed `|A∩B| / |A∪B|` between the query's tokens and
// an entry's FULL haystack (name + description + triggers). That punishes
// every short query: a 2-3 token trigger phrase scored against a 40-60 token
// description caps out near `query.size / description.size`, regardless of
// how completely the query's own intent is covered — `keryx skills eval`
// (flow 309, T12 diagnosis) showed `review/review-frontend`'s OWN triggers
// ("ui review", "review components", ...) scoring 0.03-0.09 against its own
// catalog entry, nowhere near `SCOUT_USE_THRESHOLD`, purely because the
// denominator is dominated by the description's unrelated tokens. A real
// dedupe query ("review react components mobx") suffered the same fate
// (0.086 against `review-frontend`, decision `create`) even though the
// skill plainly covers it.
//
// The fix scores QUERY COVERAGE, not set overlap: what fraction of the
// query's own (IDF-weighted) intent does this entry account for. A query
// token that matches is worth its IDF weight (rare terms like "mobx" count
// for more than "review", which appears in nearly every review/* skill's
// haystack); the entry's total token count no longer enters the score at
// all, so a 60-token description is not penalized relative to a 6-token one.
// `stemLite` folds "components"/"reviewing"/"reviews" onto "component"/
// "review"/"review" first, so plural/-ing variants of the same term always
// share one IDF bucket instead of splitting it — this is the fix for the
// second observed defect ("review components" vs "review component" scoring
// as unrelated tokens under the old exact-match scorer).
//
// Calibration evidence (flow 309, T12; scored against the real bundled
// catalog, 72 skills):
//   - `review/review-frontend`'s own description as query -> scores 1.0
//     against itself (full coverage; every other bundled skill's description
//     is checked as OK too — no self-query mismatch across all 72 skills).
//   - "review react components mobx" -> 0.661 against `review-frontend`,
//     `review-backend` and `review-flow-graph` (all three genuinely share
//     "review"+"react"+"component"), clearing `SCOUT_USE_THRESHOLD` (was
//     0.086, decision `create`).
//   - "kubernetes helm chart linting" (unrelated) -> top score 0.209
//     (`orchestration/code-verifier`/`platform/hookify`, sharing only
//     "lint"), well under `SCOUT_FORK_THRESHOLD`; decision stays `create`.
// See `SCOUT_USE_THRESHOLD`/`SCOUT_FORK_THRESHOLD` below for the threshold
// values themselves — unchanged by this fix, since both were already
// calibrated against a [0, 1] coverage-shaped score and the failure was in
// how the score was COMPUTED, not where the bar was set.

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { normalizeRouteText, routeTokens } from "../../lib/route-tokens";
import type { CatalogEntry } from "./catalog-index";

/**
 * Overlap score at or above which an existing skill should be used as-is
 * rather than forked or duplicated. Calibrated against the real bundled
 * catalog: scouting an existing skill's own description returns its own id
 * at or above this score (the description IS the bulk of that skill's
 * scored text, so its own-description query always reaches full coverage),
 * and an unrelated query scores every entry well below it.
 */
export const SCOUT_USE_THRESHOLD = 0.55;

/** Overlap score at or above which a fork (partial reuse) is recommended over a fresh `create`. */
export const SCOUT_FORK_THRESHOLD = 0.3;

export type ScoutDecision = "use" | "fork" | "create";

export interface ScoutMatch {
  readonly skillId: string;
  readonly category: string;
  readonly overlapScore: number;
  readonly reason: string;
}

export interface ScoutResult {
  readonly query: string;
  readonly decision: ScoutDecision;
  readonly thresholds: { readonly use: number; readonly fork: number };
  readonly matches: readonly ScoutMatch[];
}

export interface ScoutOptions {
  readonly threshold?: { readonly use?: number; readonly fork?: number };
  /** Which entry fields to score against — see `LexicalField`'s doc comment. Defaults to `"full"`. */
  readonly field?: LexicalField;
}

// ---------------------------------------------------------------------------
// Lexical scoring: IDF-weighted query coverage over stemmed tokens.
// ---------------------------------------------------------------------------

/**
 * Lightweight, deterministic suffix stripping so "component"/"components",
 * "review"/"reviews"/"reviewing" share one token instead of splitting IDF
 * weight (and match credit) across near-duplicate surface forms. Not a real
 * stemmer (no dictionary, no exceptions) — just enough to stop plural/-ing
 * near-misses from reading as "no shared terms".
 */
function stemLite(token: string): string {
  if (token.length > 4 && token.endsWith("ies")) return `${token.slice(0, -3)}y`;
  if (token.length > 4 && token.endsWith("es")) return token.slice(0, -2);
  if (token.length > 5 && token.endsWith("ing")) return token.slice(0, -3);
  if (token.length > 3 && token.endsWith("s") && !token.endsWith("ss")) return token.slice(0, -1);
  return token;
}

function lexicalTokens(text: string): Set<string> {
  return new Set([...routeTokens(normalizeRouteText(text))].map(stemLite));
}

/**
 * Which fields of an entry contribute to its scored tokens.
 *
 * `"full"` (`name + description + triggers`) is what `scoutSkill`'s own
 * use/fork/create dedupe decision scores against — that decision is
 * legitimately "does an EXISTING skill's whole definition, triggers
 * included, already cover this query".
 *
 * `"description-only"` (`name + description`, triggers excluded) exists for
 * F5 (flow 309 review round 1): trigger-ACCURACY checks (`eval`'s trigger
 * scenarios, `stocktake`'s own-trigger-routes-back check) synthesize their
 * test prompts FROM a skill's own `triggers` list — scoring such a prompt
 * against an index that also includes that same triggers list is circular
 * (the prompt is, verbatim or near-verbatim, part of what it is being
 * matched against), so a bogus skill that simply borrows another skill's
 * trigger phrases "passes" a trigger check that never had to prove its
 * DESCRIPTION actually covers what the trigger claims. Scoring against
 * description-only tokens instead asks the sound question: does this
 * skill's description (what a human/router actually reads to decide
 * relevance) account for the trigger phrase's words, independent of the
 * trigger list itself.
 */
export type LexicalField = "full" | "description-only";

/** `name + description` (+ `triggers` when `field` is `"full"`), tokenized and stemmed — the text an entry is scored on. */
function entryLexicalTokens(entry: CatalogEntry, field: LexicalField): Set<string> {
  const parts = field === "full" ? [entry.name, entry.description, ...entry.triggers] : [entry.name, entry.description];
  return lexicalTokens(parts.join(" "));
}

interface LexicalIndex {
  readonly tokensById: ReadonlyMap<string, ReadonlySet<string>>;
  /** Smoothed IDF: `ln((N+1)/(df+1)) + 1`, always > 0, so an unseen query token still contributes its (maximal) weight rather than vanishing. */
  readonly idf: (token: string) => number;
}

/** Builds the corpus IDF table this `catalog` scores against — document frequency per stemmed token, over this catalog only, so two calls against different catalogs never leak weights between them. */
function buildLexicalIndex(catalog: readonly CatalogEntry[], field: LexicalField): LexicalIndex {
  const tokensById = new Map<string, ReadonlySet<string>>();
  const documentFrequency = new Map<string, number>();
  for (const entry of catalog) {
    const tokens = entryLexicalTokens(entry, field);
    tokensById.set(entry.id, tokens);
    for (const token of tokens) documentFrequency.set(token, (documentFrequency.get(token) ?? 0) + 1);
  }
  const n = catalog.length;
  const idf = (token: string): number => Math.log((n + 1) / ((documentFrequency.get(token) ?? 0) + 1)) + 1;
  return { tokensById, idf };
}

/**
 * IDF-weighted fraction of `queryTokens`' own weight that `entryTokens`
 * covers — `sum(idf(t) for t in query ∩ entry) / sum(idf(t) for t in query)`.
 * Unlike Jaccard, the entry's OWN size never enters the denominator: a short
 * trigger phrase scored against a long description is judged only on how
 * much of the phrase's intent that description accounts for, not diluted by
 * everything else the description also talks about.
 */
function coverageScore(
  queryTokens: ReadonlySet<string>,
  entryTokens: ReadonlySet<string>,
  idf: (token: string) => number,
): { score: number; shared: string[] } {
  const shared = [...queryTokens].filter((token) => entryTokens.has(token)).sort();
  if (queryTokens.size === 0) return { score: 0, shared };
  let queryWeight = 0;
  let matchedWeight = 0;
  for (const token of queryTokens) {
    const weight = idf(token);
    queryWeight += weight;
    if (entryTokens.has(token)) matchedWeight += weight;
  }
  return { score: queryWeight === 0 ? 0 : matchedWeight / queryWeight, shared };
}

/** Every catalog entry scored against `query`, sorted by score descending then id ascending (deterministic ties) — the FULL ranking, uncapped (`scoutSkill` caps it to 5 for display; the trigger grader needs the whole thing to check what outranks what). */
function rankCatalog(query: string, catalog: readonly CatalogEntry[], field: LexicalField = "full"): ScoutMatch[] {
  const index = buildLexicalIndex(catalog, field);
  const queryTokens = lexicalTokens(query);
  const scored = catalog.map((entry) => {
    const entryTokens = index.tokensById.get(entry.id) ?? new Set<string>();
    const { score, shared } = coverageScore(queryTokens, entryTokens, index.idf);
    return {
      skillId: entry.id,
      category: entry.category,
      overlapScore: score,
      reason: shared.length > 0 ? `shared terms: ${shared.join(", ")}` : "no shared terms",
    };
  });
  return scored.sort((a, b) => b.overlapScore - a.overlapScore || a.skillId.localeCompare(b.skillId));
}

/**
 * Score `query` against `catalog` and decide `use | fork | create`. Top 5
 * matches, sorted by score descending then id (a deterministic tie-break so
 * two runs against the same catalog always report the same order).
 */
export function scoutSkill(query: string, catalog: readonly CatalogEntry[], options: ScoutOptions = {}): ScoutResult {
  const use = options.threshold?.use ?? SCOUT_USE_THRESHOLD;
  const fork = options.threshold?.fork ?? SCOUT_FORK_THRESHOLD;

  const scored = rankCatalog(query, catalog);
  const matches = scored.slice(0, 5);
  const top = scored[0];
  let decision: ScoutDecision = "create";
  if (top !== undefined) {
    if (top.overlapScore >= use) decision = "use";
    else if (top.overlapScore >= fork) decision = "fork";
  }

  return { query, decision, thresholds: { use, fork }, matches };
}

// ---------------------------------------------------------------------------
// Trigger-selection grader — shared by `keryx skills eval`'s trigger-accuracy
// check and `keryx skills stocktake`'s own-trigger-routes-back check, so the
// two gates can never quietly disagree about what "this prompt selects that
// skill" means.
// ---------------------------------------------------------------------------

export interface SkillSelectionCheck {
  /** Whether `query` selects `skillId` under the rule below. */
  readonly selected: boolean;
  /** `skillId`'s own coverage score for `query` (0 when `skillId` is not in `catalog`). */
  readonly score: number;
  /** 1-based rank of `skillId` in the full (uncapped) ranking for `query`; `-1` when absent. */
  readonly rank: number;
  /** The id of a different-CATEGORY entry that strictly outscored `skillId`, when one exists — the reason a query failed to select it. */
  readonly outrankedBy?: string;
}

/**
 * Whether `query` selects `skillId`, GRADER RULE (flow 309, T12):
 *
 *   score(skillId, query) >= SCOUT_FORK_THRESHOLD
 *   AND no entry from a DIFFERENT category strictly outscores skillId.
 *
 * Why not "must be the outright top-1 match, score >= SCOUT_USE_THRESHOLD"
 * (the original rule): `SCOUT_USE_THRESHOLD` is calibrated for "does this
 * query cover the WHOLE skill" (scout's own use/fork/create decision) — a
 * much higher bar than "does this short trigger phrase route to the right
 * skill", which the eval/stocktake gates actually need. And strict top-1 is
 * not a sound target at all under IDF-weighted coverage scoring: a query
 * that reduces to one very common token (e.g. "ui review" tokenizes to just
 * {"review"} once the 2-char "ui" is dropped by the shared tokenizer's
 * min-length filter) legitimately ties EVERY entry that mentions "review" at
 * full coverage (1.0) — there is no principled way to rank one of twenty
 * ties "first" by score alone, and picking one by alphabetical accident
 * (the deterministic tie-break `rankCatalog` needs for a STABLE top-5
 * display) is not a meaningful trigger-accuracy signal.
 *
 * The category-family comparison is: a near-duplicate skill in the SAME
 * category tying or narrowly beating skillId (e.g. `review-frontend` vs.
 * `review-backend` on a query that only says "review") is exactly the
 * ambiguity a human is expected to resolve from the surrounding categories
 * shown to them — not a trigger defect. A DIFFERENT-category entry
 * outscoring skillId (a `quality/*` or `orchestration/*` skill beating a
 * `review/*` one) is the real false-negative signal: the query's own words
 * point somewhere else entirely.
 */
export function checkSkillSelected(query: string, skillId: string, catalog: readonly CatalogEntry[], options: ScoutOptions = {}): SkillSelectionCheck {
  const fork = options.threshold?.fork ?? SCOUT_FORK_THRESHOLD;
  const ranked = rankCatalog(query, catalog, options.field ?? "full");
  const index = ranked.findIndex((match) => match.skillId === skillId);
  if (index === -1) return { selected: false, score: 0, rank: -1 };

  const target = ranked[index] as ScoutMatch;
  const outranker = ranked.find((match) => match.category !== target.category && match.overlapScore > target.overlapScore);
  const selected = target.overlapScore >= fork && outranker === undefined;
  return {
    selected,
    score: target.overlapScore,
    rank: index + 1,
    ...(outranker !== undefined ? { outrankedBy: outranker.skillId } : {}),
  };
}

/**
 * The `limit` catalog entries (excluding `skillId` itself) whose FULL text
 * scores closest to `skillId`'s own description — deterministic (ties break
 * by id), used by `eval.ts#synthesizeNegatives` (F5, flow 309 review round
 * 1) to pick "nearest neighbour" negatives instead of an arbitrary
 * alphabetical pick from other categories: a trigger-accuracy check that
 * never tries a CONFUSABLE skill as a negative cannot catch a trigger phrase
 * that is actually ambiguous between two related skills.
 */
export function nearestSkills(skillId: string, catalog: readonly CatalogEntry[], limit: number): readonly ScoutMatch[] {
  const skill = catalog.find((entry) => entry.id === skillId);
  if (skill === undefined) return [];
  const query = skill.description.length > 0 ? skill.description : skill.name;
  const ranked = rankCatalog(query, catalog, "full").filter((match) => match.skillId !== skillId);
  return ranked.slice(0, limit);
}

// ---------------------------------------------------------------------------
// Scout log (`--record <pack-dir>`)
// ---------------------------------------------------------------------------

export interface ScoutRecordEntry {
  readonly query: string;
  readonly decision: ScoutDecision;
  readonly topMatch: string | null;
  readonly recordedAt: string;
  readonly skillName: string;
  /**
   * Free-text reason a new skill is being created despite a `use`/`fork`
   * decision against an existing catalog entry — e.g. the top match is a
   * REVIEW skill (checks tests against convention) rather than an AUTHORING
   * workflow, or a generic cross-language skill with no stack-specific
   * content. Optional: a `create` decision with no competing match needs
   * none, and older records predate this field.
   *
   * POLICY (F21, flow 309 review round 1): a new skill may be created
   * freely on a `create` decision (nothing competing was found). Creating
   * one on a `use` or, especially, `fork` decision — an existing catalog
   * entry already scored close enough to be a candidate reuse — is only
   * legitimate WITH a recorded, non-empty `justification` explaining why
   * that candidate was not actually enough (scope mismatch, wrong workflow
   * shape, missing stack-specific content, …). `stack-packs.test.ts`
   * enforces this over every pack's `governance/scout.json`: every
   * non-`create` record must carry a non-empty `justification`, or the
   * pack's guard test fails.
   */
  readonly justification?: string;
}

function scoutLogPath(packDir: string): string {
  return path.join(packDir, "governance", "scout.json");
}

/** The scout log for `packDir`, `[]` when none has been recorded yet. The guard tests' entry point (W1's Lane D dispatch names this export explicitly). */
export function readScoutRecord(packDir: string): ScoutRecordEntry[] {
  const file = scoutLogPath(packDir);
  if (!existsSync(file)) return [];
  const parsed = JSON.parse(readFileSync(file, "utf8")) as ScoutRecordEntry[];
  return Array.isArray(parsed) ? parsed : [];
}

/** Append one scout run to `<packDir>/governance/scout.json`, sorted for a stable diff. */
export function recordScout(packDir: string, entry: ScoutRecordEntry): void {
  const file = scoutLogPath(packDir);
  mkdirSync(path.dirname(file), { recursive: true });
  const next = [...readScoutRecord(packDir), entry].sort(
    (a, b) => a.recordedAt.localeCompare(b.recordedAt) || a.query.localeCompare(b.query) || a.skillName.localeCompare(b.skillName),
  );
  writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`, "utf8");
}

// ---------------------------------------------------------------------------
// `--include-imports` (W4 not built yet)
// ---------------------------------------------------------------------------

export interface ScoutImportsReport {
  readonly searched: boolean;
  readonly reason: string;
}

/** Honest "not built yet" answer for `--include-imports` — W4 (bundle import) ships no imported-bundle store this workstream can search. */
export function scoutImports(): ScoutImportsReport {
  return { searched: false, reason: "no imported bundles (W4 not installed)" };
}

// ---------------------------------------------------------------------------
// `--candidate <dir>` (W8 vetting)
// ---------------------------------------------------------------------------

export interface ScoutVettingSummary {
  readonly available: boolean;
  readonly reason?: string;
  readonly summary?: { readonly findings: number; readonly bySeverity: Readonly<Record<string, number>> };
}

/**
 * Runs W8's `runHarnessAudit` over a scout candidate directory, when asked
 * (`--candidate <dir>`).
 *
 * F7 (flow 309 review round 1): `runHarnessAudit(root)` audits a PROJECT
 * root — it discovers scripts under `.claude/skills/**`/`.metaproject/skills/**`
 * relative to `root` (`discoverSkillScripts`), not files directly under an
 * arbitrary directory. Auditing the bare candidate dir itself therefore
 * scanned NOTHING (every surface `not-applicable`, `findings: 0`) and that
 * empty result was reported as `available: true` — indistinguishable from a
 * genuinely clean audit. A malicious `scripts/install.sh` in the candidate
 * never got looked at.
 *
 * The fix: stage the candidate under a throwaway temp project at
 * `<tmp>/.claude/skills/<name>/` (a plain recursive copy — this never
 * touches the caller's real project) and audit THAT root, so the "skills"
 * surface's script walk actually reaches the candidate's files. If the
 * skills surface still comes back with nothing scanned and nothing
 * unreadable (an empty candidate directory, or one with no script-extension
 * files), that is reported as `available: false` / not-applicable with a
 * reason — never as a clean pass, per the "no fake pass" rule the module
 * header above states. The temp project is removed afterward regardless of
 * outcome.
 *
 * A nonexistent or non-directory `candidateDir` is refused up front, the
 * same guard `keryx security audit-harness` itself added at its CLI layer
 * (see `src/commands/security-audit-harness.ts`'s "F5" comment).
 */
export async function scoutVetCandidate(candidateDir: string): Promise<ScoutVettingSummary> {
  const stat = existsSync(candidateDir) ? statSync(candidateDir) : undefined;
  if (stat === undefined || !stat.isDirectory()) {
    return { available: false, reason: `no such directory: ${candidateDir}` };
  }

  const skillName = path.basename(path.resolve(candidateDir)) || "candidate";
  let stagingRoot: string | undefined;
  try {
    stagingRoot = await mkdtemp(path.join(tmpdir(), "keryx-scout-vet-"));
    const stagedSkillDir = path.join(stagingRoot, ".claude", "skills", skillName);
    await cp(candidateDir, stagedSkillDir, { recursive: true });

    const { runHarnessAudit } = await import("../../security/audit-harness/index");
    const report = await runHarnessAudit(stagingRoot);

    const skillsSurface = report.surfaces.find((surface) => surface.surface === "skills");
    const scannedSomething = skillsSurface !== undefined && (skillsSurface.pathsScanned.length > 0 || (skillsSurface.pathsUnreadable?.length ?? 0) > 0);
    if (!scannedSomething) {
      return {
        available: false,
        reason: "not-applicable: the candidate directory has no script files (.sh/.py/.js/.ts) for the skills surface to scan",
      };
    }

    const bySeverity: Record<string, number> = {};
    for (const finding of report.findings) {
      bySeverity[finding.severity] = (bySeverity[finding.severity] ?? 0) + 1;
    }
    return { available: true, summary: { findings: report.findings.length, bySeverity } };
  } catch (error) {
    return { available: false, reason: error instanceof Error ? error.message : String(error) };
  } finally {
    if (stagingRoot !== undefined) {
      await rm(stagingRoot, { recursive: true, force: true });
    }
  }
}
