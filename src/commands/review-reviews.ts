// Read-only list of local Reviews for the Desktop Reviews tab: `keryx review reviews --json`.
import { parseArgs } from "node:util";
import { mapPool } from "../lib/map-pool";
import { listActiveReviewCards } from "../review/board";
import { boardGh, boardGraphql, projectGithubConnection, reviewRepositories, selectRepository, writeBoundJson } from "../review/board-github";
import type { ReviewCard } from "../review/board-types";
import { deskRunRoot, readReviewRows } from "../review/desk-run-store";
import { headComparison, summarizeReview, type ReviewCompare, type ReviewRow, type ReviewsSnapshot } from "../review/review-entity";
import { listReviewStates, type ReviewRecord } from "../review/review-state";
import { mergeReviewStateRows, recordMatches } from "../review/review-state-rows";

export const REVIEWS_USAGE = "keryx review reviews --json [--repo owner/name] [--include-closed]";
/** Head comparisons per call, for the Reviews listed first; the rest are reported behind with an unknown commit count. */
export const MAX_REVIEW_COMPARES = 25;
/** The whole comparison phase gets this long; a comparison still unanswered then is reported with an unknown count. */
export const REVIEW_COMPARE_BUDGET_MS = 60_000;
const COMPARE_PARALLEL = 4;
const CARD_BATCH = 20;
const CARD_PARALLEL = 3;
// Both heads go into a GitHub API path: only full object IDs are compared.
const OBJECT_ID = /^[0-9a-f]{40}$/;

type Query = <T>(query: string, variables: Record<string, string | number>) => Promise<T>;
/** Compare the reviewed head (base) with the PR head. */
export type CompareHeads = (base: string, head: string) => Promise<ReviewCompare>;
export interface ReviewsSource {
  repo: string;
  repositories: string[];
  query: Query;
  compare: CompareHeads;
  /** The attempt store directory; defaults to the Desktop review store. */
  root?: string;
  /** Deadline for the comparison phase; defaults to `REVIEW_COMPARE_BUDGET_MS`. */
  compareBudgetMs?: number;
  /** Also read the PR cards of Reviews closed locally (Desktop asks while "Show closed" is on). */
  includeClosed?: boolean;
  /** The project whose review.json records (live-session reviews) join the stored attempts; none when omitted. */
  projectRoot?: string;
}

const identityQuery = `query ReviewIdentity($owner:String!, $name:String!) { viewer { login } repository(owner:$owner,name:$name) { id } }`;
const cannotRetainData = (error: unknown) => error instanceof Error && /^(access|configuration):/.test(error.message);
const latestActivity = (row: ReviewRow) => row.attempts.reduce((max, a) => a.createdAt > max ? a.createdAt : max, "");

export async function readReviews({ repo, repositories, query, compare, root = deskRunRoot(), compareBudgetMs = REVIEW_COMPARE_BUDGET_MS, includeClosed = false, projectRoot }: ReviewsSource): Promise<ReviewsSnapshot> {
  const [owner, name] = repo.split("/") as [string, string];
  const identity = await query<{ viewer: { login: string } | null; repository: { id: string } | null }>(identityQuery, { owner, name });
  const viewer = identity.viewer?.login;
  const repositoryId = identity.repository?.id;
  if (!viewer || !repositoryId) throw new Error("access: GitHub repository or account is unavailable.");
  const snapshot: ReviewsSnapshot = { version: 1, repo, repositories, repositoryId, viewer, fetchedAt: new Date().toISOString(), reviews: [], warnings: [] };
  // Newest activity first: the list order, and the order the comparison cap follows.
  const records = projectRoot ? await sessionReviewRecords(projectRoot, repo, repositoryId, viewer, snapshot.warnings) : [];
  const rows = mergeReviewStateRows(readReviewRows(repositoryId, viewer, root), records, repositoryId, viewer)
    .map(row => ({ row, at: latestActivity(row) }))
    .sort((a, b) => b.at.localeCompare(a.at) || b.row.number - a.row.number)
    .map(({ row }) => row);
  if (!rows.length) return snapshot;

  const cards = await readCards(snapshot, includeClosed ? rows : rows.filter(row => row.closedAt === null), query);
  const behind = rows.flatMap(row => {
    const pair = headComparison(row, cards.get(row.number) ?? null);
    return pair && OBJECT_ID.test(pair.reviewed) && OBJECT_ID.test(pair.head) ? [{ id: row.id, ...pair }] : [];
  });
  if (behind.length > MAX_REVIEW_COMPARES) snapshot.warnings.push(`Commit counts are shown for ${MAX_REVIEW_COMPARES} Reviews behind their pull request. Refresh to read more.`);
  const comparisons = await compareHeads(behind.slice(0, MAX_REVIEW_COMPARES), compare, compareBudgetMs, snapshot.warnings);
  snapshot.reviews = rows.map(row => summarizeReview(row, cards.get(row.number) ?? null, comparisons.get(row.id)));
  return snapshot;
}

/** The project's review.json records for this repository and viewer. An unreadable store or record adds one warning
 * and is left out; the stored attempts are still listed. */
async function sessionReviewRecords(projectRoot: string, repo: string, repositoryId: string, viewer: string, warnings: string[]): Promise<ReviewRecord[]> {
  try {
    const listing = await listReviewStates(projectRoot);
    if (listing.unreadable.length) warnings.push(`${listing.unreadable.length} session review record(s) could not be read.`);
    return listing.reviews.filter(record => recordMatches(record, repo, repositoryId, viewer));
  } catch {
    warnings.push("Session reviews could not be read.");
    return [];
  }
}

/** PR cards of the given Reviews, in batches read a few at a time. A batch that fails leaves its
 * Reviews without a card and adds one warning; the cards of the other batches are kept. */
async function readCards(snapshot: ReviewsSnapshot, rows: ReviewRow[], query: Query): Promise<Map<number, ReviewCard>> {
  const numbers = [...new Set(rows.map(row => row.number))];
  const batches = Array.from({ length: Math.ceil(numbers.length / CARD_BATCH) }, (_, i) => numbers.slice(i * CARD_BATCH, (i + 1) * CARD_BATCH));
  let unreadable = false;
  const read = await mapPool(batches, CARD_PARALLEL, async batch => {
    try { return await listActiveReviewCards(snapshot, batch, query); }
    catch (error) {
      if (cannotRetainData(error)) throw error;
      unreadable = true;
      return [];
    }
  }, { stopOnError: true });
  if (unreadable) snapshot.warnings.push("Some pull requests could not be loaded. Refresh to retry.");
  return new Map(read.flat().map(card => [card.number, card]));
}

type Pair = { id: string; reviewed: string; head: string };
/** Compare each pair within one overall deadline. A failed or unfinished comparison leaves its count unknown. */
async function compareHeads(pairs: Pair[], compare: CompareHeads, budgetMs: number, warnings: string[]): Promise<Map<string, ReviewCompare>> {
  const deadline = Date.now() + budgetMs;
  let failed = false;
  let late = false;
  const compared = await mapPool(pairs, COMPARE_PARALLEL, async ({ id, reviewed, head }) => {
    const left = deadline - Date.now();
    if (left <= 0) { late = true; return null; }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<"late">(resolve => { timer = setTimeout(() => resolve("late"), left); });
    try {
      const result = await Promise.race([compare(reviewed, head), expired]);
      if (result === "late") { late = true; return null; }
      return [id, result] as const;
    } catch {
      // Freshness stays "behind" with an unknown count; the warning tells the viewer to refresh.
      failed = true;
      return null;
    } finally { clearTimeout(timer); }
  });
  if (failed) warnings.push("Some commit counts could not be read. Refresh to retry.");
  if (late) warnings.push("Some commit counts took too long to read. Refresh to retry.");
  return new Map(compared.flatMap(entry => entry ? [entry] : []));
}

const compareStates = new Set(["ahead", "behind", "diverged", "identical"]);
export function parseCompare(raw: string): ReviewCompare {
  const value = JSON.parse(raw) as { status?: unknown; ahead_by?: unknown };
  if (typeof value?.status !== "string" || !compareStates.has(value.status) || !Number.isSafeInteger(value.ahead_by) || (value.ahead_by as number) < 0) {
    throw new Error("unavailable: GitHub returned an unreadable comparison.");
  }
  return { status: value.status as ReviewCompare["status"], aheadBy: value.ahead_by as number };
}

export async function runReviewReviews(args: string[], cwd = process.cwd()): Promise<void> {
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
    console.log(REVIEWS_USAGE);
    return;
  }
  const { values } = parseArgs({ args, strict: true, allowPositionals: false, options: { json: { type: "boolean" }, repo: { type: "string" }, "include-closed": { type: "boolean" } } });
  if (!values.json) throw new Error(REVIEWS_USAGE);
  const repositories = await reviewRepositories(cwd);
  const repo = selectRepository(repositories, values.repo);
  const auth = await projectGithubConnection(cwd);
  const result = await readReviews({
    repo, repositories, includeClosed: values["include-closed"] === true, projectRoot: cwd,
    query: (text, params) => boardGraphql(cwd, text, params, auth),
    // Only the status and count leave gh; the commit and file lists of the comparison are dropped.
    compare: async (base, head) => parseCompare(await boardGh(cwd,
      ["api", "--hostname", "github.com", `repos/${repo}/compare/${base}...${head}?per_page=1`, "--jq", "{status, ahead_by}"], auth)),
  });
  await writeBoundJson(result, auth);
}
