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
  hashDiff,
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
//
// `writeAcCheckCache` specifically: review finding — only THIS file (the
// write side, after a live check) calls it, so importing it straight from
// `../flow/check-ac.ts` and dropping it from this re-export looked tempting.
// Left in place instead: `flow` already has a `service.ts` facade, so a
// direct `../flow/check-ac` import here would score as an AVOIDABLE
// `client-imports-core-internal` finding — `import-policy.live.test.ts`
// ratchets that count and fails on ANY growth, even by one. Re-exporting a
// write-only function through the facade costs nothing that check measures;
// bypassing the facade would.
export { acCheckCachePath, readAcCheckCache, writeAcCheckCache, type AcCheckCacheRecord };

// ---------------------------------------------------------------------------
// Diff acquisition — git, self-contained (no import from `src/commands/
// review.ts`: flow 326/327 own that file's edit surface this flow steers
// clear of; a second, small git-diff helper here costs far less than
// widening that file's blast radius for an unrelated feature).
// ---------------------------------------------------------------------------

export type GitSpawnResult = { readonly stdout: string; readonly stderr: string; readonly exitCode: number };
/**
 * `timeoutMs`/`maxBufferBytes` live on the shared opts type (not bolted onto
 * `defaultGitSpawn` alone) so every caller of {@link GitSpawn} — including
 * `resolveDiffAgainstBase`/`resolveIngestDiff`, which just forward `opts`
 * through — can ask for a SHORTER bound than the 15s/8MB default. The TUI's
 * freshness check (`src/tui/inspector-sources.ts`) is the reason this exists:
 * it runs once per flow in a list render and must never let one slow `git`
 * process hold up the whole `/flows` screen.
 */
export type GitSpawnOpts = {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly maxBufferBytes?: number;
  /**
   * Review finding, surfaced by a test: `defaultGitSpawn` used to hardcode
   * `process.cwd()` regardless of which flow's `cwd` the caller was actually
   * working with. That happened to be invisible in the CLI (`flow.ts` always
   * calls `runCheckAc(process.cwd(), ...)`, so the two agreed by
   * construction) but is a real bug for the TUI, whose `cwd` is the SESSION's
   * project path (`opts.session?.cwd` / `liveSession.summary.projectPath`)
   * and can differ from the TUI PROCESS's own `process.cwd()` — and it broke
   * every test that used a fixture directory other than the real repo.
   * Defaults to `process.cwd()` only when omitted, for exactly the CLI shape
   * that never needed it.
   */
  readonly cwd?: string;
};
export type GitSpawn = (argv: readonly string[], opts?: GitSpawnOpts) => Promise<GitSpawnResult>;

/** MEDIUM review finding: an unbounded `git diff`/`git merge-base` could hang
 * this command (and every advisory call `flow implemented`/`flow complete`
 * make) forever on a broken remote or a pathological repo, or buffer an
 * unbounded amount of output into memory. Named so a caller can tell "git
 * refused" (a normal, handled `exitCode !== 0`) from "git was killed for
 * running too long or printing too much" (this). */
export class GitSpawnLimitError extends Error {
  constructor(argv: readonly string[], detail: string) {
    super(`flow check-ac: \`${argv.join(" ")}\` ${detail}`);
    this.name = "GitSpawnLimitError";
  }
}

/** ~15s: long enough for a real `git diff`/`merge-base` on this repo's own
 * history, short enough that one hung git process cannot hold up `flow
 * implemented`/`flow complete`'s advisory notice indefinitely. */
export const DEFAULT_GIT_SPAWN_TIMEOUT_MS = 15_000;
/** 8MB: a diff bigger than this is not something Jev's token budget could use
 * anyway (`AC_CHECK_TOKEN_BUDGET`) — capped before it is ever buffered into a
 * string, not after. */
export const DEFAULT_GIT_SPAWN_MAX_BUFFER = 8 * 1024 * 1024;

export async function defaultGitSpawn(argv: readonly string[], opts?: GitSpawnOpts): Promise<GitSpawnResult> {
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_GIT_SPAWN_TIMEOUT_MS;
  const maxBuffer = opts?.maxBufferBytes ?? DEFAULT_GIT_SPAWN_MAX_BUFFER;
  const proc = Bun.spawn([...argv], {
    cwd: opts?.cwd ?? process.cwd(),
    stdout: "pipe",
    stderr: "pipe",
    // Bun-native bounds (`Bun.spawn`'s own `timeout`/`killSignal`/`maxBuffer`
    // options) — no manual polling, no second timer to keep in sync with the
    // process's real lifetime.
    timeout: timeoutMs,
    killSignal: "SIGKILL",
    maxBuffer,
    ...(opts?.signal !== undefined ? { signal: opts.signal } : {}),
  });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  // `signalCode` is set when Bun killed the process itself (timeout,
  // `maxBuffer`, or an aborted `signal`) rather than the process exiting on
  // its own — `exitCode` alone cannot tell those apart from a normal `git`
  // failure, which also often exits non-zero.
  if (proc.signalCode !== null) {
    if (opts?.signal?.aborted === true) {
      throw new GitSpawnLimitError(argv, "was aborted.");
    }
    throw new GitSpawnLimitError(
      argv,
      `was killed by ${proc.signalCode} — exceeded the ${timeoutMs}ms timeout or the ${maxBuffer}-byte output cap.`,
    );
  }
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
export async function resolveDiffAgainstBase(spawn: GitSpawn, refName: string, opts?: GitSpawnOpts): Promise<string> {
  const mergeBase = await spawn(["git", "merge-base", "HEAD", refName], opts);
  const base = mergeBase.exitCode === 0 ? mergeBase.stdout.trim() : "";
  const ref = base.length > 0 ? base : refName;
  const diff = await spawn(["git", "diff", "--no-color", "-U20", ref], opts);
  if (diff.exitCode !== 0) {
    throw new Error(`flow check-ac: \`git diff ${ref}\` failed: ${diff.stderr.trim() || `exit ${diff.exitCode}`}`);
  }
  return diff.stdout;
}

/**
 * AC6's freshness check (`review ingest`'s `ac-check.md` attachment): the
 * SAME merge-base + diff shape {@link resolveDiffAgainstBase} uses, but
 * generalized to a named `head` commit rather than the literal working tree —
 * `review ingest --head <sha>` (or a `pr` target reviewed from outside its
 * own clone) can name a commit that is not what is checked out, and diffing
 * against the live working tree in that case would silently answer a
 * different question than "what got reviewed". `-U20`, matching
 * `resolveDiffAgainstBase` exactly, because the two diffs are compared by
 * HASH (`acCheckCacheKey`) — a different context width would produce a
 * different hash for byte-identical changes and every ingest would read as
 * stale.
 */
export async function resolveIngestDiff(spawn: GitSpawn, refName: string, head: string, opts?: GitSpawnOpts): Promise<string> {
  const mergeBase = await spawn(["git", "merge-base", head, refName], opts);
  const base = mergeBase.exitCode === 0 ? mergeBase.stdout.trim() : "";
  const ref = base.length > 0 ? base : refName;
  const diff = await spawn(["git", "diff", "--no-color", "-U20", ref, head], opts);
  if (diff.exitCode !== 0) {
    throw new Error(`review ingest ac-check: \`git diff ${ref} ${head}\` failed: ${diff.stderr.trim() || `exit ${diff.exitCode}`}`);
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
  /** Bypass the cache even when the key matches — wired to `keryx flow check-ac --refresh`, and available to the live-check harness. */
  readonly noCache?: boolean;
  /**
   * Aborts the git diff acquisition and every Jev call this run makes.
   * `tryAdvisoryCheckAc` sets this to an `AbortSignal.timeout(...)` so
   * `flow implemented`/`flow complete`'s advisory notice has ONE overall
   * bound regardless of how many Jev batches a large criteria set produces —
   * `defaultGitSpawn`'s own timeout and `callJevSystemOne`'s own per-call
   * timeout each cap a SINGLE call, not the sum across a sequential loop of
   * them. `keryx flow check-ac` itself (a foreground, operator-requested
   * command) passes none, and waits out the underlying per-call bounds.
   */
  readonly signal?: AbortSignal;
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
  /** When this result was computed (cache hit: when it was ORIGINALLY written; a fresh run: now). Review finding: `renderAcCheckReport` must show this. */
  readonly at: string;
  /** The frozen criteria checksum this result is keyed to — the first half of `acCheckCacheKey`. */
  readonly criteriaChecksum: string;
  /** `hashDiff` of the diff this result was computed against — the second half of `acCheckCacheKey`. */
  readonly diffHash: string;
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
    diffText = await resolveDiffAgainstBase(gitSpawn, opts.diffRef ?? flow.baseBranch ?? "origin/main", {
      cwd,
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    });
  }
  const diffHash = hashDiff(diffText);
  const criteriaChecksum = flow.acChecksum ?? "";

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
  const cacheKey = acCheckCacheKey(criteriaChecksum, diffText);
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
        at: cached.at,
        criteriaChecksum,
        diffHash,
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
    for (const batch of batches) {
      try {
        // `env` MUST be threaded through explicitly — `callJevSystemOne`
        // re-resolves the API key itself (it does not trust the caller's own
        // `canAskJev` gate), and its default is `process.env`. Omitting this
        // silently falls back to the REAL ambient environment instead of
        // `deps.env`, which is exactly hermetic enough to pass on a machine
        // that happens to have `OPENROUTER_API_KEY` set and fail in CI, where
        // it does not — the bug `flow-check-ac.test.ts`'s opt-in test hit.
        const result = await callJevSystemOne(
          fetchFn,
          { model: opts.model ?? DEFAULT_JEV_MODEL, state: batch.state, questions: batch.questions },
          { ...(deps.env !== undefined ? { env: deps.env } : {}), ...(opts.signal !== undefined ? { signal: opts.signal } : {}) },
        );
        jevCalls += 1;
        inputTokens += result.usage.input_tokens ?? 0;
        outputTokens += result.usage.output_tokens ?? 0;
        costUsd += result.usage.cost ?? 0;
        for (const item of batch.items) {
          const answer = result.answers[item.criterion.id];
          const probability = answer?.type === "noul" ? answer.noul : 0;
          verdictsById.set(item.criterion.id, evaluatedVerdict(item, probability));
        }
      } catch (error) {
        // LOW review finding: this used to wrap the WHOLE loop, so one bad
        // batch (a transient network blip, a single malformed response)
        // aborted every batch after it too — those were never even
        // attempted, just degraded to facts-only along with the failed one.
        // Caught per batch instead: batch N's failure says nothing about
        // batch N+1, which still gets its own try. Every item whose batch
        // failed still degrades to `factsOnlyVerdict` below (AC5: a Jev
        // failure is advisory, never fatal) — only the FIRST failure's
        // message is kept, as the more likely root cause when several batches
        // fail the same way (e.g. every batch aborted by the same timeout).
        if (jevError === undefined) {
          jevError = error instanceof Error ? error.message : String(error);
        }
      }
    }
    evaluated = items.map((item) => verdictsById.get(item.criterion.id) ?? factsOnlyVerdict(item));
    usage = { jevCalls, inputTokens, outputTokens, costUsd };
  }

  const verdicts = [...evaluated, ...notCheckable].sort((a, b) => acNumber(a.id) - acNumber(b.id));
  const at = (deps.now?.() ?? new Date()).toISOString();

  await writeAcCheckCache(cachePath, {
    key: cacheKey,
    at,
    jevAsked,
    ...(jevError !== undefined ? { jevError } : {}),
    ...(usage !== undefined ? { usage } : {}),
    verdicts,
  });

  return {
    flowId: flow.id,
    flowDir: dir,
    verdicts,
    jevAsked,
    ...(jevError !== undefined ? { jevError } : {}),
    ...(usage !== undefined ? { usage } : {}),
    cached: false,
    acCheckEnabled,
    at,
    criteriaChecksum,
    diffHash,
  };
}

/** MEDIUM review finding: `flow implemented`/`flow complete`'s advisory notice
 * must never wait longer than this, no matter how many Jev batches a large
 * criteria set produces — `defaultGitSpawn`'s own timeout and
 * `callJevSystemOne`'s own per-call timeout each cap ONE call, not the sum
 * across every batch `runCheckAc` awaits sequentially. */
export const DEFAULT_ADVISORY_TIMEOUT_MS = 20_000;

/**
 * AC5's advisory path for `flow implemented`/`flow complete`: only runs when
 * the opt-in is ON (never spends a Jev call, or even reads a diff, otherwise)
 * and NEVER throws — a failure of the check itself is reported as a one-line
 * notice by the caller, exactly as AC5 specifies, rather than failing the
 * command that called it.
 *
 * `deps.advisoryTimeoutMs` overrides {@link DEFAULT_ADVISORY_TIMEOUT_MS} —
 * exposed for tests (a fake, deliberately hanging `gitSpawn`/`fetchFn` that
 * would otherwise make a test wait out the real 20s) rather than as an
 * operator-facing knob; nothing in the CLI sets it.
 */
export async function tryAdvisoryCheckAc(
  cwd: string,
  id: string,
  deps: CheckAcDeps & { readonly advisoryTimeoutMs?: number } = {},
): Promise<CheckAcResult | { readonly error: string } | undefined> {
  try {
    if (!(await readAcCheckEnabled(cwd))) return undefined;
    const signal = AbortSignal.timeout(deps.advisoryTimeoutMs ?? DEFAULT_ADVISORY_TIMEOUT_MS);
    return await runCheckAc(cwd, id, { signal }, deps);
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

export { createFixtureConformPrPort, summarizeVerdicts };
export const AC_CHECK_BATCH_TOKEN_BUDGET = AC_CHECK_TOKEN_BUDGET;
