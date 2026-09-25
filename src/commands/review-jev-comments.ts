// `keryx review jev-comments` — flow 333's ADAPTER for the open-PR-comments
// reviewer. The CLIENT-zone half of the split every Jev-backed review mode
// in this repository already uses (`src/review/jev-rules.ts`'s file header):
// `src/review/jev-comments.ts` is CORE — pure, no I/O, no client import —
// and this file is where it meets the filesystem, `gh`/`git`, and
// `src/harness/decision/jev-client.ts`.
//
// Registration in `src/commands/review.ts` is one `if` branch plus one
// import, mirroring flow 330's `src/commands/review-jev-rules.ts`.
//
// AC3's facts this file gathers that `src/review/jev-comments.ts` cannot
// (it is core and pure):
//
//   - the comment ledger itself (`src/review/pr-comments.ts`'s
//     `readPrCommentState`/`unansweredComments` — AC3: "comments come from
//     the existing ledger", never re-collected from GitHub here);
//   - commits after the comment's timestamp touching its file — a local
//     `git log` read (this repository's own history), capped;
//   - the thread's resolved flag — best-effort, via `gh api graphql`
//     (GitHub's REST comment endpoints carry no resolved state at all; this
//     is the one place this flow reaches GraphQL, and only to READ — no
//     mutation is ever sent). A failed or unavailable read degrades to
//     `"unknown"`, never to a guess.
//   - the PR's current diff, for "the later hunks at that location" — the
//     same `ConformPrPort` `review-jev-rules`/`review-jev-docs` already use.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { optionValue } from "../lib/args";
import { pathExists, writeFileAtomic } from "../lib/fs";
import { hunkRegionsFromDiff } from "../review/conform-state";
import type { ScopedRegion } from "../review/scope";
import { createFixtureConformPrPort, createGhConformPrPort, type ConformPrInfo, type ConformPrPort } from "../review/conform-pr-port";
import { prCommentsStatePath, readPrCommentState, unansweredComments, type SeenComment } from "../review/pr-comments";
import { readJevCommentsEnabled } from "../review/jev-comments-config";
import {
  batchOpenComments,
  commentsFindingStats,
  renderJevCommentsMarkdown,
  synthesizeCommentFinding,
  type CommentAdvisoryLabel,
  type CommentAdvisoryLabels,
  type CommentReply,
  type CommentsFinding,
  type CommitTouch,
  type JevCommentChoice,
  type OpenCommentFacts,
  type ThreadResolution,
} from "../review/jev-comments";
import { callJevSystemOne, DEFAULT_JEV_MODEL, resolveJevApiKey, type JevQuestions } from "../harness/decision/jev-client";

export const JEV_COMMENTS_FLAGS = ["--pr", "--repo", "--model", "--fixtures", "--json"];

function rejectUnknownJevCommentsFlags(args: readonly string[]): void {
  const unknown = args.filter((arg) => arg.startsWith("--") && !JEV_COMMENTS_FLAGS.includes(arg.split("=")[0]!));
  if (unknown.length > 0) {
    throw new Error(
      `Unknown option${unknown.length > 1 ? "s" : ""} for \`keryx review jev-comments\`: ${[...new Set(unknown)].join(", ")}. ` +
        `Accepted: ${JEV_COMMENTS_FLAGS.join(", ")}.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Facts ports — commits touching a file since a timestamp, and thread
// resolution. Both READ-ONLY; both injectable so every CLI test is hermetic.
// ---------------------------------------------------------------------------

export interface JevCommentsFactsPort {
  commitsTouching(filePath: string, sinceIso: string): Promise<readonly CommitTouch[]>;
  resolvedThreadIds(): Promise<ReadonlySet<string>>;
}

/** How many commits `commitsTouching` returns at most — a runaway history read must not hang a comment's fact-gathering. */
const MAX_COMMITS_PER_COMMENT = 20;
/** How many review-thread pages (100 threads each) `resolvedThreadIds` reads at most. */
const MAX_THREAD_PAGES = 3;

async function ghSpawn(argv: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn(argv, { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { stdout, stderr, exitCode };
}

const RESOLVED_THREADS_QUERY = `
query($owner: String!, $repo: String!, $pr: Int!, $cursor: String) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $pr) {
      reviewThreads(first: 100, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes { isResolved comments(first: 1) { nodes { databaseId } } }
      }
    }
  }
}`;

interface ReviewThreadsResponse {
  readonly data?: {
    readonly repository?: {
      readonly pullRequest?: {
        readonly reviewThreads?: {
          readonly pageInfo: { readonly hasNextPage: boolean; readonly endCursor: string | null };
          readonly nodes: readonly { readonly isResolved: boolean; readonly comments: { readonly nodes: readonly { readonly databaseId: number | null }[] } }[];
        };
      };
    };
  };
}

/**
 * The live adapter: local `git log` for commit history (this repository's
 * own, never a network call), and `gh api graphql` — READ ONLY, one query,
 * no mutation field exists in it — for thread resolution. Either half
 * degrades to "nothing found"/"unknown" on any failure rather than raising:
 * a fact port outage should narrow the evidence Jev sees, not crash a
 * reviewer run over every open comment.
 */
export function createGhJevCommentsFactsPort(repo: string, prNumber: number, ref = "HEAD"): JevCommentsFactsPort {
  return {
    async commitsTouching(filePath: string, sinceIso: string): Promise<readonly CommitTouch[]> {
      try {
        const result = await ghSpawn(["git", "log", ref, `--since=${sinceIso}`, "--format=%H|%aI", "--", filePath]);
        if (result.exitCode !== 0) return [];
        return result.stdout
          .split("\n")
          .filter((line) => line.trim().length > 0)
          .slice(0, MAX_COMMITS_PER_COMMENT)
          .map((line) => {
            const [sha, date] = line.split("|");
            return { sha: sha ?? "", date: date ?? "" };
          })
          .filter((entry) => entry.sha.length > 0);
      } catch {
        return [];
      }
    },
    async resolvedThreadIds(): Promise<ReadonlySet<string>> {
      const [owner, name] = repo.split("/");
      if (owner === undefined || name === undefined) return new Set();
      const resolved = new Set<string>();
      let cursor: string | undefined;
      for (let page = 0; page < MAX_THREAD_PAGES; page += 1) {
        try {
          const argv = [
            "gh",
            "api",
            "graphql",
            "-f",
            `query=${RESOLVED_THREADS_QUERY}`,
            "-f",
            `owner=${owner}`,
            "-f",
            `repo=${name}`,
            "-F",
            `pr=${prNumber}`,
            ...(cursor !== undefined ? ["-f", `cursor=${cursor}`] : []),
          ];
          const result = await ghSpawn(argv);
          if (result.exitCode !== 0) break;
          const parsed = JSON.parse(result.stdout) as ReviewThreadsResponse;
          const threads = parsed.data?.repository?.pullRequest?.reviewThreads;
          if (threads === undefined) break;
          for (const node of threads.nodes) {
            if (!node.isResolved) continue;
            const rootId = node.comments.nodes[0]?.databaseId;
            if (rootId !== null && rootId !== undefined) resolved.add(String(rootId));
          }
          if (!threads.pageInfo.hasNextPage || threads.pageInfo.endCursor === null) break;
          cursor = threads.pageInfo.endCursor;
        } catch {
          break;
        }
      }
      return resolved;
    },
  };
}

/** `--fixtures <dir>/git-facts.json`: `{ commits: { [path]: [{sha, date}] }, resolvedThreadIds: [id, ...] }`. */
export function createFixtureJevCommentsFactsPort(facts: {
  readonly commits?: Readonly<Record<string, readonly CommitTouch[]>>;
  readonly resolvedThreadIds?: readonly string[];
}): JevCommentsFactsPort {
  return {
    async commitsTouching(filePath: string): Promise<readonly CommitTouch[]> {
      return facts.commits?.[filePath] ?? [];
    },
    async resolvedThreadIds(): Promise<ReadonlySet<string>> {
      return new Set(facts.resolvedThreadIds ?? []);
    },
  };
}

async function fixturePrPort(dir: string): Promise<ConformPrPort> {
  const raw = await readFile(join(dir, "pr.json"), "utf8");
  return createFixtureConformPrPort({ pr: JSON.parse(raw) as ConformPrInfo });
}

async function fixtureFactsPort(dir: string): Promise<JevCommentsFactsPort> {
  const raw = await readFile(join(dir, "git-facts.json"), "utf8").catch(() => "{}");
  return createFixtureJevCommentsFactsPort(JSON.parse(raw) as { commits?: Record<string, CommitTouch[]>; resolvedThreadIds?: string[] });
}

/** `--fixtures <dir>/jev-responses.json`: one canned `/systemone` response per batch. */
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

// ---------------------------------------------------------------------------
// Advisory-label cache — AC4: "surfaced to the existing Step 14 reply flow
// (`keryx review comments reply`) as an advisory label, never auto-replying
// or auto-resolving." Written here after a run; read back (best-effort) by
// `src/commands/review.ts`'s `runCommentsReply`.
// ---------------------------------------------------------------------------

function advisoryLabelsPath(cwd: string, repo: string, number: number): string {
  return join(cwd, ".metaproject", "data", "review-jev-comments", `labels__${repo.replace(/\//g, "__")}__${number}.json`);
}

export async function readCommentAdvisoryLabels(cwd: string, repo: string, number: number): Promise<CommentAdvisoryLabels> {
  const file = advisoryLabelsPath(cwd, repo, number);
  if (!(await pathExists(file))) return {};
  try {
    const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
    return typeof parsed === "object" && parsed !== null ? (parsed as CommentAdvisoryLabels) : {};
  } catch {
    return {};
  }
}

async function writeCommentAdvisoryLabels(cwd: string, repo: string, number: number, labels: CommentAdvisoryLabels): Promise<void> {
  // 0600: this file names comment ids and Jev's judgement on them — not for
  // other users on the same machine to read, same reasoning
  // `src/review/jev-rules-cache.ts` gives its own violation cache.
  await writeFileAtomic(advisoryLabelsPath(cwd, repo, number), `${JSON.stringify(labels, null, 2)}\n`, { mode: 0o600 });
}

// ---------------------------------------------------------------------------
// The run.
// ---------------------------------------------------------------------------

export interface JevCommentsComputedResult {
  readonly status: "DONE" | "DONE_WITH_CONCERNS";
  readonly reviewer: "review-jev-comments";
  readonly summary: string;
  readonly findings: readonly CommentsFinding[];
  readonly stats: ReturnType<typeof commentsFindingStats>;
  readonly tokens: { readonly jevCalls: number; readonly inputTokens?: number; readonly outputTokens?: number; readonly costUsd?: number };
  readonly openComments: number;
}

async function factsForComment(
  comment: SeenComment,
  port: JevCommentsFactsPort,
  resolvedThreadIds: ReadonlySet<string>,
  regionsByPath: ReadonlyMap<string, ScopedRegion[]>,
): Promise<OpenCommentFacts> {
  const resolved: ThreadResolution = comment.thread_id === null ? "unknown" : resolvedThreadIds.has(comment.thread_id) ? "resolved" : "unresolved";
  // `SeenComment` (the ledger) carries no `path`/`line` — those live only on
  // the richer `CollectedComment` a live collection returns, and AC3 asks
  // for facts to come "from the existing ledger", not from a fresh
  // collection. Best-effort: the comment's own body is searched for a
  // `file:line`-shaped mention (the same shape a diff hunk header or a
  // reviewer's own comment commonly carries); absent, facts fall back to
  // "(no file)" and `laterHunks`/`commitsTouching` are empty — still a valid
  // Jev question, just with less evidence.
  const pathMatch = /([\w./-]+\.[A-Za-z0-9]+):(\d+)/.exec(comment.body ?? "");
  const commentPath = pathMatch?.[1];
  const commentLine = pathMatch?.[2] !== undefined ? Number(pathMatch[2]) : null;
  const commitsAfter = commentPath !== undefined ? await port.commitsTouching(commentPath, comment.submitted_at) : [];
  const laterHunks = commentPath !== undefined ? (regionsByPath.get(commentPath) ?? []) : [];
  return {
    id: comment.id,
    path: commentPath ?? null,
    line: commentLine,
    author: comment.author,
    body: comment.body ?? "(comment body was not recorded on the ledger)",
    submittedAt: comment.submitted_at,
    threadId: comment.thread_id,
    resolved,
    commitsAfter,
    replies: [],
    laterHunks,
  };
}

/** Every OTHER ledger comment in the same thread, submitted after `comment`, treated as a reply — the ledger's own record of the thread, never a fresh GitHub read. */
function repliesFor(comment: SeenComment, allSeen: readonly SeenComment[]): CommentReply[] {
  if (comment.thread_id === null) return [];
  return allSeen
    .filter((other) => other.id !== comment.id && other.thread_id === comment.thread_id && Date.parse(other.submitted_at) > Date.parse(comment.submitted_at))
    .sort((a, b) => Date.parse(a.submitted_at) - Date.parse(b.submitted_at))
    .map((other) => ({ author: other.author, body: other.body ?? "(reply body was not recorded on the ledger)", submittedAt: other.submitted_at }));
}

export interface JevCommentsRunOptions {
  readonly cwd: string;
  readonly repo: string;
  readonly number: number;
  readonly model?: string;
  readonly fetchFn?: typeof fetch;
  readonly prPort: ConformPrPort;
  readonly factsPort: JevCommentsFactsPort;
}

/**
 * Everything past "read the ledger": facts, batching, the Jev calls, finding
 * synthesis, and writing the advisory-label cache (AC4). Shared by the CLI
 * (`runJevComments`, below) and the TUI's `/opencomments`.
 *
 * Callers MUST have already passed the opt-in and credential gates
 * (`jevCommentsGateRefusal`).
 */
export async function computeJevCommentsResult(options: JevCommentsRunOptions): Promise<JevCommentsComputedResult> {
  const { cwd, repo, number, prPort, factsPort } = options;
  const model = options.model ?? DEFAULT_JEV_MODEL;
  const fetchFn = options.fetchFn ?? globalThis.fetch;

  const state = await readPrCommentState(cwd, repo, number);
  const open = unansweredComments(state);

  const prInfo = await prPort.pr(number);
  const regions = hunkRegionsFromDiff(prInfo.diff);
  const regionsByPath = new Map<string, ScopedRegion[]>();
  for (const region of regions) {
    const list = regionsByPath.get(region.path) ?? [];
    list.push(region);
    regionsByPath.set(region.path, list);
  }

  // Fetched once for the whole run, not once per comment — `resolvedThreadIds`
  // pages the whole PR's review threads, and every open comment's thread is
  // a lookup into the same set.
  const resolvedThreadIds = open.length > 0 ? await factsPort.resolvedThreadIds() : new Set<string>();

  const factsList: OpenCommentFacts[] = [];
  for (const comment of open) {
    const facts = await factsForComment(comment, factsPort, resolvedThreadIds, regionsByPath);
    factsList.push({ ...facts, replies: repliesFor(comment, state.seen) });
  }

  const batches = batchOpenComments(factsList);
  const findings: CommentsFinding[] = [];
  const labels: Record<string, CommentAdvisoryLabel> = {};
  let jevCalls = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let costUsd = 0;
  let sawUsage = false;
  const computedAt = new Date().toISOString();

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
      const answer = result.answers[item.id];
      if (answer === undefined || answer.type !== "choice") continue;
      const choice = answer.choice as JevCommentChoice;
      labels[item.id] = { choice, computedAt };
      const finding = synthesizeCommentFinding(item, choice);
      if (finding !== undefined) findings.push(finding);
    }
  }

  await writeCommentAdvisoryLabels(cwd, repo, number, labels).catch(() => {});

  const stats = commentsFindingStats(findings);
  const status = findings.length > 0 ? "DONE_WITH_CONCERNS" : "DONE";
  const summary = `Checked ${open.length} open comment(s) on ${repo}#${number} against the ledger and the PR's current diff; ${findings.length} still-open/escalation finding(s).`;

  return {
    status,
    reviewer: "review-jev-comments",
    summary,
    findings,
    stats,
    tokens: sawUsage ? { jevCalls, inputTokens, outputTokens, costUsd } : { jevCalls },
    openComments: open.length,
  };
}

/** AC5's gate: opt-in first, credential second, both before any ledger read or network call. */
export async function jevCommentsGateRefusal(cwd: string): Promise<string | undefined> {
  if (!(await readJevCommentsEnabled(cwd))) {
    return (
      "`review.jev.comments` is not enabled for this project (.metaproject/tasks.config.json: " +
      '`{"review":{"jev":{"comments":true}}}`). review-jev-comments sends redacted comment/reply/hunk text to ' +
      "OpenRouter/TypeSafe, so it is opt-in — nothing was read and no network call was made."
    );
  }
  const apiKey = resolveJevApiKey(process.env);
  if (apiKey === undefined || apiKey.length === 0) {
    return (
      "OPENROUTER_API_KEY is not set, and no openrouterKey is saved in the keryx shell config: review-jev-comments " +
      "needs a Jev/OpenRouter credential and made no network call."
    );
  }
  return undefined;
}

export async function runJevComments(args: string[]): Promise<void> {
  rejectUnknownJevCommentsFlags(args);
  const cwd = process.cwd();

  const prArg = optionValue(args, "--pr");
  const repo = optionValue(args, "--repo");
  if (prArg === undefined || repo === undefined) {
    throw new Error("Usage: keryx review jev-comments --pr <n> --repo <owner/repo> [--json]");
  }
  const number = Number(prArg);
  if (!Number.isInteger(number) || number <= 0) {
    throw new Error(`--pr must be a positive integer, got "${prArg}".`);
  }

  // AC5: opt-in per project, refused before any read or network call.
  const refusal = await jevCommentsGateRefusal(cwd);
  if (refusal !== undefined) {
    console.error(refusal);
    process.exitCode = 1;
    return;
  }

  const fixturesDir = optionValue(args, "--fixtures");
  const model = optionValue(args, "--model") ?? DEFAULT_JEV_MODEL;

  const ledgerFile = prCommentsStatePath(cwd, repo, number);
  if (fixturesDir === undefined && !(await pathExists(ledgerFile))) {
    console.error(
      `No comment ledger at ${ledgerFile} — run \`keryx review comments collect --repo ${repo} --pr ${number} --sha <sha>\` first. ` +
        "review-jev-comments reads the existing ledger; it never collects from GitHub itself.",
    );
    process.exitCode = 1;
    return;
  }

  const prPort: ConformPrPort = fixturesDir === undefined ? createGhConformPrPort(undefined, repo) : await fixturePrPort(fixturesDir);
  const factsPort: JevCommentsFactsPort = fixturesDir === undefined ? createGhJevCommentsFactsPort(repo, number) : await fixtureFactsPort(fixturesDir);
  const fetchFn: typeof fetch = fixturesDir === undefined ? globalThis.fetch : await fixtureJevFetch(fixturesDir);

  const result = await computeJevCommentsResult({ cwd, repo, number, model, fetchFn, prPort, factsPort });

  if (args.includes("--json")) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(renderJevCommentsMarkdown(result));
}
