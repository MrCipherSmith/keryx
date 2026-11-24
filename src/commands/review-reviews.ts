// Read-only list of local Reviews for the Desktop Reviews tab: `keryx review reviews --json`.
import { parseArgs } from "node:util";
import { mapPool } from "../lib/map-pool";
import { listActiveReviewCards } from "../review/board";
import { boardGh, boardGraphql, projectGithubConnection, reviewRepositories, selectRepository } from "../review/board-github";
import type { ReviewCard } from "../review/board-types";
import { deskRunRoot, readReviewRows } from "../review/desk-run-store";
import { referenceHead, reviewClosed, summarizeReview, type ReviewCompare, type ReviewsSnapshot } from "../review/review-entity";
import { writeJson } from "./review-board";

export const REVIEWS_USAGE = "keryx review reviews --json [--repo owner/name]";
/** Head comparisons per call; the rest are reported behind with an unknown commit count. */
export const MAX_REVIEW_COMPARES = 25;
const COMPARE_PARALLEL = 4;
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
}

const identityQuery = `query ReviewIdentity($owner:String!, $name:String!) { viewer { login } repository(owner:$owner,name:$name) { id } }`;
const cannotRetainData = (error: unknown) => error instanceof Error && /^(access|configuration):/.test(error.message);

export async function readReviews({ repo, repositories, query, compare, root = deskRunRoot() }: ReviewsSource): Promise<ReviewsSnapshot> {
  const [owner, name] = repo.split("/") as [string, string];
  const identity = await query<{ viewer: { login: string } | null; repository: { id: string } | null }>(identityQuery, { owner, name });
  const viewer = identity.viewer?.login;
  const repositoryId = identity.repository?.id;
  if (!viewer || !repositoryId) throw new Error("access: GitHub repository or account is unavailable.");
  const snapshot: ReviewsSnapshot = { version: 1, repo, repositories, repositoryId, viewer, fetchedAt: new Date().toISOString(), reviews: [], warnings: [] };
  const rows = readReviewRows(repositoryId, viewer, root);
  if (!rows.length) return snapshot;

  const cards = new Map<number, ReviewCard>();
  try {
    for (const card of await listActiveReviewCards(snapshot, [...new Set(rows.map(row => row.number))], query)) cards.set(card.number, card);
  } catch (error) {
    if (cannotRetainData(error)) throw error;
    snapshot.warnings.push("Some pull requests could not be loaded. Refresh to retry.");
  }
  const behind = rows.flatMap(row => {
    const card = cards.get(row.number) ?? null;
    const reviewed = referenceHead(row);
    return card && reviewed && reviewed !== card.headSha && !reviewClosed(row, card) && OBJECT_ID.test(reviewed) && OBJECT_ID.test(card.headSha)
      ? [{ id: row.id, reviewed, head: card.headSha }] : [];
  });
  if (behind.length > MAX_REVIEW_COMPARES) snapshot.warnings.push(`Commit counts are shown for ${MAX_REVIEW_COMPARES} Reviews behind their pull request. Refresh to read more.`);
  let failed = false;
  const compared = await mapPool(behind.slice(0, MAX_REVIEW_COMPARES), COMPARE_PARALLEL, async ({ id, reviewed, head }) => {
    try { return [id, await compare(reviewed, head)] as const; }
    catch {
      // Freshness stays "behind" with an unknown count; the warning tells the viewer to refresh.
      failed = true;
      return [id, null] as const;
    }
  });
  if (failed) snapshot.warnings.push("Some commit counts could not be read. Refresh to retry.");
  const comparisons = new Map(compared);
  snapshot.reviews = rows
    .map(row => summarizeReview(row, cards.get(row.number) ?? null, comparisons.get(row.id)))
    .sort((a, b) => latestCreated(b).localeCompare(latestCreated(a)) || b.number - a.number);
  return snapshot;
}

const latestCreated = (review: ReviewsSnapshot["reviews"][number]) =>
  review.rounds.flatMap(round => round.attempts.map(a => a.createdAt)).reduce((max, at) => at > max ? at : max, "");

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
  const { values } = parseArgs({ args, strict: true, allowPositionals: false, options: { json: { type: "boolean" }, repo: { type: "string" } } });
  if (!values.json) throw new Error(REVIEWS_USAGE);
  const repositories = await reviewRepositories(cwd);
  const repo = selectRepository(repositories, values.repo);
  const auth = await projectGithubConnection(cwd);
  const result = await readReviews({
    repo, repositories,
    query: (text, params) => boardGraphql(cwd, text, params, auth),
    // Only the status and count leave gh; the commit and file lists of the comparison are dropped.
    compare: async (base, head) => parseCompare(await boardGh(cwd,
      ["api", "--hostname", "github.com", `repos/${repo}/compare/${base}...${head}?per_page=1`, "--jq", "{status, ahead_by}"], auth)),
  });
  await writeJson(result, auth);
}
