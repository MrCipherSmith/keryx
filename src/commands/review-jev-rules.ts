// `keryx review jev-rules` — flow 330's ADAPTER. The CLIENT-zone half of the
// split every Jev-backed review mode in this repository already uses (see
// `src/review/conform-clauses.ts`'s file header, and `src/review/ci-triage.ts`):
// `src/review/jev-rules.ts` is CORE — pure, no I/O, no client import — and
// this file is where it meets the filesystem, `gh`, and
// `src/harness/decision/jev-client.ts`.
//
// Registration in `src/commands/review.ts` is one `if` branch plus one
// import — everything else lives here so flow 326's concurrent work on
// `conform-*`/`src/commands/review.ts`'s conform parts never touches this
// file, and this file never touches those.

import { readFile, readdir, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import { optionValue } from "../lib/args";
import { detectProjectStack, extractStackRequiresField, parseStackRequires } from "../review/stack";
import { hunkRegionsFromDiff } from "../review/conform-state";
import { DEFAULT_CONTEXT_LINES } from "../review/scope";
import type { ScopedRegion } from "../review/scope";
import { createFixtureConformPrPort, createGhConformPrPort, type ConformPrInfo, type ConformPrPort } from "../review/conform-pr-port";
import { readJevRulesEnabled } from "../review/jev-rules-config";
import { cacheKeyFor, cachedProbability, JEV_RULES_TAG_CACHE_PATH, readJevRulesCache, writeJevRulesCache } from "../review/jev-rules-cache";
import {
  DEFAULT_JEV_RULES_THRESHOLD,
  DEFAULT_MAX_JEV_RULE_CALLS,
  batchAllRulePairs,
  classifyRuleSourceCategory,
  extractRuleRationale,
  findingStats,
  isCodingConventionSkill,
  isPlaceholderClauseText,
  metadataScalar,
  renderJevRulesMarkdown,
  ruleQuestionKey,
  selectRuleHunkPairs,
  synthesizeFindingsFromViolations,
  type RuleNoulQuestion,
  type RuleSourceCategoryDecision,
  type RuleSourceFile,
  type RuleViolationCandidate,
  type TaggedRuleSource,
} from "../review/jev-rules";
import {
  applyClauseTags,
  buildClauseTagQuestions,
  clauseTagFromChoice,
  extractReferenceClauses,
  type ClauseTag,
  type ReferenceClause,
} from "../review/conform-clauses";
import { cachedTagsFor, hashConformDocContent, readClauseTagCache, writeClauseTagCache } from "../review/conform-tag-cache";
import {
  callJevSystemOne,
  DEFAULT_JEV_MODEL,
  resolveJevApiKey,
  type JevQuestions,
} from "../harness/decision/jev-client";

export const JEV_RULES_FLAGS = [
  "--diff",
  "--pr",
  "--scope",
  "--rules",
  "--max-calls",
  "--threshold",
  "--model",
  "--repo",
  "--fixtures",
  "--json",
];

function rejectUnknownJevRulesFlags(args: readonly string[]): void {
  const unknown = args.filter((arg) => arg.startsWith("--") && !JEV_RULES_FLAGS.includes(arg.split("=")[0]!));
  if (unknown.length > 0) {
    throw new Error(
      `Unknown option${unknown.length > 1 ? "s" : ""} for \`keryx review jev-rules\`: ${[...new Set(unknown)].join(", ")}. ` +
        `Accepted: ${JEV_RULES_FLAGS.join(", ")}.`,
    );
  }
}

function parseMaxCalls(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_MAX_JEV_RULE_CALLS;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value < 0 || String(value) !== raw.trim()) {
    throw new Error(`--max-calls must be a non-negative integer, got "${raw}".`);
  }
  return value;
}

function parseThreshold(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_JEV_RULES_THRESHOLD;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`--threshold must be a number between 0 and 1, got "${raw}".`);
  }
  return value;
}

async function readIfExists(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return undefined;
  }
}

/** Every file under `root` matching one of `suffixes` (a full basename, e.g. `"SKILL.md"`, or an extension, e.g. `".mdc"`). Never throws on a missing root. */
async function walkMatching(root: string, suffixes: readonly string[]): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      if (suffixes.some((suffix) => entry.name.endsWith(suffix))) {
        out.push(full);
      }
    }
  }
  await walk(root);
  return out.sort();
}

/** `metadata.paths` — a comma-separated glob list — from a rule/skill's frontmatter. Same shape `src/review/reviewers.ts`'s `metadataList` reads for a project reviewer, duplicated in `metadataScalar`'s minimal form rather than imported: that helper reads a LIST field and is not exported. */
function declaredPathsFromContent(content: string): string[] {
  const raw = metadataScalar(content, "paths");
  if (raw === undefined) return [];
  return raw
    .replace(/^["'[]|["'\]]$/g, "")
    .split(",")
    .map((entry) => entry.trim().replace(/^["']|["']$/g, ""))
    .filter((entry) => entry.length > 0);
}

export interface ExcludedRuleSource {
  readonly path: string;
  readonly kind: string;
  readonly reason: string;
}

export interface RuleSourceDiscovery {
  readonly sources: readonly RuleSourceFile[];
  /** Category-filtered out (AC-follow-up 2) — reported, never silently absent. A `--rules` entry naming ONE FILE explicitly is never excluded here; a `--rules` DIRECTORY's discovered files can be (see the merge below). */
  readonly excluded: readonly ExcludedRuleSource[];
}

/** One rule source together with `classifyRuleSourceCategory`'s decision for it — carried alongside the `RuleSourceFile` (which only keeps the `category` enum) so the filter below can report the human-readable reason without reclassifying. */
interface ClassifiedSource {
  readonly file: RuleSourceFile;
  readonly decision: RuleSourceCategoryDecision;
}

function classify(file: Omit<RuleSourceFile, "category">): ClassifiedSource {
  const decision = classifyRuleSourceCategory(file.path, file.text);
  return { file: { ...file, category: decision.category }, decision };
}

/**
 * AC2: discover every rule source this run will check hunks against — see
 * `src/review/jev-rules.ts`'s module header for the documented, deliberately
 * narrow discovery scope and why it is narrow.
 *
 * `--rules` bypass, precisely scoped (fix for the live re-measurement's
 * finding (a) — every source under a `--rules` DIRECTORY used to bypass the
 * category filter below unconditionally, so an entire 41-doc process/docs
 * corpus passed via `--rules .metaproject/rules` skipped filtering outright):
 * only a `--rules` entry that names ONE FILE explicitly bypasses the filter
 * — the operator picked that exact document, full stop. A `--rules`
 * DIRECTORY is walked and its files are filtered exactly like
 * `.metaproject/rules/**`/`rules/**` auto-discovery — asking for a whole
 * directory is not the same as naming one document.
 */
async function discoverRuleSources(cwd: string, explicitPaths: readonly string[]): Promise<RuleSourceDiscovery> {
  const discovered: ClassifiedSource[] = [];

  for (const root of [join(cwd, ".metaproject", "rules"), join(cwd, "rules")]) {
    for (const file of await walkMatching(root, [".md", ".mdc"])) {
      const text = await readIfExists(file);
      if (text === undefined) continue;
      discovered.push(classify({ path: relative(cwd, file), kind: "project-rule", text }));
    }
  }

  const skillRoots: ReadonlyArray<readonly [string, RuleSourceFile["kind"]]> = [
    [join(cwd, ".metaproject", "project-skills"), "project-skill"],
    [join(cwd, ".metaproject", "skills", "gdskills"), "gdskill"],
  ];
  for (const [root, kind] of skillRoots) {
    for (const skillMd of await walkMatching(root, ["SKILL.md"])) {
      // Never review-jev-rules' own SKILL.md as a rule source — circular, and it
      // would always trivially "apply" to itself.
      if (basename(dirname(skillMd)) === "review-jev-rules") continue;
      const text = await readIfExists(skillMd);
      if (text === undefined) continue;
      const name = basename(dirname(skillMd));
      const decision = isCodingConventionSkill(name, text);
      if (!decision.matches) continue;
      discovered.push(
        classify({
          path: relative(cwd, skillMd),
          kind,
          text,
          declaredPaths: declaredPathsFromContent(text),
          stackRequires: parseStackRequires(extractStackRequiresField(text)),
        }),
      );
    }
  }

  // `explicitFiles`: a `--rules` entry naming ONE file — always bypasses the
  // category filter below. `explicitDirSources`: files WALKED from a
  // `--rules` DIRECTORY — subject to the same filter as any other discovered
  // source (the fix).
  const explicitFiles: ClassifiedSource[] = [];
  const explicitDirSources: ClassifiedSource[] = [];
  for (const raw of explicitPaths) {
    const resolved = isAbsolute(raw) ? raw : join(cwd, raw);
    const stats = await stat(resolved).catch(() => undefined);
    if (stats === undefined) {
      throw new Error(`--rules path does not exist: ${raw}`);
    }
    if (stats.isDirectory()) {
      for (const file of await walkMatching(resolved, [".md", ".mdc"])) {
        const text = await readIfExists(file);
        if (text === undefined) continue;
        explicitDirSources.push(classify({ path: relative(cwd, file), kind: "explicit", text }));
      }
      continue;
    }
    const text = await readIfExists(resolved);
    if (text === undefined) continue;
    explicitFiles.push(classify({ path: relative(cwd, resolved), kind: "explicit", text }));
  }

  // AC-follow-up 2 (scoped by the fix above): a `discovered` OR
  // `explicitDirSources` entry classified `process`/`docs` is excluded from
  // pairing here, so it never reaches tagging or violation scoring at all. A
  // literal `explicitFiles` entry bypasses this outright — added to `byPath`
  // unconditionally below, so it always wins even when it would otherwise be
  // filtered, and even when a directory walk also discovered it (the
  // explicit single-file naming wins the collision).
  const explicitFilePathSet = new Set(explicitFiles.map((entry) => entry.file.path));
  const excluded: ExcludedRuleSource[] = [];
  const filteredDiscovered: RuleSourceFile[] = [];
  for (const { file, decision } of [...discovered, ...explicitDirSources]) {
    if (explicitFilePathSet.has(file.path)) {
      filteredDiscovered.push(file);
      continue;
    }
    if (decision.category !== "code") {
      excluded.push({ path: file.path, kind: file.kind, reason: decision.reason });
      continue;
    }
    filteredDiscovered.push(file);
  }

  const byPath = new Map<string, RuleSourceFile>();
  for (const source of filteredDiscovered) byPath.set(source.path, source);
  // Explicit file wins: written last, so it overwrites any collision.
  for (const { file } of explicitFiles) byPath.set(file.path, file);
  return { sources: [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path)), excluded: excluded.sort((a, b) => a.path.localeCompare(b.path)) };
}

async function fixturePrPort(dir: string): Promise<ConformPrPort> {
  const raw = await readFile(join(dir, "pr.json"), "utf8");
  return createFixtureConformPrPort({ pr: JSON.parse(raw) as ConformPrInfo });
}

/**
 * `--fixtures <dir>/jev-responses.json`: a JSON ARRAY, one canned `/systemone`
 * response body per Jev call this run will make, consumed in call order. No
 * network, no `OPENROUTER_API_KEY` read (the credential gate still runs
 * first — a fixture run still needs a fake or real key on purpose, so a test
 * exercises the same gate the live path does).
 */
async function fixtureJevFetch(dir: string): Promise<typeof fetch> {
  const raw = await readFile(join(dir, "jev-responses.json"), "utf8");
  const responses = JSON.parse(raw) as unknown[];
  let index = 0;
  const fn = async (): Promise<Response> => {
    if (index >= responses.length) {
      throw new Error(`fixture jev-responses.json has only ${responses.length} response(s); a call beyond that was made.`);
    }
    const body = JSON.stringify(responses[index]);
    index += 1;
    return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
  };
  return fn as unknown as typeof fetch;
}

export interface JevRulesComputedResult {
  readonly status: "DONE" | "DONE_WITH_CONCERNS";
  readonly reviewer: "review-jev-rules";
  readonly summary: string;
  readonly findings: ReturnType<typeof synthesizeFindingsFromViolations>;
  readonly stats: ReturnType<typeof findingStats>;
  readonly tokens: {
    readonly jevCalls: number;
    /** One-time-per-doc-content clause-tagging calls (AC-follow-up 1) — cached next run by `./conform-tag-cache.ts`. */
    readonly taggingCalls: number;
    /** The `noul` violation-scoring calls — what AC9's live check originally measured in full. */
    readonly violationCalls: number;
    readonly inputTokens?: number;
    readonly outputTokens?: number;
    readonly costUsd?: number;
  };
  readonly selection: {
    readonly maxCalls: number;
    readonly selectedPairs: number;
    readonly droppedPairs: number;
    readonly notApplicable: number;
    /** Count of (ruleId, clauseId) pairs excluded because the clause is not tagged `state_kind: "hunk"` and `checkable` — full ids in `droppedClauses` below. */
    readonly droppedClauses: number;
    /** Item 2: one entry per hunk with at least one applicable pair, `{path, startLine, endLine, applicablePairs, selectedPairs}` each, in the round-robin allocator's own priority order (code, then tests, then docs). */
    readonly hunkCoverage: ReturnType<typeof selectRuleHunkPairs>["hunkCoverage"];
    /** `hunkCoverage.length` — how many hunks had at least one applicable pair to check. */
    readonly hunksWithPairs: number;
    /** How many of `hunkCoverage`'s hunks actually got at least one pair scored. */
    readonly hunksReached: number;
    /** `hunksWithPairs - hunksReached` — hunks the `--max-calls` budget never reached, named directly rather than left for a reader to compute. */
    readonly hunksNeverReached: number;
  };
  readonly ruleSources: readonly { readonly path: string; readonly kind: string; readonly category?: string }[];
  /** AC-follow-up 2: rule sources classified `process`/`docs` by the category filter and excluded before clause extraction — reported with the reason, never silently. */
  readonly excludedSources: readonly ExcludedRuleSource[];
  /** AC-follow-up 1: every (ruleId, clauseId) dropped by the tag-based filter, with why — the full detail behind `selection.droppedClauses`'s count. */
  readonly droppedClauses: readonly { readonly ruleId: string; readonly clauseId: string; readonly reason: string }[];
  /** Item 3: every (ruleId, clauseId) dropped as authoring-template scaffolding (`isPlaceholderClauseText`) before it ever reached tagging or pairing. */
  readonly droppedPlaceholderClauses: readonly { readonly ruleId: string; readonly clauseId: string; readonly reason: string }[];
}

export interface JevRulesRunOptions {
  readonly cwd: string;
  readonly regions: readonly ScopedRegion[];
  readonly targetLabel: string;
  readonly explicitRulePaths?: readonly string[];
  readonly maxCalls?: number;
  readonly threshold?: number;
  readonly model?: string;
  readonly fetchFn?: typeof fetch;
}

/** Shared running totals across every Jev call this run makes — tagging and violation calls counted separately (AC-follow-up 1's "tagging: N calls (cached next run)" usage line). */
interface JevUsageAccumulator {
  taggingCalls: number;
  violationCalls: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  sawUsage: boolean;
}

function accumulateUsage(acc: JevUsageAccumulator, usage: { input_tokens?: number; output_tokens?: number; cost?: number }): void {
  if (usage.input_tokens !== undefined) {
    acc.inputTokens += usage.input_tokens;
    acc.sawUsage = true;
  }
  if (usage.output_tokens !== undefined) {
    acc.outputTokens += usage.output_tokens;
    acc.sawUsage = true;
  }
  if (usage.cost !== undefined) {
    acc.costUsd += usage.cost;
    acc.sawUsage = true;
  }
}

interface ClauseTagResolution {
  readonly clauses: readonly ReferenceClause[];
  /** Item 3: every clause dropped as authoring-template scaffolding, BEFORE tagging — a placeholder clause never costs a tagging call either. */
  readonly droppedPlaceholders: readonly { readonly clauseId: string; readonly reason: string }[];
}

/**
 * AC-follow-up 1: resolve one rule source's clauses to their FULL tags —
 * `state_kind`/`checkable` — by REUSING `../review/conform-clauses.ts`'s
 * `applyClauseTags`/`buildClauseTagQuestions`/`clauseTagFromChoice` and
 * `../review/conform-tag-cache.ts`'s cache read/write, exactly the shape
 * `src/commands/review.ts`'s `resolveConformClauseTags` already established
 * for `review conform` — but writing to `JEV_RULES_TAG_CACHE_PATH`, a
 * jev-rules-specific cache file, so the two reviewers never race on the same
 * cache file on disk. One Jev `choice` call per doc's UNTAGGED clauses (never
 * per clause), and only when neither an explicit `[state:...]` marker nor a
 * cached tag already answers it — the "tagging calls are one-time per doc
 * content, cached next run" guarantee.
 *
 * Item 3: `isPlaceholderClauseText` (core, pure) drops authoring-template
 * scaffolding — `[x] <criterion 1> — verified by <test>` and the like — right
 * after extraction, BEFORE it is ever offered a tagging call.
 */
async function resolveRuleSourceClauseTags(cwd: string, source: RuleSourceFile, fetchFn: typeof fetch, model: string, usage: JevUsageAccumulator): Promise<ClauseTagResolution> {
  const extracted = extractReferenceClauses(source.text);
  const rawClauses = extracted.filter((clause) => !isPlaceholderClauseText(clause.text));
  const droppedPlaceholders = extracted
    .filter((clause) => isPlaceholderClauseText(clause.text))
    .map((clause) => ({ clauseId: clause.clause_id, reason: "placeholder/template text (unfilled `<...>` or checklist scaffolding), never a real rule clause" }));

  const contentHash = hashConformDocContent(source.text);
  const cache = await readClauseTagCache(cwd, JEV_RULES_TAG_CACHE_PATH);
  const cachedTags = cachedTagsFor(cache, source.path, contentHash) ?? {};
  const resolved = new Map<string, { source: "jev" | "cache"; tag: ClauseTag }>();
  for (const [id, tag] of Object.entries(cachedTags)) resolved.set(id, { source: "cache", tag });

  const needsTagging = rawClauses.filter((clause) => clause.explicit === undefined && cachedTags[clause.clause_id] === undefined);
  const tagQuestions = buildClauseTagQuestions(needsTagging);
  if (Object.keys(tagQuestions).length > 0) {
    const result = await callJevSystemOne(
      fetchFn,
      { model, state: `Rule-document clause classification (review-jev-rules): "${source.path}" — no additional state beyond each clause's own text.`, questions: tagQuestions },
      { env: process.env },
    );
    usage.taggingCalls += 1;
    accumulateUsage(usage, result.usage);
    const freshTags: Record<string, ClauseTag> = {};
    for (const [id, answer] of Object.entries(result.answers)) {
      if (answer.type !== "choice") continue;
      const tag = clauseTagFromChoice(answer.choice);
      resolved.set(id, { source: "jev", tag });
      freshTags[id] = tag;
    }
    if (Object.keys(freshTags).length > 0) {
      await writeClauseTagCache(cwd, source.path, contentHash, freshTags, JEV_RULES_TAG_CACHE_PATH);
    }
  }
  return { clauses: applyClauseTags(rawClauses, resolved), droppedPlaceholders };
}

/**
 * Everything past "which hunks and which rules": discovery (with the
 * category filter), clause tagging (with the tag-cache), applicability, pair
 * selection, batching, the violation-scoring Jev calls (cache-aware), and
 * finding synthesis. Shared by the CLI (`runJevRules`, below) and any other
 * adapter that already has its own hunks — currently
 * `src/tui/jev-rules-command.ts`'s `/jevrules`, which runs this over the
 * working diff with no CLI arg parsing at all.
 *
 * Callers MUST have already passed the opt-in and credential gates — this
 * function makes network calls unconditionally when there is anything to
 * tag or score.
 */
export async function computeJevRulesResult(options: JevRulesRunOptions): Promise<JevRulesComputedResult> {
  const { cwd, regions, targetLabel } = options;
  const maxCalls = options.maxCalls ?? DEFAULT_MAX_JEV_RULE_CALLS;
  const threshold = options.threshold ?? DEFAULT_JEV_RULES_THRESHOLD;
  const model = options.model ?? DEFAULT_JEV_MODEL;
  const fetchFn = options.fetchFn ?? globalThis.fetch;

  const { sources, excluded } = await discoverRuleSources(cwd, options.explicitRulePaths ?? []);
  const detectedStack = await detectProjectStack(cwd);

  const usage: JevUsageAccumulator = { taggingCalls: 0, violationCalls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, sawUsage: false };
  const taggedSources: TaggedRuleSource[] = [];
  const droppedPlaceholderClauses: { ruleId: string; clauseId: string; reason: string }[] = [];
  for (const source of sources) {
    const { clauses, droppedPlaceholders } = await resolveRuleSourceClauseTags(cwd, source, fetchFn, model, usage);
    taggedSources.push({ source, clauses });
    for (const dropped of droppedPlaceholders) {
      droppedPlaceholderClauses.push({ ruleId: source.path, clauseId: dropped.clauseId, reason: dropped.reason });
    }
  }

  const selection = selectRuleHunkPairs(regions, taggedSources, detectedStack, maxCalls);
  const batches = batchAllRulePairs(selection.selected);

  const cache = await readJevRulesCache(cwd);
  const candidates: RuleViolationCandidate[] = [];
  const newCacheEntries = new Map<string, number>();

  for (const batch of batches) {
    const uncachedQuestions: Record<string, RuleNoulQuestion> = {};
    const cacheKeyByQuestionKey = new Map<string, string>();
    for (const item of batch.items) {
      const cacheKey = cacheKeyFor(item.ruleId, item.clause.clause_id, item.region.path, item.region.startLine, item.region.endLine, item.clause.text);
      const cached = cachedProbability(cache, cacheKey);
      const questionKey = ruleQuestionKey(item.ruleId, item.clause.clause_id);
      if (cached !== undefined) {
        candidates.push({ region: item.region, ruleId: item.ruleId, clause: item.clause, probability: cached });
        continue;
      }
      const question = batch.questions[questionKey];
      if (question === undefined) continue;
      uncachedQuestions[questionKey] = question;
      cacheKeyByQuestionKey.set(questionKey, cacheKey);
    }
    if (Object.keys(uncachedQuestions).length === 0) continue;

    const result = await callJevSystemOne(fetchFn, { model, state: batch.state, questions: uncachedQuestions as JevQuestions }, { env: process.env });
    usage.violationCalls += 1;
    accumulateUsage(usage, result.usage);
    for (const item of batch.items) {
      const questionKey = ruleQuestionKey(item.ruleId, item.clause.clause_id);
      if (!(questionKey in uncachedQuestions)) continue;
      const answer = result.answers[questionKey];
      if (answer === undefined || answer.type !== "noul") continue;
      candidates.push({ region: item.region, ruleId: item.ruleId, clause: item.clause, probability: answer.noul });
      const cacheKey = cacheKeyByQuestionKey.get(questionKey);
      if (cacheKey !== undefined) newCacheEntries.set(cacheKey, answer.noul);
    }
  }

  await writeJevRulesCache(cwd, newCacheEntries).catch(() => {});

  const ruleRationales = new Map<string, string>();
  for (const source of sources) {
    const rationale = extractRuleRationale(source.text);
    if (rationale !== undefined) ruleRationales.set(source.path, rationale);
  }

  const findings = synthesizeFindingsFromViolations(candidates, threshold, ruleRationales);
  const stats = findingStats(findings);
  const status = stats.blocker > 0 || stats.major > 0 ? "DONE_WITH_CONCERNS" : "DONE";
  const jevCalls = usage.taggingCalls + usage.violationCalls;
  const hunksNeverReached = selection.hunkCoverage.length - selection.hunksReached;
  const summary =
    `Checked ${selection.selected.length} (hunk, rule-clause) pair(s) across ${regions.length} hunk(s) and ${sources.length} rule source(s) ` +
    `(${excluded.length} source(s) excluded by category filter) against ${targetLabel}; ${findings.length} finding(s) at/above threshold ${threshold}. ` +
    `${selection.dropped.length} pair(s) dropped by --max-calls ${selection.maxCalls}; ${selection.droppedClauses.length} clause(s) dropped as not hunk-checkable; ` +
    `${droppedPlaceholderClauses.length} clause(s) dropped as placeholder/template text. ` +
    `${selection.hunkCoverage.length} of ${regions.length} hunk(s) had an applicable pair; ${selection.hunksReached} reached by the budget, ${hunksNeverReached} never reached. ` +
    `tagging: ${usage.taggingCalls} call(s) (cached next run); violation: ${usage.violationCalls} call(s).`;

  return {
    status,
    reviewer: "review-jev-rules",
    summary,
    findings,
    stats,
    tokens: usage.sawUsage
      ? { jevCalls, taggingCalls: usage.taggingCalls, violationCalls: usage.violationCalls, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, costUsd: usage.costUsd }
      : { jevCalls, taggingCalls: usage.taggingCalls, violationCalls: usage.violationCalls },
    selection: {
      maxCalls: selection.maxCalls,
      selectedPairs: selection.selected.length,
      droppedPairs: selection.dropped.length,
      notApplicable: selection.notApplicable.length,
      droppedClauses: selection.droppedClauses.length,
      hunkCoverage: selection.hunkCoverage,
      hunksWithPairs: selection.hunkCoverage.length,
      hunksReached: selection.hunksReached,
      hunksNeverReached,
    },
    ruleSources: sources.map((source) => ({ path: source.path, kind: source.kind, ...(source.category !== undefined ? { category: source.category } : {}) })),
    excludedSources: excluded,
    droppedClauses: selection.droppedClauses,
    droppedPlaceholderClauses,
  };
}

/**
 * AC6's gate, reusable by any adapter (the CLI below, and the TUI's
 * `/jevrules`): opt-in first, credential second, both before any read or
 * network call. Returns the refusal message to print/show, or `undefined`
 * when the run may proceed.
 */
export async function jevRulesGateRefusal(cwd: string): Promise<string | undefined> {
  if (!(await readJevRulesEnabled(cwd))) {
    return (
      "`review.jev.rules` is not enabled for this project (.metaproject/tasks.config.json: " +
      '`{"review":{"jev":{"rules":true}}}`). review-jev-rules sends redacted hunk text and rule-clause text to ' +
      "OpenRouter/TypeSafe, so it is opt-in — nothing was read and no network call was made."
    );
  }
  const apiKey = resolveJevApiKey(process.env);
  if (apiKey === undefined || apiKey.length === 0) {
    return (
      "OPENROUTER_API_KEY is not set, and no openrouterKey is saved in the keryx shell config: review-jev-rules " +
      "needs a Jev/OpenRouter credential and made no network call."
    );
  }
  return undefined;
}

export async function runJevRules(args: string[]): Promise<void> {
  rejectUnknownJevRulesFlags(args);
  const cwd = process.cwd();

  const diffRef = optionValue(args, "--diff");
  const prArg = optionValue(args, "--pr");
  const scopeFile = optionValue(args, "--scope");
  const provided = [diffRef, prArg, scopeFile].filter((value) => value !== undefined);
  if (provided.length !== 1) {
    throw new Error(
      "Usage: keryx review jev-rules (--diff <ref> | --pr <n> | --scope <scope.json>) [--rules <paths>] " +
        "[--max-calls N] [--threshold 0..1] [--json]",
    );
  }

  // AC6: opt-in per project, refused before any read or network call.
  const refusal = await jevRulesGateRefusal(cwd);
  if (refusal !== undefined) {
    console.error(refusal);
    process.exitCode = 1;
    return;
  }

  const fixturesDir = optionValue(args, "--fixtures");
  const model = optionValue(args, "--model") ?? DEFAULT_JEV_MODEL;
  const maxCalls = parseMaxCalls(optionValue(args, "--max-calls"));
  const threshold = parseThreshold(optionValue(args, "--threshold"));
  const explicitRulePaths = (optionValue(args, "--rules") ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  let regions: readonly ScopedRegion[];
  let targetLabel: string;
  if (scopeFile !== undefined) {
    const raw = scopeFile === "-" ? await Bun.stdin.text() : await Bun.file(scopeFile).text();
    const parsed = JSON.parse(raw) as { regions?: unknown };
    if (!Array.isArray(parsed.regions)) {
      throw new Error(`--scope ${scopeFile} carries no \`regions\` array. Pass the output of \`keryx review scope --json\`.`);
    }
    regions = parsed.regions as ScopedRegion[];
    targetLabel = `scope ${scopeFile}`;
  } else if (prArg !== undefined) {
    const number = Number(prArg);
    if (!Number.isInteger(number) || number <= 0) {
      throw new Error(`--pr must be a positive integer, got "${prArg}".`);
    }
    const port: ConformPrPort = fixturesDir === undefined ? createGhConformPrPort(undefined, optionValue(args, "--repo")) : await fixturePrPort(fixturesDir);
    const info = await port.pr(number);
    regions = hunkRegionsFromDiff(info.diff);
    targetLabel = `PR #${info.number} — ${info.title}`;
  } else {
    const diff = await gitDiffForJevRules(diffRef, DEFAULT_CONTEXT_LINES);
    regions = hunkRegionsFromDiff(diff);
    targetLabel = diffRef ?? "working diff";
  }

  const fetchFn: typeof fetch = fixturesDir === undefined ? globalThis.fetch : await fixtureJevFetch(fixturesDir);
  const result = await computeJevRulesResult({
    cwd,
    regions,
    targetLabel,
    explicitRulePaths,
    maxCalls,
    threshold,
    model,
    fetchFn,
  });

  if (args.includes("--json")) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(renderJevRulesMarkdown(result));
}

/**
 * The diff this run checks. A separate, minimal copy of
 * `src/commands/review.ts`'s own (unexported) `gitDiff` — not imported,
 * because that function lives inside the file flow 330 was told to touch
 * only additively, and duplicating four lines here costs less than widening
 * that file's export surface for one caller.
 */
async function gitDiffForJevRules(ref: string | undefined, contextLines: number): Promise<string> {
  const command = ["git", "diff", "--no-color", `-U${contextLines}`, ...(ref === undefined ? [] : [ref])];
  const proc = Bun.spawn(command, { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (exitCode !== 0) {
    throw new Error(`git diff failed (exit ${exitCode}): ${stderr.trim()}`);
  }
  return stdout;
}
