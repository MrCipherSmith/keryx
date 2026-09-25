// `keryx review jev-triage` — flow 340's ADAPTER. The CLIENT-zone half of
// the split every Jev-backed review mode in this repository already uses
// (see `src/review/jev-contract.ts`'s own file header): `src/review/
// jev-triage.ts` is CORE — pure, no I/O, no client import — and this file
// is where it meets the filesystem and `src/harness/decision/jev-client.ts`.
//
// Advisory, annotate-only, run by the orchestrator over a review package's
// CONSOLIDATED findings after the Sub-Agent Report Quality Gate and before
// Wave C verification (`review-orchestrator/SKILL.md`/`SKILL.detail.md`).
// It never drops or demotes a finding — see `src/review/jev-triage.ts`'s
// header for the three tracks.
//
// Registration in `src/commands/review.ts` is one `if` branch plus one
// import — mirrors `review-jev-contract.ts`'s own registration note.

import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { optionValue } from "../lib/args";
import { readJevTriageEnabled } from "../review/jev-triage-config";
import {
  DEFAULT_JEV_TRIAGE_SEVERITY_THRESHOLD,
  DEFAULT_MAX_JEV_TRIAGE_ITEMS,
  batchTriageItems,
  buildTriageBatch,
  computeTriageItems,
  computeTriagePopulation,
  parseTriageFindings,
  renderTriageMarkdown,
  synthesizeTriageAnnotations,
  type JevTriageRunResult,
  type TriageBatch,
} from "../review/jev-triage";
import { callJevSystemOne, DEFAULT_JEV_MODEL, JevRequestError, resolveJevApiKey, type JevQuestions } from "../harness/decision/jev-client";

export const JEV_TRIAGE_FLAGS = ["--report", "--max-calls", "--threshold", "--model", "--fixtures", "--json"];

function rejectUnknownJevTriageFlags(args: readonly string[]): void {
  const unknown = args.filter((arg) => arg.startsWith("--") && !JEV_TRIAGE_FLAGS.includes(arg.split("=")[0]!));
  if (unknown.length > 0) {
    throw new Error(`Unknown option${unknown.length > 1 ? "s" : ""} for \`keryx review jev-triage\`: ${[...new Set(unknown)].join(", ")}. Accepted: ${JEV_TRIAGE_FLAGS.join(", ")}.`);
  }
}

function parseMaxItems(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_MAX_JEV_TRIAGE_ITEMS;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value < 0 || String(value) !== raw.trim()) {
    throw new Error(`--max-calls must be a non-negative integer, got "${raw}".`);
  }
  return value;
}

function parseThreshold(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_JEV_TRIAGE_SEVERITY_THRESHOLD;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`--threshold must be a number between 0 and 1, got "${raw}".`);
  }
  return value;
}

/** A merge-candidate pair scoring at/above this is reported as a "concern" in `status` — same reading `flagged`'s own `< threshold` uses, mirrored above the midpoint since "same defect" is the affirmative claim here (unlike severity, where the boundary test's affirmative answer is a LOW `p`). */
const LIKELY_DUPLICATE_THRESHOLD = 0.5;

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A real vendor `HTTP 400 max_tokens_exceeded` — the specific, retryable-by-splitting failure; any other status or body is not (same rule `review-jev-contract.ts`'s `isMaxTokensExceededError` applies). */
function isMaxTokensExceededError(error: unknown): boolean {
  return error instanceof JevRequestError && error.status === 400 && /max_tokens/i.test(error.message);
}

/** `--report <dir|findings.json>`: a directory reads its `findings.json`; any other path is read directly. Always the real project directory — never stood in for by `--fixtures`, which answers only the Jev call (same separation `review-jev-comments.ts` draws between its ledger and its Jev fixtures). */
async function loadReportRaw(reportPath: string): Promise<unknown> {
  let filePath = reportPath;
  try {
    const stats = await stat(reportPath);
    if (stats.isDirectory()) filePath = path.join(reportPath, "findings.json");
  } catch {
    // Not found / unreadable as a directory — fall through to reading
    // `reportPath` itself, whose own error (if any) is the one that surfaces.
  }
  const raw = await readFile(filePath, "utf8");
  return JSON.parse(raw) as unknown;
}

/** Same shape `review-jev-contract.ts`'s own `fixtureJevFetch` uses — a canned `/systemone` response per call, consumed in order. Answers ONLY the Jev call; `--report` is always read from the real filesystem. */
async function fixtureJevFetch(dir: string): Promise<typeof fetch> {
  const raw = await readFile(path.join(dir, "jev-responses.json"), "utf8");
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

export interface JevTriageRunOptions {
  readonly findingsRaw: unknown;
  readonly maxItems?: number;
  readonly threshold?: number;
  readonly model?: string;
  readonly fetchFn?: typeof fetch;
  /** Environment the Jev credential resolves from; defaults to `process.env`. Tests inject a fixture key — never the machine's real `OPENROUTER_API_KEY`. */
  readonly env?: NodeJS.ProcessEnv;
}

export interface JevTriageComputedResult extends JevTriageRunResult {
  readonly tokens: { readonly jevCalls: number; readonly inputTokens?: number; readonly outputTokens?: number; readonly costUsd?: number };
  /** Set when at least one batch failed (e.g. a vendor `max_tokens_exceeded`) — that batch's items are left unscored (`p` absent) rather than aborting the whole run, same discipline `computeJevContractResult` uses. Only the first failure's message is kept. */
  readonly jevError?: string;
}

/**
 * The whole triage job: parse findings, build the calibration population and
 * merge-candidate pairs, batch and score with Jev, synthesize the three
 * annotation arrays. Callers MUST have already passed the opt-in and
 * credential gates ({@link jevTriageGateRefusal}) — this function makes
 * network calls unconditionally when there is anything to score.
 */
export async function computeJevTriageResult(options: JevTriageRunOptions): Promise<JevTriageComputedResult> {
  const { findings, droppedCount } = parseTriageFindings(options.findingsRaw);
  const population = computeTriagePopulation(findings);
  const maxItems = options.maxItems ?? DEFAULT_MAX_JEV_TRIAGE_ITEMS;
  const threshold = options.threshold ?? DEFAULT_JEV_TRIAGE_SEVERITY_THRESHOLD;
  const model = options.model ?? DEFAULT_JEV_MODEL;
  const fetchFn = options.fetchFn ?? globalThis.fetch;

  const selection = computeTriageItems(population, maxItems);

  const probabilityById = new Map<string, number>();
  let jevCalls = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let costUsd = 0;
  let sawUsage = false;
  let jevError: string | undefined;

  if (selection.items.length > 0) {
    const batches = batchTriageItems(selection.items);

    const attemptBatch = async (batch: TriageBatch): Promise<{ readonly ok: true } | { readonly ok: false; readonly error: unknown }> => {
      try {
        const result = await callJevSystemOne(fetchFn, { model, state: batch.state, questions: batch.questions as JevQuestions }, { env: options.env ?? process.env });
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
      // degrades only ITS items to unscored, not the whole run; every batch
      // after it still gets its own attempt (same discipline
      // `review-jev-contract.ts`'s per-batch loop uses).
      const attempt = await attemptBatch(batch);
      if (attempt.ok) continue;
      if (isMaxTokensExceededError(attempt.error) && batch.items.length > 1) {
        // Retried ONCE, split in half — the same conservative-batching
        // discipline as `review-jev-contract.ts`: a batch this size still
        // overshot the vendor's real ceiling, so try half of it before
        // giving up on any of its items. A batch of exactly one item has
        // nothing left to split; it degrades on the first failure.
        const mid = Math.ceil(batch.items.length / 2);
        const halves = [buildTriageBatch(batch.items.slice(0, mid)), buildTriageBatch(batch.items.slice(mid))];
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
  }

  const annotations = synthesizeTriageAnnotations(population, probabilityById, threshold);
  const flaggedCount = annotations.severity_check.filter((a) => a.flagged).length;
  // "Concerns" reflects a SCORED signal, never a merge pair's mere existence
  // (a pair is only a candidate the pairing gate made eligible, not a
  // judgement) — the same `>= threshold` reading `flagged` itself uses.
  const likelyMergeCount = annotations.merge_candidates.filter((m) => m.p !== undefined && m.p >= LIKELY_DUPLICATE_THRESHOLD).length;
  const status: JevTriageRunResult["status"] = flaggedCount > 0 || likelyMergeCount > 0 ? "DONE_WITH_CONCERNS" : "DONE";
  const summary =
    `Triaged ${population.calibration.length} blocker/major finding(s) (of ${findings.length} total, ${droppedCount} dropped on parse) and ${population.mergePairs.length} candidate duplicate pair(s). ` +
    `${flaggedCount} severity flag(s) below threshold ${threshold}. ${selection.skippedCount} item(s) skipped by --max-calls ${selection.maxItems}.`;

  return {
    status,
    reviewer: "review-jev-triage",
    summary,
    annotations,
    budget: { maxItems: selection.maxItems, itemsScored: selection.items.length, itemsSkipped: selection.skippedCount, findingsDropped: droppedCount },
    tokens: sawUsage ? { jevCalls, inputTokens, outputTokens, costUsd } : { jevCalls },
    ...(jevError !== undefined ? { jevError } : {}),
  };
}

/**
 * Opt-in first, credential second, both before any read or network call —
 * same shape `jevContractGateRefusal` uses. Returns the refusal message to
 * print/show, or `undefined` when the run may proceed.
 */
export async function jevTriageGateRefusal(cwd: string): Promise<string | undefined> {
  if (!(await readJevTriageEnabled(cwd))) {
    return (
      "`review.jev.triage` is not enabled for this project (.metaproject/tasks.config.json: " +
      '`{"review":{"jev":{"triage":true}}}`). review-jev-triage sends redacted finding text to ' +
      "OpenRouter/TypeSafe, so it is opt-in — nothing was read and no network call was made."
    );
  }
  const apiKey = resolveJevApiKey(process.env);
  if (apiKey === undefined || apiKey.length === 0) {
    return "OPENROUTER_API_KEY is not set, and no openrouterKey is saved in the keryx shell config: review-jev-triage needs a Jev/OpenRouter credential and made no network call.";
  }
  return undefined;
}

export async function runJevTriage(args: string[]): Promise<void> {
  rejectUnknownJevTriageFlags(args);
  const cwd = process.cwd();

  const reportArg = optionValue(args, "--report");
  if (reportArg === undefined) {
    throw new Error("Usage: keryx review jev-triage --report <review package dir or findings.json> [--max-calls N] [--threshold 0..1] [--json]");
  }

  const refusal = await jevTriageGateRefusal(cwd);
  if (refusal !== undefined) {
    console.error(refusal);
    process.exitCode = 1;
    return;
  }

  const fixturesDir = optionValue(args, "--fixtures");
  const model = optionValue(args, "--model") ?? DEFAULT_JEV_MODEL;
  const maxItems = parseMaxItems(optionValue(args, "--max-calls"));
  const threshold = parseThreshold(optionValue(args, "--threshold"));

  const findingsRaw = await loadReportRaw(reportArg);
  const fetchFn: typeof fetch = fixturesDir === undefined ? globalThis.fetch : await fixtureJevFetch(fixturesDir);

  const result = await computeJevTriageResult({ findingsRaw, maxItems, threshold, model, fetchFn });

  if (args.includes("--json")) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(renderTriageMarkdown(result));
}
