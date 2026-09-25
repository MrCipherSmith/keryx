// `keryx review jev-risk` — flow 332's ADAPTER. The CLIENT-zone half of the
// split every Jev-backed review mode in this repository already uses (see
// `src/review/jev-rules.ts`'s file header, and `src/review/ci-triage.ts`):
// `src/review/jev-risk.ts` is CORE — pure, no I/O, no client import — and
// this file is where it meets the filesystem, `gh`, and
// `src/harness/decision/jev-client.ts`.
//
// Registration in `src/commands/review.ts` is one `if` branch plus one
// import — mirrors flow 330's `review-jev-rules.ts` registration note
// exactly, for the same reason: everything else lives here so no other
// flow's concurrent work on `src/commands/review.ts` collides with it.

import { readFile } from "node:fs/promises";
import { optionValue } from "../lib/args";
import { DEFAULT_CONTEXT_LINES, buildReviewScope } from "../review/scope";
import type { ScopedRegion } from "../review/scope";
import { createFixtureConformPrPort, createGhConformPrPort, type ConformPrInfo, type ConformPrPort } from "../review/conform-pr-port";
import { readJevRiskEnabled } from "../review/jev-risk-config";
import {
  DEFAULT_JEV_RISK_THRESHOLD,
  DEFAULT_MAX_JEV_RISK_CALLS,
  batchRiskQuestionsForHunk,
  computeHunkRiskFacts,
  computeRiskRoutingHints,
  rankHunksByRisk,
  renderRiskMarkdown,
  riskFindingStats,
  scoreHunk,
  selectRiskHunks,
  synthesizeRiskFindings,
  type JevRiskRunResult,
  type NearbyTestTextByPath,
  type ScoredRiskHunk,
} from "../review/jev-risk";
import { callJevSystemOne, DEFAULT_JEV_MODEL, resolveJevApiKey, type JevQuestions } from "../harness/decision/jev-client";

export const JEV_RISK_FLAGS = ["--diff", "--pr", "--scope", "--max-calls", "--threshold", "--model", "--repo", "--fixtures", "--json"];

function rejectUnknownJevRiskFlags(args: readonly string[]): void {
  const unknown = args.filter((arg) => arg.startsWith("--") && !JEV_RISK_FLAGS.includes(arg.split("=")[0]!));
  if (unknown.length > 0) {
    throw new Error(
      `Unknown option${unknown.length > 1 ? "s" : ""} for \`keryx review jev-risk\`: ${[...new Set(unknown)].join(", ")}. ` +
        `Accepted: ${JEV_RISK_FLAGS.join(", ")}.`,
    );
  }
}

function parseMaxCalls(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_MAX_JEV_RISK_CALLS;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value < 0 || String(value) !== raw.trim()) {
    throw new Error(`--max-calls must be a non-negative integer, got "${raw}".`);
  }
  return value;
}

function parseThreshold(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_JEV_RISK_THRESHOLD;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`--threshold must be a number between 0 and 1, got "${raw}".`);
  }
  return value;
}

async function fixturePrPort(dir: string): Promise<ConformPrPort> {
  const raw = await readFile(`${dir}/pr.json`, "utf8");
  return createFixtureConformPrPort({ pr: JSON.parse(raw) as ConformPrInfo });
}

/** Same shape `review-jev-rules.ts`'s own `fixtureJevFetch` uses — a canned `/systemone` response per call, consumed in order. */
async function fixtureJevFetch(dir: string): Promise<typeof fetch> {
  const raw = await readFile(`${dir}/jev-responses.json`, "utf8");
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

export interface JevRiskRunOptions {
  readonly cwd: string;
  readonly regions: readonly ScopedRegion[];
  readonly allChangedFiles: readonly string[];
  readonly targetLabel: string;
  readonly maxCalls?: number;
  readonly threshold?: number;
  readonly model?: string;
  readonly fetchFn?: typeof fetch;
}

export interface JevRiskComputedResult extends JevRiskRunResult {
  readonly tokens: { readonly jevCalls: number; readonly inputTokens?: number; readonly outputTokens?: number; readonly costUsd?: number };
  readonly selection: { readonly maxCalls: number; readonly hunksScored: number; readonly hunksSkipped: number; readonly hunksNotCode: number };
}

/** `path -> that path's own changed diff text` across EVERY retained region (not just the ones selected for scoring), for `computeHunkRiskFacts`'s nearby-test evidence lookup — a candidate test's own hunk can sort past `--max-calls` and still be available as evidence. */
function nearbyTestTextByPath(regions: readonly ScopedRegion[]): NearbyTestTextByPath {
  const byPath = new Map<string, string>();
  for (const region of regions) {
    byPath.set(region.path, `${byPath.get(region.path) ?? ""}\n${region.text}`);
  }
  return byPath;
}

/**
 * Everything past "which hunks": budget selection, batching, the Jev calls,
 * ranking and finding synthesis. Shared by the CLI (`runJevRisk`, below) and
 * the TUI's `/risk` (`src/tui/jev-risk-command.ts`).
 *
 * Callers MUST have already passed the opt-in and credential gates — this
 * function makes network calls unconditionally when there is anything to
 * score.
 */
export async function computeJevRiskResult(options: JevRiskRunOptions): Promise<JevRiskComputedResult> {
  const { regions, allChangedFiles, targetLabel } = options;
  const maxCalls = options.maxCalls ?? DEFAULT_MAX_JEV_RISK_CALLS;
  const threshold = options.threshold ?? DEFAULT_JEV_RISK_THRESHOLD;
  const model = options.model ?? DEFAULT_JEV_MODEL;
  const fetchFn = options.fetchFn ?? globalThis.fetch;

  const selection = selectRiskHunks(regions, maxCalls);
  const testText = nearbyTestTextByPath(regions);
  const facts = selection.selected.map((region) => computeHunkRiskFacts(region, allChangedFiles, testText));

  const scored: ScoredRiskHunk[] = [];
  let jevCalls = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let costUsd = 0;
  let sawUsage = false;

  for (const hunkFacts of facts) {
    const batches = batchRiskQuestionsForHunk(hunkFacts);
    const answers: Record<string, { noul: number }> = {};
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
      for (const dimension of batch.dimensions) {
        const answer = result.answers[dimension];
        if (answer !== undefined && answer.type === "noul") answers[dimension] = { noul: answer.noul };
      }
    }
    scored.push(scoreHunk(hunkFacts, answers));
  }

  const findings = synthesizeRiskFindings(scored, threshold);
  const stats = riskFindingStats(findings);
  const routingHints = computeRiskRoutingHints(scored, threshold);
  const ranked = rankHunksByRisk(scored).map((hunk) => ({
    file: hunk.facts.region.path,
    startLine: hunk.facts.region.startLine,
    endLine: hunk.facts.region.endLine,
    combinedRisk: hunk.combinedRisk,
    topDimension: hunk.topDimension,
  }));
  const status = findings.length > 0 ? "DONE_WITH_CONCERNS" : "DONE";
  const summary =
    `Scored ${scored.length} hunk(s) (of ${selection.selected.length + selection.skipped.length} retained) across 5 risk dimensions against ${targetLabel}; ` +
    `${findings.length} finding(s) at/above threshold ${threshold} with no nearby test. ` +
    `${selection.skipped.length} hunk(s) skipped by --max-calls ${selection.maxCalls} (${selection.pairsSkipped} pair(s)); ` +
    `${selection.notCode.length} hunk(s) skipped as not a code hunk (docs/.md/.txt, or .metaproject/{flows,data,reviews} bookkeeping).`;

  return {
    status,
    reviewer: "review-jev-risk",
    summary,
    findings,
    stats,
    ranked,
    routingHints,
    tokens: sawUsage ? { jevCalls, inputTokens, outputTokens, costUsd } : { jevCalls },
    selection: {
      maxCalls: selection.maxCalls,
      hunksScored: selection.selected.length,
      hunksSkipped: selection.skipped.length,
      hunksNotCode: selection.notCode.length,
    },
  };
}

/**
 * AC5's gate, reusable by any adapter (the CLI below, and the TUI's
 * `/risk`): opt-in first, credential second, both before any read or
 * network call. Returns the refusal message to print/show, or `undefined`
 * when the run may proceed.
 */
export async function jevRiskGateRefusal(cwd: string): Promise<string | undefined> {
  if (!(await readJevRiskEnabled(cwd))) {
    return (
      "`review.jev.risk` is not enabled for this project (.metaproject/tasks.config.json: " +
      '`{"review":{"jev":{"risk":true}}}`). review-jev-risk sends redacted hunk text to OpenRouter/TypeSafe, ' +
      "so it is opt-in — nothing was read and no network call was made."
    );
  }
  const apiKey = resolveJevApiKey(process.env);
  if (apiKey === undefined || apiKey.length === 0) {
    return (
      "OPENROUTER_API_KEY is not set, and no openrouterKey is saved in the keryx shell config: review-jev-risk " +
      "needs a Jev/OpenRouter credential and made no network call."
    );
  }
  return undefined;
}

async function gitDiffForJevRisk(ref: string | undefined, contextLines: number): Promise<string> {
  const command = ["git", "diff", "--no-color", `-U${contextLines}`, ...(ref === undefined ? [] : [ref])];
  const proc = Bun.spawn(command, { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (exitCode !== 0) {
    throw new Error(`git diff failed (exit ${exitCode}): ${stderr.trim()}`);
  }
  return stdout;
}

export async function runJevRisk(args: string[]): Promise<void> {
  rejectUnknownJevRiskFlags(args);
  const cwd = process.cwd();

  const diffRef = optionValue(args, "--diff");
  const prArg = optionValue(args, "--pr");
  const scopeFile = optionValue(args, "--scope");
  const provided = [diffRef, prArg, scopeFile].filter((value) => value !== undefined);
  if (provided.length !== 1) {
    throw new Error("Usage: keryx review jev-risk (--diff <ref> | --pr <n> | --scope <scope.json>) [--max-calls N] [--threshold 0..1] [--json]");
  }

  const refusal = await jevRiskGateRefusal(cwd);
  if (refusal !== undefined) {
    console.error(refusal);
    process.exitCode = 1;
    return;
  }

  const fixturesDir = optionValue(args, "--fixtures");
  const model = optionValue(args, "--model") ?? DEFAULT_JEV_MODEL;
  const maxCalls = parseMaxCalls(optionValue(args, "--max-calls"));
  const threshold = parseThreshold(optionValue(args, "--threshold"));

  let regions: readonly ScopedRegion[];
  let allChangedFiles: readonly string[];
  let targetLabel: string;
  if (scopeFile !== undefined) {
    const raw = scopeFile === "-" ? await Bun.stdin.text() : await Bun.file(scopeFile).text();
    const parsed = JSON.parse(raw) as { regions?: unknown; files?: unknown };
    if (!Array.isArray(parsed.regions)) {
      throw new Error(`--scope ${scopeFile} carries no \`regions\` array. Pass the output of \`keryx review scope --json\`.`);
    }
    regions = parsed.regions as ScopedRegion[];
    allChangedFiles = Array.isArray(parsed.files) ? (parsed.files as string[]) : regions.map((r) => r.path);
    targetLabel = `scope ${scopeFile}`;
  } else if (prArg !== undefined) {
    const number = Number(prArg);
    if (!Number.isInteger(number) || number <= 0) {
      throw new Error(`--pr must be a positive integer, got "${prArg}".`);
    }
    const port: ConformPrPort = fixturesDir === undefined ? createGhConformPrPort(undefined, optionValue(args, "--repo")) : await fixturePrPort(fixturesDir);
    const info = await port.pr(number);
    const scope = buildReviewScope(info.diff);
    regions = scope.regions;
    allChangedFiles = scope.files;
    targetLabel = `PR #${info.number} — ${info.title}`;
  } else {
    const diff = await gitDiffForJevRisk(diffRef, DEFAULT_CONTEXT_LINES);
    const scope = buildReviewScope(diff);
    regions = scope.regions;
    allChangedFiles = scope.files;
    targetLabel = diffRef ?? "working diff";
  }

  const fetchFn: typeof fetch = fixturesDir === undefined ? globalThis.fetch : await fixtureJevFetch(fixturesDir);
  const result = await computeJevRiskResult({ cwd, regions, allChangedFiles, targetLabel, maxCalls, threshold, model, fetchFn });

  if (args.includes("--json")) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(renderRiskMarkdown(result));
}
