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
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
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

// ---------------------------------------------------------------------------
// Leave-one-out trigger selection (R2-5, flow 309 review round 2): the
// `"description-only"` field above threw the baby out with the bathwater —
// it stopped a synthesized positive from trivially matching because it is
// VERBATIM present in what it's scored against, but it did so by deleting
// `triggers` from the haystack ENTIRELY, for every caller, authored prompts
// included. That means a skill's `triggers` list stopped affecting its own
// trigger-eval or stocktake-trigger outcome at all: editing, fixing, or
// removing a trigger could never change the result, and the real router
// (`scoutSkill`, `field: "full"`) never made that trade — it always scores
// triggers too. 56 of 73 bundled skills came out non-perfect under
// `"description-only"`, and a skill whose triggers legitimately route but
// whose description is thin (`python/python-testing`) picked up a false
// positive because a NEIGHBOUR's description happened to share more of the
// (triggers-excluded) vocabulary than python-testing's own did.
//
// The fix scores `field: "full"` (triggers included, matching the real
// router) but excludes ONLY the one trigger phrase a synthesized positive
// was built from — the skill's OTHER triggers, its name and its description
// all stay in its indexed text. A prompt built from trigger `t` must still
// be found by the REST of the skill's own definition, not merely because
// `t` sits verbatim inside the haystack it's being scored against.
//
// That alone reopens the door F5 closed: a bogus skill that borrows an
// entire `triggers` LIST from a real skill (not just one phrase) still has
// every OTHER borrowed trigger left in its haystack after leaving one out,
// so it can still "find itself" through a different borrowed phrase even
// though its description has nothing to do with any of them. Closing that
// requires an independent signal leave-one-out alone can't provide:
// `DESCRIPTION_SUPPORT_THRESHOLD` requires the skill's OWN name+description
// (no triggers at all, `field: "description-only"`, scored against the
// UNMODIFIED catalog) to cover at least a small fraction of the prompt's
// intent — cheap to satisfy for a real skill (whose description is, by
// definition, about what its triggers claim) and unreachable for a skill
// whose description talks about something else entirely.
// ---------------------------------------------------------------------------

/** Overlap score (field `"description-only"`, i.e. no triggers at all, from either side) at or above which a skill's OWN name+description is considered to genuinely support a trigger prompt — see the module section comment above for why leave-one-out alone is not enough to close F5/R2-5's bogus-borrowed-triggers case. */
export const DESCRIPTION_SUPPORT_THRESHOLD = 0.12;

export interface LeaveOneOutSelectionCheck extends SkillSelectionCheck {
  /** `skillId`'s `field: "description-only"` coverage score for `query`, scored against the UNMODIFIED catalog — see `DESCRIPTION_SUPPORT_THRESHOLD`. */
  readonly descriptionScore: number;
}

/** `catalog` with `excludeTrigger` removed from `skillId`'s OWN triggers list only (every other entry, and every other trigger of `skillId` itself, is untouched). */
function catalogExcludingOwnTrigger(catalog: readonly CatalogEntry[], skillId: string, excludeTrigger: string): CatalogEntry[] {
  return catalog.map((entry) => (entry.id === skillId ? { ...entry, triggers: entry.triggers.filter((trigger) => trigger !== excludeTrigger) } : entry));
}

/**
 * Whether `query` (a prompt synthesized from `skillId`'s own trigger
 * `excludeTrigger`, when given) selects `skillId` — leave-one-out over
 * `field: "full"` (R2-5, flow 309 review round 2), plus the
 * `DESCRIPTION_SUPPORT_THRESHOLD` gate described in the section comment
 * above. Pass `excludeTrigger` as `undefined` for a prompt that was not
 * built from a discrete trigger phrase (e.g. a "Use when" clause pulled from
 * the description itself) — nothing is excluded, but the description-support
 * gate still applies.
 */
export function checkSkillSelectedLeaveOneOut(
  query: string,
  skillId: string,
  catalog: readonly CatalogEntry[],
  excludeTrigger?: string,
  options: ScoutOptions = {},
): LeaveOneOutSelectionCheck {
  const reduced = excludeTrigger !== undefined ? catalogExcludingOwnTrigger(catalog, skillId, excludeTrigger) : catalog;
  const full = checkSkillSelected(query, skillId, reduced, { ...options, field: "full" });
  const descriptionOnly = checkSkillSelected(query, skillId, catalog, { ...options, field: "description-only" });
  const selected = full.selected && descriptionOnly.score >= DESCRIPTION_SUPPORT_THRESHOLD;
  return { ...full, selected, descriptionScore: descriptionOnly.score };
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
// `--include-imports` (flow 313, W4, T10) — searches
// `~/.keryx/skills/external-imports.json`, the reference-only registry
// `keryx bundle import --external` writes (`src/bundle/external.ts`).
//
// R1-F17 (flow 313 review round 1 fix): this used to read and parse the
// registry file directly, with no re-verification of a listed import's
// files — a record whose source moved, was mutated, or vanished after it
// was accepted still surfaced here as a live match. It now reuses
// `src/bundle/external.ts`'s own `readExternalImports` (registry shape +
// case-fold-sibling + integrity checks) and `verifyExternalImports`
// (per-record re-check against the files on disk) and excludes any record
// that is not currently `ok`, reporting it under `skipped` instead of
// silently dropping it. `bundle/external.ts` is imported dynamically
// (loaded only when this function actually runs, not at module load time)
// because it in turn statically imports `scoutSkill`/
// `collectSkillDirectorySnapshot`/`auditSkillSnapshot` from this file — a
// static import in both directions would be a real circular dependency.
// ---------------------------------------------------------------------------

export interface ScoutImportMatch {
  readonly name: string;
  readonly overlapScore: number;
  readonly sourceRef: string;
}

export interface ScoutImportSkipped {
  readonly name: string;
  readonly reason: string;
}

export type ScoutImportsReport =
  | {
      readonly searched: true;
      readonly reason: string;
      readonly matches: readonly ScoutImportMatch[];
      readonly skipped: readonly ScoutImportSkipped[];
    }
  | { readonly searched: false; readonly reason: string };

/**
 * Score `query` against every recorded external skill import that still
 * re-verifies as `ok` (R1-F17), using the SAME lexical scorer `scoutSkill`
 * uses. `{searched: false, reason}` when the registry is absent or corrupt —
 * never a silently empty match list for a failure that isn't "nothing
 * recorded yet".
 */
export async function scoutImports(
  query: string,
  opts: { env?: NodeJS.ProcessEnv; homeDir?: string } = {},
): Promise<ScoutImportsReport> {
  const env = opts.env ?? process.env;
  const { readExternalImports, verifyExternalImports } = await import("../../bundle/external");

  const read = await readExternalImports(env, opts.homeDir);
  if (!read.ok) {
    return { searched: false, reason: read.message };
  }

  const recorded = Object.entries(read.registry.imports);
  if (recorded.length === 0) {
    // In practice this only happens when the registry file itself is absent
    // (`readExternalImports` returns an empty registry for ENOENT):
    // `applyExternalImports` never persists a registry with zero entries.
    return { searched: false, reason: "no external skill imports recorded" };
  }

  const verify = await verifyExternalImports(env, opts.homeDir);
  if (verify.refusal !== undefined) {
    return { searched: false, reason: verify.refusal.message };
  }
  const statusByName = new Map(verify.entries.map((entry) => [entry.name, entry.status] as const));

  const skipped: ScoutImportSkipped[] = [];
  const verified = recorded.filter(([name]) => {
    const status = statusByName.get(name);
    if (status !== "ok") {
      skipped.push({ name, reason: status ?? "unresolvable" });
      return false;
    }
    return true;
  });
  skipped.sort((a, b) => a.name.localeCompare(b.name));

  if (verified.length === 0) {
    return {
      searched: true,
      reason: `searched ${recorded.length} external skill import(s); all failed re-verification`,
      matches: [],
      skipped,
    };
  }

  const asCatalog: CatalogEntry[] = verified.map(([name, record]) => ({
    id: name,
    category: "external-import",
    name,
    description: record.description,
    triggers: [],
    body: "",
    bodyLines: 0,
    sha256: "",
    path: record.sourceRef,
  }));
  const sourceRefById = new Map(verified.map(([name, record]) => [name, record.sourceRef]));

  const scored = scoutSkill(query, asCatalog);
  const matches: ScoutImportMatch[] = scored.matches.map((match) => ({
    name: match.skillId,
    overlapScore: match.overlapScore,
    sourceRef: sourceRefById.get(match.skillId) ?? "",
  }));

  return { searched: true, reason: `searched ${verified.length} external skill import(s)`, matches, skipped };
}

// ---------------------------------------------------------------------------
// Snapshot vetting (flow 313, W4 review round 1 fix — R1-F6/R1-F16/R1-F17):
// the shared "collect the candidate's files ONCE, hash that exact snapshot,
// audit that exact snapshot" primitive both `scoutVetCandidate` below
// (`skills scout --candidate`) and `src/bundle/external.ts#vetExternalCatalog`
// (W4 `bundle import --external`) now vet a skill directory through, so
// neither can hash one read of a candidate's files and audit a different,
// later read of them (R1-F17's TOCTOU).
//
// R1-F6: `runHarnessAudit`'s own project-root `skills` surface only walks
// script-extension files, so a bare `SKILL.md` (the normal Agent Skills
// shape) or a secret/injection payload hiding in a `.md`/`.txt` reference
// file was never looked at. This instead stages EVERY regular file the
// snapshot collected as an `importedBundle` entry of kind `"skill"` — see
// `src/security/audit-harness/index.ts#scanImportedBundle`'s `"skill"` case,
// which runs the full check set (secrets, injection, auto-run,
// prompt-injection-in-instructions, remote-exec) over every TEXT file
// regardless of name or extension, and fails the surface closed (reason
// `binary-content`, `pathsUnreadable`) on anything that isn't valid UTF-8
// text — never a silent skip. A markdown-only skill with nothing to flag now
// genuinely passes, instead of being rejected `audit-not-applicable` for
// having "nothing scannable".
//
// R1-F16: the depth-capped walk below fails CLOSED with a named reason
// (`too-deep`/`too-many-files`/`too-large`) instead of silently truncating —
// there is no longer a "the walk stopped early, but that reads as a clean
// pass" case to exploit.
// ---------------------------------------------------------------------------

export interface SnapshotVettingLimits {
  readonly maxFiles: number;
  readonly maxTotalBytes: number;
  readonly maxDepth: number;
}

/** Generous for a single skill directory (never a whole bundle/archive, which has its own, larger caps — R1-F10 is `src/bundle/archive.ts`'s to fix). */
export const DEFAULT_SNAPSHOT_VETTING_LIMITS: SnapshotVettingLimits = {
  maxFiles: 2000,
  maxTotalBytes: 50 * 1024 * 1024,
  maxDepth: 20,
};

/**
 * R2-F13 follow-up (flow 313 review round 2 fix): `"unreadable-file"` and
 * `"unreadable-dir"` are named, fail-closed reasons for a read error the
 * walk previously either let escape uncaught (a `readFile` failure on one
 * file used to reject the whole `collectSkillDirectorySnapshot` promise,
 * which crashed an ENTIRE vetting batch in `vetExternalCatalog` rather than
 * rejecting just that one candidate) or swallowed silently (a `readdir`
 * failure on a subdirectory used to be treated as "nothing more to add
 * here", so a partially-unreadable candidate could still read as a clean,
 * fully-scanned pass). `"special-file-refused"` names an entry that is
 * neither a symlink, a directory, nor a regular file (a FIFO, socket, or
 * device node) — previously silently skipped by `!entryStat.isFile()`.
 */
export type SnapshotCollectFailureReason =
  | "symlink-refused"
  | "too-many-files"
  | "too-large"
  | "too-deep"
  | "unreadable-file"
  | "unreadable-dir"
  | "special-file-refused";

export type SnapshotCollectResult =
  | { readonly ok: true; readonly files: ReadonlyMap<string, Buffer> }
  | { readonly ok: false; readonly reason: SnapshotCollectFailureReason; readonly message: string };

/**
 * Read-only `lstat`-based walk of `dir`: refuses a symlink anywhere — the
 * directory itself, or any file/directory under it at any depth (`lstat`,
 * never `stat`, so a symlinked entry is caught by its OWN type, not by
 * following it) — and enforces `limits` with a named reason rather than an
 * unbounded read or a silent depth truncation. Every regular file's exact
 * bytes are read exactly once into the returned map.
 */
export async function collectSkillDirectorySnapshot(
  dir: string,
  limits: SnapshotVettingLimits = DEFAULT_SNAPSHOT_VETTING_LIMITS,
): Promise<SnapshotCollectResult> {
  let rootStat;
  try {
    rootStat = await lstat(dir);
  } catch (error) {
    return { ok: false, reason: "unreadable-dir", message: `cannot read ${dir}: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (rootStat.isSymbolicLink()) {
    return { ok: false, reason: "symlink-refused", message: `${dir} is a symlink` };
  }

  const files = new Map<string, Buffer>();
  let totalBytes = 0;

  async function walk(absDir: string, relPrefix: string, depth: number): Promise<SnapshotCollectResult | undefined> {
    if (depth > limits.maxDepth) {
      return {
        ok: false,
        reason: "too-deep",
        message: `${relPrefix.length > 0 ? relPrefix : "."} exceeds the maximum directory depth of ${limits.maxDepth}`,
      };
    }
    let entries;
    try {
      entries = await readdir(absDir, { withFileTypes: true });
    } catch (error) {
      // R2-F13: an unreadable directory (EACCES, or one that vanished
      // between the parent's `readdir` and this one) used to be treated as
      // "nothing more to add here" — silently degrading the scan rather
      // than refusing it. A partially-scanned candidate must never read as
      // indistinguishable from a genuinely complete one.
      return {
        ok: false,
        reason: "unreadable-dir",
        message: `cannot read ${relPrefix.length > 0 ? relPrefix : "."}: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const abs = path.join(absDir, entry.name);
      const rel = relPrefix.length > 0 ? `${relPrefix}/${entry.name}` : entry.name;
      let entryStat;
      try {
        entryStat = await lstat(abs);
      } catch (error) {
        return { ok: false, reason: "unreadable-file", message: `cannot stat ${rel}: ${error instanceof Error ? error.message : String(error)}` };
      }
      if (entryStat.isSymbolicLink()) {
        return { ok: false, reason: "symlink-refused", message: `${rel} is a symlink` };
      }
      if (entryStat.isDirectory()) {
        const failure = await walk(abs, rel, depth + 1);
        if (failure !== undefined) return failure;
        continue;
      }
      if (!entryStat.isFile()) {
        // R2-F13: a FIFO, socket, or device node used to be silently
        // skipped (`!entryStat.isFile()` -> `continue`) rather than
        // refused — an unusual entry that isn't a plain file or directory
        // is exactly the kind of thing a vetting walk should name and stop
        // on, not quietly pretend was never there.
        return { ok: false, reason: "special-file-refused", message: `${rel} is not a regular file or directory` };
      }
      if (files.size >= limits.maxFiles) {
        return { ok: false, reason: "too-many-files", message: `${dir} has more than ${limits.maxFiles} files` };
      }
      totalBytes += entryStat.size;
      if (totalBytes > limits.maxTotalBytes) {
        return { ok: false, reason: "too-large", message: `${dir} exceeds ${limits.maxTotalBytes} total bytes` };
      }
      // R2-F13: an unreadable file (EACCES, or a permission bit flipped
      // mid-walk) used to reject `readFile`'s promise uncaught — which
      // propagated all the way out of `collectSkillDirectorySnapshot` and
      // crashed the ENTIRE batch it was part of in `vetExternalCatalog`
      // (one bad candidate took every other candidate in the same catalog
      // down with it). It is now a named per-candidate rejection instead;
      // `vetExternalCatalog`'s `for (const dir of dirs)` loop continues to
      // the next candidate exactly as it already does for any other
      // `!snapshot.ok` reason.
      let bytes: Buffer;
      try {
        bytes = await readFile(abs);
      } catch (error) {
        return { ok: false, reason: "unreadable-file", message: `cannot read ${rel}: ${error instanceof Error ? error.message : String(error)}` };
      }
      files.set(rel, bytes);
    }
    return undefined;
  }

  const failure = await walk(dir, "", 0);
  if (failure !== undefined) return failure;
  return { ok: true, files };
}

export type SnapshotAuditResult =
  | { readonly ok: true; readonly gate: "pass" | "fail"; readonly findings: number; readonly bySeverity: Readonly<Record<string, number>> }
  | { readonly ok: false; readonly reason: string };

/**
 * Stages `files` (as `collectSkillDirectorySnapshot` produced them — the
 * SAME bytes, never re-read from `dir`) into a fresh temp directory and runs
 * `runHarnessAudit` over it with every entry declared `importedBundle` kind
 * `"skill"` (the cross-lane contract, flow 313 W4 review round 1 fix). A
 * caller must see `ok: true` before trusting `gate`/`findings` at all: `ok:
 * false` covers an empty snapshot, an `imported-bundles` surface that didn't
 * report `"scanned"`, any unreadable path (including a binary file, reason
 * `binary-content`) or a coverage reason naming that surface — every one of
 * those used to read as indistinguishable from a genuinely clean pass
 * (R1-F6/R1-F16).
 */
export async function auditSkillSnapshot(files: ReadonlyMap<string, Buffer>): Promise<SnapshotAuditResult> {
  if (files.size === 0) {
    return { ok: false, reason: "audit-not-applicable: the candidate has no files to scan" };
  }

  // R2-I2 follow-up (flow 313 review round 2, L2 hardening): `files`'
  // relative paths were collected from `dir` via an `lstat`-based walk that
  // never case-folds — correct on a case-SENSITIVE source (two distinct
  // entries `a.md`/`A.md` are two distinct real files there). Staging them
  // under `tmpdir()` is only safe if the staging filesystem is equally
  // case-sensitive; on a case-INSENSITIVE one (the common case on macOS,
  // where this whole tool also runs), the second `writeFile` below would
  // silently land on the SAME path as the first, so only one of the two
  // files' actual bytes ever reaches the audit even though both are
  // separately hashed into the registry — a blind spot, not caught by any
  // later check. Refused up front by name rather than staged and silently
  // miscounted.
  const caseFoldCollisions = new Map<string, string[]>();
  for (const rel of files.keys()) {
    const folded = rel.normalize("NFC").toLowerCase();
    const existing = caseFoldCollisions.get(folded);
    if (existing !== undefined) existing.push(rel);
    else caseFoldCollisions.set(folded, [rel]);
  }
  const collidingPaths = [...caseFoldCollisions.values()].filter((group) => group.length > 1).flat().sort();
  if (collidingPaths.length > 0) {
    return { ok: false, reason: `case-fold collision: ${collidingPaths.join(", ")} would collide when staged on a case-insensitive filesystem` };
  }

  let stagingRoot: string | undefined;
  try {
    stagingRoot = await mkdtemp(path.join(tmpdir(), "keryx-skill-vet-"));
    const entries: { path: string; kind: "skill" }[] = [];
    for (const [rel, bytes] of files) {
      const abs = path.join(stagingRoot, rel);
      await mkdir(path.dirname(abs), { recursive: true });
      await writeFile(abs, bytes);
      entries.push({ path: rel, kind: "skill" });
    }

    const { runHarnessAudit, auditGate } = await import("../../security/audit-harness/index");
    const report = await runHarnessAudit(stagingRoot, { importedBundle: { entries } });

    const surface = report.surfaces.find((s) => s.surface === "imported-bundles");
    if (surface === undefined || surface.status !== "scanned") {
      return { ok: false, reason: surface?.error ?? "audit-not-applicable: the imported-bundles surface did not report a clean scan" };
    }
    if ((surface.pathsUnreadable?.length ?? 0) > 0) {
      return { ok: false, reason: `unreadable file(s): ${(surface.pathsUnreadable ?? []).join(", ")}` };
    }
    const coverageReasons = (report.coverage.reasons ?? []).filter((r) => r.includes("imported-bundles"));
    if (coverageReasons.length > 0) {
      return { ok: false, reason: coverageReasons.join("; ") };
    }

    const bundleFindings = report.findings.filter((f) => f.surface === "imported-bundles");
    const bySeverity: Record<string, number> = {};
    for (const finding of bundleFindings) {
      bySeverity[finding.severity] = (bySeverity[finding.severity] ?? 0) + 1;
    }
    return { ok: true, gate: auditGate(report), findings: bundleFindings.length, bySeverity };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  } finally {
    if (stagingRoot !== undefined) {
      await rm(stagingRoot, { recursive: true, force: true });
    }
  }
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
 * Runs the shared snapshot vetting above over a scout candidate directory,
 * when asked (`--candidate <dir>`).
 *
 * F7 (flow 309 review round 1): `runHarnessAudit(root)` audits a PROJECT
 * root, not an arbitrary directory — auditing the bare candidate dir
 * directly used to scan nothing and read back as a fake clean pass. R1-F6/
 * R1-F16 (flow 313 review round 1): the original fix for F7 (stage under
 * `.claude/skills/<name>/` and let the `skills` surface's own script-only
 * walk find it) still only ever looked at script-extension files and still
 * treated "nothing scanned" as `not-applicable` rather than a name reason
 * distinguishable from every other kind of empty/partial scan — this now
 * goes through `collectSkillDirectorySnapshot`/`auditSkillSnapshot`
 * instead, so a markdown-only skill is genuinely scanned (and accepted when
 * clean), a symlink or an over-limit directory is refused by name rather
 * than silently degrading the scan, and the same bytes that get hashed
 * elsewhere are the ones actually audited.
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

  const snapshot = await collectSkillDirectorySnapshot(candidateDir);
  if (!snapshot.ok) {
    return { available: false, reason: `${snapshot.reason}: ${snapshot.message}` };
  }
  if (snapshot.files.size === 0) {
    return { available: false, reason: "not-applicable: the candidate directory has no files for the skills surface to scan" };
  }

  const audited = await auditSkillSnapshot(snapshot.files);
  if (!audited.ok) {
    return { available: false, reason: audited.reason };
  }
  return { available: true, summary: { findings: audited.findings, bySeverity: audited.bySeverity } };
}
