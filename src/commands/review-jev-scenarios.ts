// `keryx review jev-scenarios` — flow 332's ADAPTER, the FUNCTIONAL-review
// sibling of `review-jev-risk.ts`. Same split as every Jev-backed reviewer
// in this repository: `src/review/jev-scenarios.ts` is CORE (pure, no I/O,
// no client import) and this file is where it meets the filesystem and
// `src/harness/decision/jev-client.ts`.
//
// Registration in `src/commands/review.ts` is one `if` branch plus one
// import, mirroring flow 330's `review-jev-rules.ts` note exactly.

import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { optionValue } from "../lib/args";
import { buildReviewScope } from "../review/scope";
import { createFixtureConformPrPort, createGhConformPrPort, type ConformPrInfo, type ConformPrPort } from "../review/conform-pr-port";
import { readJevScenariosEnabled } from "../review/jev-scenarios-config";
import {
  DEFAULT_JEV_SCENARIOS_THRESHOLD,
  DEFAULT_MAX_JEV_SCENARIO_CALLS,
  batchScenarioQuestions,
  buildScenarioChecklist,
  computeScenarioFacts,
  renderScenariosMarkdown,
  scenarioFindingStats,
  scenariosFromPrd,
  scenariosFromReadmeLike,
  scenarioFromWikiPage,
  scoreScenario,
  selectScenarios,
  synthesizeScenarioFindings,
  type JevScenariosRunResult,
  type ScenarioSource,
  type ScoredScenario,
} from "../review/jev-scenarios";
import { callJevSystemOne, DEFAULT_JEV_MODEL, resolveJevApiKey, type JevQuestions } from "../harness/decision/jev-client";

export const JEV_SCENARIOS_FLAGS = ["--diff", "--pr", "--scope", "--max-calls", "--threshold", "--model", "--repo", "--fixtures", "--json"];

function rejectUnknownJevScenariosFlags(args: readonly string[]): void {
  const unknown = args.filter((arg) => arg.startsWith("--") && !JEV_SCENARIOS_FLAGS.includes(arg.split("=")[0]!));
  if (unknown.length > 0) {
    throw new Error(
      `Unknown option${unknown.length > 1 ? "s" : ""} for \`keryx review jev-scenarios\`: ${[...new Set(unknown)].join(", ")}. ` +
        `Accepted: ${JEV_SCENARIOS_FLAGS.join(", ")}.`,
    );
  }
}

function parseMaxCalls(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_MAX_JEV_SCENARIO_CALLS;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value < 0 || String(value) !== raw.trim()) {
    throw new Error(`--max-calls must be a non-negative integer, got "${raw}".`);
  }
  return value;
}

function parseThreshold(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_JEV_SCENARIOS_THRESHOLD;
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

async function walkMarkdown(root: string): Promise<string[]> {
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
      if (entry.name.endsWith(".md")) out.push(full);
    }
  }
  await walk(root);
  return out.sort();
}

/**
 * AC3's three deterministic scenario sources: gdwiki `user-scenario` pages
 * (`.metaproject/wiki/user-scenarios/**`, `WIKI_PAGE_TYPES`'s own folder for
 * that page type, `src/wiki/types.ts`), PRD requirement/scenario sections
 * (`docs/requirements/**`), and README/docs "how to" sections (`README.md`
 * plus `docs/docs/**`, this project's own docs-site tree). Never throws on a
 * missing root — a project with none of the three has zero scenarios, not a
 * failed run.
 */
async function discoverScenarioSources(cwd: string): Promise<ScenarioSource[]> {
  const scenarios: ScenarioSource[] = [];

  for (const file of await walkMarkdown(join(cwd, ".metaproject", "wiki", "user-scenarios"))) {
    const text = await readIfExists(file);
    if (text === undefined) continue;
    scenarios.push(scenarioFromWikiPage(relative(cwd, file), text));
  }

  for (const file of await walkMarkdown(join(cwd, "docs", "requirements"))) {
    const text = await readIfExists(file);
    if (text === undefined) continue;
    scenarios.push(...scenariosFromPrd(relative(cwd, file), text));
  }

  const readmeLikeFiles = [join(cwd, "README.md"), ...(await walkMarkdown(join(cwd, "docs", "docs")))];
  for (const file of readmeLikeFiles) {
    const text = await readIfExists(file);
    if (text === undefined) continue;
    scenarios.push(...scenariosFromReadmeLike(relative(cwd, file), text));
  }

  return scenarios;
}

async function fixturePrPort(dir: string): Promise<ConformPrPort> {
  const raw = await readFile(join(dir, "pr.json"), "utf8");
  return createFixtureConformPrPort({ pr: JSON.parse(raw) as ConformPrInfo });
}

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

export interface JevScenariosRunOptions {
  readonly cwd: string;
  readonly allChangedFiles: readonly string[];
  readonly targetLabel: string;
  readonly maxCalls?: number;
  readonly threshold?: number;
  readonly model?: string;
  readonly fetchFn?: typeof fetch;
  /** Injectable for tests; defaults to the real filesystem discovery above. */
  readonly discoverScenarios?: (cwd: string) => Promise<ScenarioSource[]>;
}

export interface JevScenariosComputedResult extends JevScenariosRunResult {
  readonly tokens: { readonly jevCalls: number; readonly inputTokens?: number; readonly outputTokens?: number; readonly costUsd?: number };
  readonly selection: { readonly maxCalls: number; readonly scenariosChecked: number; readonly scenariosSkipped: number; readonly notApplicable: number };
  readonly scenarioSources: readonly { readonly id: string; readonly kind: string }[];
}

/**
 * Everything past "which scenarios": discovery, applicability (touched
 * links), budget selection, batching, the Jev calls, and finding synthesis.
 * Shared by the CLI (`runJevScenarios`, below) and the TUI's `/scenarios`.
 */
export async function computeJevScenariosResult(options: JevScenariosRunOptions): Promise<JevScenariosComputedResult> {
  const { cwd, allChangedFiles, targetLabel } = options;
  const maxCalls = options.maxCalls ?? DEFAULT_MAX_JEV_SCENARIO_CALLS;
  const threshold = options.threshold ?? DEFAULT_JEV_SCENARIOS_THRESHOLD;
  const model = options.model ?? DEFAULT_JEV_MODEL;
  const fetchFn = options.fetchFn ?? globalThis.fetch;
  const discover = options.discoverScenarios ?? discoverScenarioSources;

  const scenarioSources = await discover(cwd);
  const allFacts = scenarioSources.map((scenario) => computeScenarioFacts(scenario, allChangedFiles));
  const selection = selectScenarios(allFacts, maxCalls);
  const batches = batchScenarioQuestions(selection.selected);

  const scored: ScoredScenario[] = [];
  let jevCalls = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let costUsd = 0;
  let sawUsage = false;

  for (const batch of batches) {
    const result = await callJevSystemOne(fetchFn, { model, state: batch.state, questions: batch.questions as JevQuestions }, { env: process.env });
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
      const answer = result.answers[item.scenario.id];
      scored.push(scoreScenario(item, answer !== undefined && answer.type === "noul" ? { noul: answer.noul } : undefined));
    }
  }

  const checklist = buildScenarioChecklist(scored, threshold);
  const findings = synthesizeScenarioFindings(scored, threshold);
  const stats = scenarioFindingStats(findings);
  const status = findings.length > 0 ? "DONE_WITH_CONCERNS" : "DONE";
  const summary =
    `Checked ${selection.selected.length} scenario(s) with a touched link (of ${scenarioSources.length} discovered, ` +
    `${selection.notApplicable.length} with no touched link) against ${targetLabel}; ${checklist.length} scenario(s) likely ` +
    `affected at/above threshold ${threshold}, ${findings.length} finding(s) with no covering test. ` +
    `${selection.skipped.length} scenario(s) skipped by --max-calls ${selection.maxCalls}.`;

  return {
    status,
    reviewer: "review-jev-scenarios",
    summary,
    findings,
    stats,
    checklist,
    tokens: sawUsage ? { jevCalls, inputTokens, outputTokens, costUsd } : { jevCalls },
    selection: {
      maxCalls: selection.maxCalls,
      scenariosChecked: selection.selected.length,
      scenariosSkipped: selection.skipped.length,
      notApplicable: selection.notApplicable.length,
    },
    scenarioSources: scenarioSources.map((s) => ({ id: s.id, kind: s.kind })),
  };
}

/** AC5's gate — same shape `jevRiskGateRefusal`/`jevRulesGateRefusal` use. */
export async function jevScenariosGateRefusal(cwd: string): Promise<string | undefined> {
  if (!(await readJevScenariosEnabled(cwd))) {
    return (
      "`review.jev.scenarios` is not enabled for this project (.metaproject/tasks.config.json: " +
      '`{"review":{"jev":{"scenarios":true}}}`). review-jev-scenarios sends redacted scenario text to OpenRouter/TypeSafe, ' +
      "so it is opt-in — nothing was read and no network call was made."
    );
  }
  const apiKey = resolveJevApiKey(process.env);
  if (apiKey === undefined || apiKey.length === 0) {
    return (
      "OPENROUTER_API_KEY is not set, and no openrouterKey is saved in the keryx shell config: review-jev-scenarios " +
      "needs a Jev/OpenRouter credential and made no network call."
    );
  }
  return undefined;
}

export async function runJevScenarios(args: string[]): Promise<void> {
  rejectUnknownJevScenariosFlags(args);
  const cwd = process.cwd();

  const diffRef = optionValue(args, "--diff");
  const prArg = optionValue(args, "--pr");
  const scopeFile = optionValue(args, "--scope");
  const provided = [diffRef, prArg, scopeFile].filter((value) => value !== undefined);
  if (provided.length !== 1) {
    throw new Error("Usage: keryx review jev-scenarios (--diff <ref> | --pr <n> | --scope <scope.json>) [--max-calls N] [--threshold 0..1] [--json]");
  }

  const refusal = await jevScenariosGateRefusal(cwd);
  if (refusal !== undefined) {
    console.error(refusal);
    process.exitCode = 1;
    return;
  }

  const fixturesDir = optionValue(args, "--fixtures");
  const model = optionValue(args, "--model") ?? DEFAULT_JEV_MODEL;
  const maxCalls = parseMaxCalls(optionValue(args, "--max-calls"));
  const threshold = parseThreshold(optionValue(args, "--threshold"));

  let allChangedFiles: readonly string[];
  let targetLabel: string;
  if (scopeFile !== undefined) {
    const raw = scopeFile === "-" ? await Bun.stdin.text() : await Bun.file(scopeFile).text();
    const parsed = JSON.parse(raw) as { files?: unknown };
    if (!Array.isArray(parsed.files)) {
      throw new Error(`--scope ${scopeFile} carries no \`files\` array. Pass the output of \`keryx review scope --json\`.`);
    }
    allChangedFiles = parsed.files as string[];
    targetLabel = `scope ${scopeFile}`;
  } else if (prArg !== undefined) {
    const number = Number(prArg);
    if (!Number.isInteger(number) || number <= 0) {
      throw new Error(`--pr must be a positive integer, got "${prArg}".`);
    }
    const port: ConformPrPort = fixturesDir === undefined ? createGhConformPrPort(undefined, optionValue(args, "--repo")) : await fixturePrPort(fixturesDir);
    const info = await port.pr(number);
    allChangedFiles = buildReviewScope(info.diff).files;
    targetLabel = `PR #${info.number} — ${info.title}`;
  } else {
    const diff = await gitDiffForJevScenarios(diffRef);
    allChangedFiles = buildReviewScope(diff).files;
    targetLabel = diffRef ?? "working diff";
  }

  const fetchFn: typeof fetch = fixturesDir === undefined ? globalThis.fetch : await fixtureJevFetch(fixturesDir);
  const result = await computeJevScenariosResult({ cwd, allChangedFiles, targetLabel, maxCalls, threshold, model, fetchFn });

  if (args.includes("--json")) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(renderScenariosMarkdown(result));
}

async function gitDiffForJevScenarios(ref: string | undefined): Promise<string> {
  const command = ["git", "diff", "--no-color", "-U0", ...(ref === undefined ? [] : [ref])];
  const proc = Bun.spawn(command, { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (exitCode !== 0) {
    throw new Error(`git diff failed (exit ${exitCode}): ${stderr.trim()}`);
  }
  return stdout;
}
