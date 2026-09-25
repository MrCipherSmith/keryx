// `keryx review jev-contract` — flow 335's ADAPTER. The CLIENT-zone half of
// the split every Jev-backed review mode in this repository already uses
// (see `src/review/jev-risk.ts`'s file header): `src/review/jev-contract.ts`
// is CORE — pure, no I/O, no client import — and this file is where it meets
// the filesystem, `gh`, and `src/harness/decision/jev-client.ts`.
//
// The linked-flow acceptance-criteria track reuses `src/commands/flow-check-
// ac.ts`'s `runCheckAc` WHOLESALE — the exact same diff acquisition, Jev
// batching, cache and degrade path `keryx flow check-ac` already uses over
// `src/flow/check-ac.ts` (itself reached only through `src/flow/service.ts`,
// see that adapter's own header) — no criterion-checking logic is
// reimplemented here.
//
// Registration in `src/commands/review.ts` is one `if` branch plus one
// import — mirrors `review-jev-risk.ts`'s own registration note exactly, for
// the same reason: everything else lives here so no other flow's concurrent
// work on `src/commands/review.ts` collides with it.

import { readFile } from "node:fs/promises";
import { optionValue } from "../lib/args";
import { buildReviewScope } from "../review/scope";
import { createFixtureConformPrPort, createGhConformPrPort, type ConformPrInfo, type ConformPrPort } from "../review/conform-pr-port";
import { readJevContractEnabled } from "../review/jev-contract-config";
import {
  DEFAULT_JEV_CONTRACT_THRESHOLD,
  DEFAULT_MAX_JEV_CONTRACT_CALLS,
  batchContractClaimItems,
  buildContractClaimBatch,
  computeContractClaimItems,
  contractFindingStats,
  extractClaims,
  renderContractMarkdown,
  selectContractClaims,
  synthesizeContractFindings,
  type Claim,
  type ContractClaimBatch,
  type ContractClaimItem,
  type JevContractRunResult,
  type ScoredClaim,
} from "../review/jev-contract";
import { callJevSystemOne, DEFAULT_JEV_MODEL, JevRequestError, resolveJevApiKey, type JevQuestions } from "../harness/decision/jev-client";
import { runCheckAc, type CheckAcResult } from "./flow-check-ac";
import { renderAcCheckReport, summarizeVerdicts, type AcCheckVerdict } from "../flow/service";

export const JEV_CONTRACT_FLAGS = ["--diff", "--pr", "--flow", "--max-calls", "--threshold", "--model", "--repo", "--fixtures", "--json"];

function rejectUnknownJevContractFlags(args: readonly string[]): void {
  const unknown = args.filter((arg) => arg.startsWith("--") && !JEV_CONTRACT_FLAGS.includes(arg.split("=")[0]!));
  if (unknown.length > 0) {
    throw new Error(
      `Unknown option${unknown.length > 1 ? "s" : ""} for \`keryx review jev-contract\`: ${[...new Set(unknown)].join(", ")}. ` +
        `Accepted: ${JEV_CONTRACT_FLAGS.join(", ")}.`,
    );
  }
}

function parseMaxCalls(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_MAX_JEV_CONTRACT_CALLS;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value < 0 || String(value) !== raw.trim()) {
    throw new Error(`--max-calls must be a non-negative integer, got "${raw}".`);
  }
  return value;
}

function parseThreshold(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_JEV_CONTRACT_THRESHOLD;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`--threshold must be a number between 0 and 1, got "${raw}".`);
  }
  return value;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A real vendor `HTTP 400 max_tokens_exceeded` — the specific, retryable-by-splitting failure; any other status or body is not (a 401, a timeout, a malformed response degrade on the first attempt, same as before). */
function isMaxTokensExceededError(error: unknown): boolean {
  return error instanceof JevRequestError && error.status === 400 && /max_tokens/i.test(error.message);
}

async function fixturePrPort(dir: string): Promise<ConformPrPort> {
  const raw = await readFile(`${dir}/pr.json`, "utf8");
  return createFixtureConformPrPort({ pr: JSON.parse(raw) as ConformPrInfo });
}

/** Same shape `review-jev-risk.ts`'s own `fixtureJevFetch` uses — a canned `/systemone` response per call, consumed in order. */
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

export interface JevContractRunOptions {
  readonly cwd: string;
  readonly description: string;
  readonly diffText: string;
  readonly targetLabel: string;
  readonly maxCalls?: number;
  readonly threshold?: number;
  readonly model?: string;
  readonly fetchFn?: typeof fetch;
}

export interface JevContractComputedResult extends JevContractRunResult {
  readonly tokens: { readonly jevCalls: number; readonly inputTokens?: number; readonly outputTokens?: number; readonly costUsd?: number };
  /** Set when at least one Jev batch failed (e.g. a vendor `max_tokens_exceeded`) — the claims in that batch degrade to facts-only (no `probability`) rather than aborting the whole run, same discipline `runCheckAc`'s own per-batch `try`/`catch` uses. Only the first failure's message is kept. */
  readonly jevError?: string;
  readonly acCheck?: {
    readonly flowId: string;
    readonly verdicts: readonly AcCheckVerdict[];
    readonly jevAsked: boolean;
    readonly summary: Readonly<Record<"likelyMet" | "notEvident" | "notCheckable", number>>;
  };
}

/**
 * The claims track: extraction, facts, budget selection, batching, the Jev
 * calls, and finding synthesis. Shared by the CLI (`runJevContract`, below)
 * and the TUI's `/contract` (`src/tui/jev-contract-command.ts`).
 *
 * Callers MUST have already passed the opt-in and credential gates — this
 * function makes network calls unconditionally when there is anything to
 * score.
 */
export async function computeJevContractResult(options: JevContractRunOptions): Promise<JevContractComputedResult> {
  const { description, diffText, targetLabel } = options;
  const maxCalls = options.maxCalls ?? DEFAULT_MAX_JEV_CONTRACT_CALLS;
  const threshold = options.threshold ?? DEFAULT_JEV_CONTRACT_THRESHOLD;
  const model = options.model ?? DEFAULT_JEV_MODEL;
  const fetchFn = options.fetchFn ?? globalThis.fetch;

  const scope = buildReviewScope(diffText);
  const allClaims: readonly Claim[] = extractClaims(description);
  const selection = selectContractClaims(allClaims, maxCalls);
  const items: readonly ContractClaimItem[] = computeContractClaimItems(selection.selected, diffText, scope.files, scope.regions);

  const scored: ScoredClaim[] = [];
  let jevCalls = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let costUsd = 0;
  let sawUsage = false;
  let jevError: string | undefined;

  if (items.length > 0) {
    const batches = batchContractClaimItems(items);
    const probabilityById = new Map<string, number>();

    // One Jev call for `batch`; records usage/answers on success. Never
    // throws — the caller decides what a failure means (degrade, or retry).
    const attemptBatch = async (batch: ContractClaimBatch): Promise<{ readonly ok: true } | { readonly ok: false; readonly error: unknown }> => {
      try {
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
          const answer = result.answers[item.id];
          if (answer !== undefined && answer.type === "noul") probabilityById.set(item.id, answer.noul);
        }
        return { ok: true };
      } catch (error) {
        return { ok: false, error };
      }
    };

    for (const batch of batches) {
      // Each batch is caught on its own — a single oversized/failed batch
      // (a real vendor `HTTP 400 max_tokens_exceeded`, flow 328's own live
      // check hit this too) degrades only ITS claims to facts-only, not the
      // whole run; every batch after it still gets its own attempt.
      const attempt = await attemptBatch(batch);
      if (attempt.ok) continue;
      if (isMaxTokensExceededError(attempt.error) && batch.items.length > 1) {
        // Retried ONCE, split in half — the same conservative-batching
        // discipline `CONTRACT_TOKEN_BUDGET`'s own header documents applies
        // here too: a batch this size still overshot the vendor's real
        // ceiling, so try half of it before giving up on any of its claims.
        // A batch of exactly one claim has nothing left to split; it
        // degrades on the first failure like any other unretryable error.
        const mid = Math.ceil(batch.items.length / 2);
        const halves = [buildContractClaimBatch(batch.items.slice(0, mid)), buildContractClaimBatch(batch.items.slice(mid))];
        for (const half of halves) {
          const halfAttempt = await attemptBatch(half);
          if (!halfAttempt.ok && jevError === undefined) {
            jevError = messageOf(halfAttempt.error);
          }
        }
        continue;
      }
      if (jevError === undefined) {
        jevError = messageOf(attempt.error);
      }
    }
    for (const item of items) {
      const probability = probabilityById.get(item.id);
      scored.push(probability === undefined ? { item } : { item, probability });
    }
  }

  const findings = synthesizeContractFindings(scored, threshold);
  const stats = contractFindingStats(findings);
  const claims = items.map((item, index) => ({
    id: item.id,
    text: item.claim.text,
    source: item.claim.source,
    intent: item.facts.intent,
    ...(scored[index]?.probability !== undefined ? { probability: scored[index]!.probability } : {}),
  }));
  const status = findings.length > 0 ? "DONE_WITH_CONCERNS" : "DONE";
  const summary =
    `Extracted ${allClaims.length} claim(s) from the description; checked ${items.length} against ${targetLabel}. ` +
    `${findings.length} finding(s) at/above threshold ${threshold} or contradicted by facts. ` +
    `${selection.skipped.length} claim(s) skipped by --max-calls ${selection.maxCalls}.`;

  return {
    status,
    reviewer: "review-jev-contract",
    summary,
    findings,
    stats,
    claims,
    budget: { maxCalls: selection.maxCalls, claimsScored: items.length, claimsSkipped: selection.skipped.length },
    tokens: sawUsage ? { jevCalls, inputTokens, outputTokens, costUsd } : { jevCalls },
    ...(jevError !== undefined ? { jevError } : {}),
  };
}

/**
 * AC7's gate, reusable by any adapter (the CLI below, and the TUI's
 * `/contract`): opt-in first, credential second, both before any read or
 * network call. Returns the refusal message to print/show, or `undefined`
 * when the run may proceed.
 */
export async function jevContractGateRefusal(cwd: string): Promise<string | undefined> {
  if (!(await readJevContractEnabled(cwd))) {
    return (
      "`review.jev.contract` is not enabled for this project (.metaproject/tasks.config.json: " +
      '`{"review":{"jev":{"contract":true}}}`). review-jev-contract sends redacted claim/diff text to ' +
      "OpenRouter/TypeSafe, so it is opt-in — nothing was read and no network call was made."
    );
  }
  const apiKey = resolveJevApiKey(process.env);
  if (apiKey === undefined || apiKey.length === 0) {
    return (
      "OPENROUTER_API_KEY is not set, and no openrouterKey is saved in the keryx shell config: review-jev-contract " +
      "needs a Jev/OpenRouter credential and made no network call."
    );
  }
  return undefined;
}

async function gitDiffForJevContract(ref: string | undefined, contextLines: number): Promise<string> {
  const command = ["git", "diff", "--no-color", `-U${contextLines}`, ...(ref === undefined ? [] : [ref])];
  const proc = Bun.spawn(command, { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (exitCode !== 0) {
    throw new Error(`git diff failed (exit ${exitCode}): ${stderr.trim()}`);
  }
  return stdout;
}

export async function runJevContract(args: string[]): Promise<void> {
  rejectUnknownJevContractFlags(args);
  const cwd = process.cwd();

  const diffRef = optionValue(args, "--diff");
  const prArg = optionValue(args, "--pr");
  const provided = [diffRef, prArg].filter((value) => value !== undefined);
  if (provided.length !== 1) {
    throw new Error("Usage: keryx review jev-contract (--diff <ref> | --pr <n>) [--flow <id>] [--max-calls N] [--threshold 0..1] [--json]");
  }

  const refusal = await jevContractGateRefusal(cwd);
  if (refusal !== undefined) {
    console.error(refusal);
    process.exitCode = 1;
    return;
  }

  const fixturesDir = optionValue(args, "--fixtures");
  const model = optionValue(args, "--model") ?? DEFAULT_JEV_MODEL;
  const maxCalls = parseMaxCalls(optionValue(args, "--max-calls"));
  const threshold = parseThreshold(optionValue(args, "--threshold"));
  const flowId = optionValue(args, "--flow");

  let description: string;
  let diffText: string;
  let targetLabel: string;
  let prNumber: number | undefined;
  let prPort: ConformPrPort | undefined;

  if (prArg !== undefined) {
    const number = Number(prArg);
    if (!Number.isInteger(number) || number <= 0) {
      throw new Error(`--pr must be a positive integer, got "${prArg}".`);
    }
    prPort = fixturesDir === undefined ? createGhConformPrPort(undefined, optionValue(args, "--repo")) : await fixturePrPort(fixturesDir);
    const info = await prPort.pr(number);
    description = info.body;
    diffText = info.diff;
    targetLabel = `PR #${info.number} — ${info.title}`;
    prNumber = number;
  } else {
    description = "";
    diffText = await gitDiffForJevContract(diffRef, 20);
    targetLabel = diffRef ?? "working diff";
  }

  const fetchFn: typeof fetch = fixturesDir === undefined ? globalThis.fetch : await fixtureJevFetch(fixturesDir);
  const result = await computeJevContractResult({ cwd, description, diffText, targetLabel, maxCalls, threshold, model, fetchFn });

  let acCheck: JevContractComputedResult["acCheck"];
  if (flowId !== undefined) {
    const checkOpts = prNumber !== undefined ? { pr: prNumber, model } : diffRef !== undefined ? { diffRef, model } : { model };
    const checkDeps = { ...(fixturesDir === undefined ? {} : { fetchFn, ...(prPort !== undefined ? { prPort } : {}) }) };
    const checkResult: CheckAcResult = await runCheckAc(cwd, flowId, checkOpts, checkDeps);
    acCheck = {
      flowId: checkResult.flowId,
      verdicts: checkResult.verdicts,
      jevAsked: checkResult.jevAsked,
      summary: summarizeVerdicts(checkResult.verdicts),
    };
  }

  const combined: JevContractComputedResult = acCheck === undefined ? result : { ...result, acCheck };

  if (args.includes("--json")) {
    console.log(JSON.stringify(combined, null, 2));
    return;
  }
  console.log(renderContractMarkdown(combined));
  if (acCheck !== undefined) {
    console.log(
      renderAcCheckReport({
        flowId: acCheck.flowId,
        verdicts: acCheck.verdicts,
        jevAsked: acCheck.jevAsked,
      }),
    );
  }
}
