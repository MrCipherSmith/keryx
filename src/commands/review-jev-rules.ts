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
import { cacheKeyFor, cachedProbability, readJevRulesCache, writeJevRulesCache } from "../review/jev-rules-cache";
import {
  DEFAULT_JEV_RULES_THRESHOLD,
  DEFAULT_MAX_JEV_RULE_CALLS,
  batchAllRulePairs,
  extractRuleRationale,
  findingStats,
  isCodingConventionSkill,
  metadataScalar,
  renderJevRulesMarkdown,
  ruleQuestionKey,
  selectRuleHunkPairs,
  synthesizeFindingsFromViolations,
  type RuleNoulQuestion,
  type RuleSourceFile,
  type RuleViolationCandidate,
} from "../review/jev-rules";
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

/**
 * AC2: discover every rule source this run will check hunks against — see
 * `src/review/jev-rules.ts`'s module header for the documented, deliberately
 * narrow discovery scope and why it is narrow. `explicitPaths` (`--rules`)
 * always wins a path collision, since it is the caller's explicit override.
 */
async function discoverRuleSources(cwd: string, explicitPaths: readonly string[]): Promise<RuleSourceFile[]> {
  const discovered: RuleSourceFile[] = [];

  for (const root of [join(cwd, ".metaproject", "rules"), join(cwd, "rules")]) {
    for (const file of await walkMatching(root, [".md", ".mdc"])) {
      const text = await readIfExists(file);
      if (text === undefined) continue;
      discovered.push({ path: relative(cwd, file), kind: "project-rule", text });
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
      discovered.push({
        path: relative(cwd, skillMd),
        kind,
        text,
        declaredPaths: declaredPathsFromContent(text),
        stackRequires: parseStackRequires(extractStackRequiresField(text)),
      });
    }
  }

  const explicit: RuleSourceFile[] = [];
  for (const raw of explicitPaths) {
    const resolved = isAbsolute(raw) ? raw : join(cwd, raw);
    const stats = await stat(resolved).catch(() => undefined);
    if (stats === undefined) {
      throw new Error(`--rules path does not exist: ${raw}`);
    }
    const files = stats.isDirectory() ? await walkMatching(resolved, [".md", ".mdc"]) : [resolved];
    for (const file of files) {
      const text = await readIfExists(file);
      if (text === undefined) continue;
      explicit.push({ path: relative(cwd, file), kind: "explicit", text });
    }
  }

  const byPath = new Map<string, RuleSourceFile>();
  for (const source of discovered) byPath.set(source.path, source);
  // Explicit wins: written last, so it overwrites a discovered entry at the same path.
  for (const source of explicit) byPath.set(source.path, source);
  return [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path));
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
  readonly tokens: { readonly jevCalls: number; readonly inputTokens?: number; readonly outputTokens?: number; readonly costUsd?: number };
  readonly selection: { readonly maxCalls: number; readonly selectedPairs: number; readonly droppedPairs: number; readonly notApplicable: number };
  readonly ruleSources: readonly { readonly path: string; readonly kind: string }[];
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

/**
 * Everything past "which hunks and which rules": discovery, applicability,
 * pair selection, batching, the Jev calls (cache-aware), and finding
 * synthesis. Shared by the CLI (`runJevRules`, below) and any other adapter
 * that already has its own hunks — currently `src/tui/jev-rules-command.ts`'s
 * `/jevrules`, which runs this over the working diff with no CLI arg parsing
 * at all.
 *
 * Callers MUST have already passed the opt-in and credential gates — this
 * function makes network calls unconditionally when there is anything to
 * score.
 */
export async function computeJevRulesResult(options: JevRulesRunOptions): Promise<JevRulesComputedResult> {
  const { cwd, regions, targetLabel } = options;
  const maxCalls = options.maxCalls ?? DEFAULT_MAX_JEV_RULE_CALLS;
  const threshold = options.threshold ?? DEFAULT_JEV_RULES_THRESHOLD;
  const model = options.model ?? DEFAULT_JEV_MODEL;
  const fetchFn = options.fetchFn ?? globalThis.fetch;

  const sources = await discoverRuleSources(cwd, options.explicitRulePaths ?? []);
  const detectedStack = await detectProjectStack(cwd);
  const selection = selectRuleHunkPairs(regions, sources, detectedStack, maxCalls);
  const batches = batchAllRulePairs(selection.selected);

  const cache = await readJevRulesCache(cwd);
  const candidates: RuleViolationCandidate[] = [];
  const newCacheEntries = new Map<string, number>();
  let jevCalls = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let costUsd = 0;
  let sawUsage = false;

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
    jevCalls += 1;
    if (result.usage.input_tokens !== undefined) {
      inputTokens += result.usage.input_tokens;
      sawUsage = true;
    }
    if (result.usage.output_tokens !== undefined) {
      outputTokens += result.usage.output_tokens;
      sawUsage = true;
    }
    if (result.usage.cost !== undefined) {
      costUsd += result.usage.cost;
      sawUsage = true;
    }
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
  const summary =
    `Checked ${selection.selected.length} (hunk, rule-clause) pair(s) across ${regions.length} hunk(s) and ${sources.length} rule source(s) ` +
    `against ${targetLabel}; ${findings.length} finding(s) at/above threshold ${threshold}. ` +
    `${selection.dropped.length} pair(s) dropped by --max-calls ${selection.maxCalls}.`;

  return {
    status,
    reviewer: "review-jev-rules",
    summary,
    findings,
    stats,
    tokens: sawUsage ? { jevCalls, inputTokens, outputTokens, costUsd } : { jevCalls },
    selection: {
      maxCalls: selection.maxCalls,
      selectedPairs: selection.selected.length,
      droppedPairs: selection.dropped.length,
      notApplicable: selection.notApplicable.length,
    },
    ruleSources: sources.map((source) => ({ path: source.path, kind: source.kind })),
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
