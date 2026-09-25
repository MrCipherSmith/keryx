// Flow 328: `keryx flow check-ac` — the adapter that glues the deterministic
// core module (`src/flow/check-ac.ts`) to the client-zone Jev caller
// (`src/harness/decision/jev-client.ts`), git/gh diff acquisition, and the
// per-flow result cache under `.metaproject/data/ac-check/`.
//
// ADAPTER ZONE (`src/lib/import-zones.ts`: `commands` is adapter — the only
// zone allowed to import both `flow`/`review` (core) and `harness` (client)).
// This is also the shared engine `flow implemented`/`flow complete`'s AC5
// advisory notice, and `review ingest`'s AC6 attachment, both call —
// `src/commands/flow.ts` and the minimal AC6 hook in `src/commands/review.ts`
// import `runCheckAc`/`readCachedCheckAc` from here rather than re-implementing
// diff acquisition or the Jev call.

import { readFile } from "node:fs/promises";
import type { FlowState } from "../flow/types";
// Through the flow facade (`src/flow/service.ts`), not `./store`/`./check-ac`
// directly — the import-policy ratchet (rule 2, `client-imports-core-internal`)
// only excuses an edge whose target is a core owner's own `service.ts`.
import {
  AC_CHECK_TOKEN_BUDGET,
  acCheckCacheKey,
  acCheckCachePath,
  acPath,
  assertAcIntact,
  batchAcCheckItems,
  classifyNotCheckable,
  computeAcFacts,
  evaluatedVerdict,
  factsOnlyVerdict,
  isFrozen,
  notCheckableVerdict,
  parseAcceptanceCriteria,
  readAcCheckCache,
  readAcCheckEnabled,
  readFlow,
  resolveFlowDir,
  selectMatchedHunks,
  summarizeVerdicts,
  writeAcCheckCache,
  type AcCheckCacheRecord,
  type AcCheckItem,
  type AcCheckVerdict,
} from "../flow/service";
import { buildReviewScope } from "../review/scope";
import { callJevSystemOne, DEFAULT_JEV_MODEL, resolveJevApiKeyResolution } from "../harness/decision/jev-client";
import { createFixtureConformPrPort, createGhConformPrPort, type ConformPrPort } from "../review/conform-pr-port";

// AC8's cache functions now live in `src/flow/check-ac.ts` (core) so the TUI
// (client zone — allowed to import core, never adapter) can read a flow's
// cached markers directly for AC7, without importing `src/commands/`.
// Re-exported here for every existing caller of this module (this file's own
// test, `src/commands/flow.ts`).
export { acCheckCachePath, readAcCheckCache, writeAcCheckCache, type AcCheckCacheRecord };

// ---------------------------------------------------------------------------
// Diff acquisition — git, self-contained (no import from `src/commands/
// review.ts`: flow 326/327 own that file's edit surface this flow steers
// clear of; a second, small git-diff helper here costs far less than
// widening that file's blast radius for an unrelated feature).
// ---------------------------------------------------------------------------

export type GitSpawnResult = { readonly stdout: string; readonly stderr: string; readonly exitCode: number };
export type GitSpawn = (argv: readonly string[]) => Promise<GitSpawnResult>;

export async function defaultGitSpawn(argv: readonly string[]): Promise<GitSpawnResult> {
  const proc = Bun.spawn([...argv], { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { stdout, stderr, exitCode };
}

/**
 * AC1's default: "the flow worktree's diff against its base / merge-base with
 * origin/main". `refName` is `flow.baseBranch` when the flow named one,
 * `origin/main` otherwise. The MERGE BASE of `HEAD` and that ref is diffed
 * (not the ref itself) — a two-dot `git diff <ref>` would show the base's own
 * later commits inverted as this branch's removals, the exact failure
 * `src/commands/review.ts`'s `mergeBaseWithHead` documents at length for the
 * same reason.
 */
export async function resolveDiffAgainstBase(spawn: GitSpawn, refName: string): Promise<string> {
  const mergeBase = await spawn(["git", "merge-base", "HEAD", refName]);
  const base = mergeBase.exitCode === 0 ? mergeBase.stdout.trim() : "";
  const ref = base.length > 0 ? base : refName;
  const diff = await spawn(["git", "diff", "--no-color", "-U20", ref]);
  if (diff.exitCode !== 0) {
    throw new Error(`flow check-ac: \`git diff ${ref}\` failed: ${diff.stderr.trim() || `exit ${diff.exitCode}`}`);
  }
  return diff.stdout;
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

function acNumber(id: string): number {
  const match = /^AC(\d+)$/i.exec(id);
  return match?.[1] ? Number.parseInt(match[1], 10) : Number.MAX_SAFE_INTEGER;
}

export interface CheckAcOptions {
  readonly diffRef?: string;
  readonly pr?: number;
  readonly model?: string;
  /** Bypass the cache even when the key matches — used by `--refresh` and by the live-check harness. */
  readonly noCache?: boolean;
}

export interface CheckAcDeps {
  readonly gitSpawn?: GitSpawn;
  readonly fetchFn?: typeof fetch;
  readonly prPort?: ConformPrPort;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly now?: () => Date;
}

export interface CheckAcResult {
  readonly flowId: string;
  readonly flowDir: string;
  readonly verdicts: readonly AcCheckVerdict[];
  readonly jevAsked: boolean;
  readonly jevError?: string;
  readonly usage?: { readonly jevCalls: number; readonly inputTokens?: number; readonly outputTokens?: number; readonly costUsd?: number };
  readonly cached: boolean;
  readonly acCheckEnabled: boolean;
}

/**
 * AC1: read the flow's FROZEN acceptance criteria, get the change, report per
 * criterion. Refuses when the flow is not frozen — never changes flow state,
 * never confirms an AC (this whole module never calls into
 * `createFlowService()` at all).
 */
export async function runCheckAc(cwd: string, id: string, opts: CheckAcOptions = {}, deps: CheckAcDeps = {}): Promise<CheckAcResult> {
  const dir = await resolveFlowDir(cwd, id);
  const flow: FlowState = await readFlow(cwd, dir);
  if (!isFrozen(flow)) {
    throw new Error(
      `flow check-ac: flow ${flow.id}'s acceptance criteria are not frozen — run \`keryx flow freeze ${flow.id}\` first. Nothing fixed to check the change against yet.`,
    );
  }
  await assertAcIntact(cwd, dir, flow);

  const content = await readFile(acPath(cwd, dir), "utf8");
  const criteria = parseAcceptanceCriteria(content);
  if (criteria.length === 0) {
    throw new Error(`flow check-ac: no \`- ACn:\` criteria found in ${acPath(cwd, dir)}.`);
  }

  const gitSpawn = deps.gitSpawn ?? defaultGitSpawn;
  let diffText: string;
  if (opts.pr !== undefined) {
    const port = deps.prPort ?? createGhConformPrPort();
    diffText = (await port.pr(opts.pr)).diff;
  } else {
    diffText = await resolveDiffAgainstBase(gitSpawn, opts.diffRef ?? flow.baseBranch ?? "origin/main");
  }

  const scope = buildReviewScope(diffText);
  const changedFiles = scope.files;

  const notCheckable: AcCheckVerdict[] = [];
  const checkableCriteria = criteria.filter((criterion) => {
    const classification = classifyNotCheckable(criterion.text);
    if (classification === undefined) return true;
    notCheckable.push(notCheckableVerdict(criterion, classification.reason));
    return false;
  });

  const items: AcCheckItem[] = checkableCriteria.map((criterion) => {
    const facts = computeAcFacts(criterion, diffText, changedFiles);
    return { criterion, facts, matchedHunks: selectMatchedHunks(facts, scope.regions), changedFiles };
  });

  const cachePath = acCheckCachePath(cwd, dir);
  const cacheKey = acCheckCacheKey(flow.acChecksum ?? "", diffText);
  if (!opts.noCache) {
    const cached = await readAcCheckCache(cachePath);
    if (cached !== undefined && cached.key === cacheKey) {
      return {
        flowId: flow.id,
        flowDir: dir,
        verdicts: cached.verdicts,
        jevAsked: cached.jevAsked,
        ...(cached.jevError !== undefined ? { jevError: cached.jevError } : {}),
        ...(cached.usage !== undefined ? { usage: cached.usage } : {}),
        cached: true,
        acCheckEnabled: true,
      };
    }
  }

  const acCheckEnabled = await readAcCheckEnabled(cwd);
  const { key: apiKey } = resolveJevApiKeyResolution(deps.env ?? process.env);
  const canAskJev = acCheckEnabled && apiKey !== undefined && apiKey.length > 0 && items.length > 0;

  let evaluated: AcCheckVerdict[];
  let jevAsked = false;
  let jevError: string | undefined;
  let usage: { jevCalls: number; inputTokens?: number; outputTokens?: number; costUsd?: number } | undefined;

  if (!canAskJev) {
    evaluated = items.map((item) => factsOnlyVerdict(item));
  } else {
    jevAsked = true;
    const fetchFn = deps.fetchFn ?? globalThis.fetch;
    const batches = batchAcCheckItems(items);
    const verdictsById = new Map<string, AcCheckVerdict>();
    let jevCalls = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    let costUsd = 0;
    try {
      for (const batch of batches) {
        const result = await callJevSystemOne(fetchFn, { model: opts.model ?? DEFAULT_JEV_MODEL, state: batch.state, questions: batch.questions });
        jevCalls += 1;
        inputTokens += result.usage.input_tokens ?? 0;
        outputTokens += result.usage.output_tokens ?? 0;
        costUsd += result.usage.cost ?? 0;
        for (const item of batch.items) {
          const answer = result.answers[item.criterion.id];
          const probability = answer?.type === "noul" ? answer.noul : 0;
          verdictsById.set(item.criterion.id, evaluatedVerdict(item, probability));
        }
      }
    } catch (error) {
      // AC5: a Jev failure is advisory, never fatal — degrade every
      // not-yet-answered item to the facts-only verdict and surface ONE line
      // naming what happened, rather than throwing out of a command that
      // `flow implemented`/`flow complete` call on every invocation.
      jevError = error instanceof Error ? error.message : String(error);
    }
    evaluated = items.map((item) => verdictsById.get(item.criterion.id) ?? factsOnlyVerdict(item));
    usage = { jevCalls, inputTokens, outputTokens, costUsd };
  }

  const verdicts = [...evaluated, ...notCheckable].sort((a, b) => acNumber(a.id) - acNumber(b.id));

  await writeAcCheckCache(cachePath, {
    key: cacheKey,
    at: (deps.now?.() ?? new Date()).toISOString(),
    jevAsked,
    ...(jevError !== undefined ? { jevError } : {}),
    ...(usage !== undefined ? { usage } : {}),
    verdicts,
  });

  return { flowId: flow.id, flowDir: dir, verdicts, jevAsked, ...(jevError !== undefined ? { jevError } : {}), ...(usage !== undefined ? { usage } : {}), cached: false, acCheckEnabled };
}

/**
 * AC5's advisory path for `flow implemented`/`flow complete`: only runs when
 * the opt-in is ON (never spends a Jev call, or even reads a diff, otherwise)
 * and NEVER throws — a failure of the check itself is reported as a one-line
 * notice by the caller, exactly as AC5 specifies, rather than failing the
 * command that called it.
 */
export async function tryAdvisoryCheckAc(cwd: string, id: string): Promise<CheckAcResult | { readonly error: string } | undefined> {
  try {
    if (!(await readAcCheckEnabled(cwd))) return undefined;
    return await runCheckAc(cwd, id, {});
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

export { createFixtureConformPrPort, summarizeVerdicts };
export const AC_CHECK_BATCH_TOKEN_BUDGET = AC_CHECK_TOKEN_BUDGET;
