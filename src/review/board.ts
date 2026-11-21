import { mapPool } from "../lib/map-pool";
import { OVERFLOW_PARENTS } from "./board-github";
import type { ReviewBoardSnapshot, ReviewBoardState, ReviewCard, ReviewCi } from "./board-types";

import type { DeskRevision, DeskRunKey, DeskSchedule } from "./desk-run-types";

type Query = <T>(query: string, variables: Record<string, string | number>) => Promise<T>;
type PageInfo = { hasNextPage: boolean; endCursor: string | null };
type Connection<T> = { nodes: (T | null)[]; pageInfo: PageInfo };

const person = "login";
const reviewer = "requestedReviewer { __typename ... on User { login } ... on Bot { login } ... on Mannequin { login } ... on EnterpriseTeam { combinedSlug } ... on Team { slug organization { login } } }";
const pageFields = "pageInfo { hasNextPage endCursor }";
const connection = (key: string, fields: string, next = false) =>
  `${key}(first: 20${next ? ", after: $cursor" : ""}) { ${pageFields} nodes { ${fields} } }`;

interface Person { login: string }
interface Reviewer { id?: string; requestedReviewer: ({ __typename: string; login?: string; combinedSlug?: string; slug?: string; organization?: Person } | null) }
interface RawCard {
  number: number; title: string; state: "OPEN" | "CLOSED" | "MERGED"; isDraft: boolean;
  author: Person | null; updatedAt: string; headRefOid: string; baseRefOid: string;
  reviewDecision: ReviewCard["decision"];
  changedFiles?: number; additions?: number; deletions?: number;
  assignees: Connection<Person>; reviewRequests: Connection<Reviewer>;
  commits: { nodes: { commit: { oid: string; statusCheckRollup: { state: string; contexts: { totalCount: number } } | null } }[] };
}
interface BoardPage {
  viewer: Person;
  repository: { id: string; nameWithOwner: string; pullRequests: Connection<RawCard> } | null;
}

const states = { open: "[OPEN]", closed: "[CLOSED]", merged: "[MERGED]", all: "[OPEN, CLOSED, MERGED]" } as const;
const listQuery = (state: ReviewBoardState, reviewerFields: string, first: number) => `query($owner: String!, $name: String!, $cursor: String) {
  viewer { login }
  repository(owner:$owner, name:$name) {
    id nameWithOwner
    pullRequests(first:${first}, after:$cursor, states:${states[state]}, orderBy:{field:CREATED_AT, direction:DESC}) {
      ${pageFields}
      nodes {
        number title state isDraft author { login } headRefOid baseRefOid updatedAt reviewDecision changedFiles additions deletions
        ${connection("assignees", person)}
        ${connection("reviewRequests", reviewerFields)}
        commits(last:1) { nodes { commit { oid statusCheckRollup { state contexts(first:1) { totalCount } } } } }
      }
    }
  }
}`;

function changeStats({ changedFiles, additions, deletions }: RawCard): ReviewCard["changeStats"] {
  const count = (value: number | undefined): value is number => value !== undefined && Number.isSafeInteger(value) && value >= 0;
  return count(changedFiles) && count(additions) && count(deletions)
    ? { files: changedFiles, additions, deletions }
    : undefined;
}

function checkState(pr: RawCard): ReviewCi {
  const commit = pr.commits?.nodes?.[0]?.commit;
  if (!commit || commit.oid !== pr.headRefOid) return "unknown";
  const rollup = commit.statusCheckRollup;
  if (rollup === null || rollup?.contexts?.totalCount === 0) return "none";
  if (!Number.isSafeInteger(rollup?.contexts?.totalCount) || rollup.contexts.totalCount < 0) return "unknown";
  switch (rollup.state) {
    case "ERROR": case "FAILURE": return "failed";
    case "PENDING": case "EXPECTED": return "pending";
    case "SUCCESS": return "passed";
    default: return "unknown";
  }
}

function reviewerLabel({ requestedReviewer: r }: Reviewer): string | undefined {
  if (r?.__typename === "EnterpriseTeam") return r.combinedSlug;
  return r?.__typename === "Team" && r.organization?.login && r.slug ? `${r.organization.login}/${r.slug}` : r?.login;
}

const cannotRetainData = (error: unknown) => error instanceof Error && /^(access|configuration):/.test(error.message);

interface People { names: string[]; complete: boolean }
async function readPeople<T>(key: "assignees" | "reviewRequests", fields: string, first: Connection<T>, label: (person: T) => string | undefined,
  query: Query, params: Record<string, string | number>, viewer: string, repositoryId: string): Promise<People> {
  const names = new Set<string>();
  const cursors = new Set<string>();
  const nextQuery = `query($owner:String!,$name:String!,$number:Int!,$cursor:String!) {
    viewer { login } repository(owner:$owner,name:$name) { id pullRequest(number:$number) { ${connection(key, fields, true)} } }
  }`;
  let page = first;
  let complete = true;
  for (;;) {
    if (typeof page?.pageInfo?.hasNextPage !== "boolean" || !Array.isArray(page.nodes)) return { names: [...names], complete: false };
    for (const node of page.nodes) {
      const value = node && label(node);
      if (value) names.add(value);
      else complete = false;
    }
    if (!page.pageInfo.hasNextPage) return { names: [...names], complete };
    const cursor = page.pageInfo.endCursor;
    if (!cursor || cursors.has(cursor)) return { names: [...names], complete: false };
    cursors.add(cursor);
    try {
      const more = await query<{ viewer: Person; repository: { id: string; pullRequest: Record<typeof key, Connection<T>> } | null }>(nextQuery, { ...params, cursor });
      if (more.viewer?.login !== viewer || more.repository?.id !== repositoryId || !more.repository.pullRequest) {
        throw new Error("access: GitHub account or repository changed. Refresh the board.");
      }
      page = more.repository.pullRequest[key];
    } catch (error) {
      if (cannotRetainData(error)) throw error;
      return { names: [...names], complete: false };
    }
  }
}

export async function listReviewCards(repo: string, repositories: string[], state: ReviewBoardState, read: Query, trackRequestIds = false, page?: {cursor: string | null; size?: number}): Promise<ReviewBoardSnapshot> {
  const reviewerFields = trackRequestIds ? `id ${reviewer}` : reviewer;
  const [owner, name] = repo.split("/") as [string, string];
  const params = { owner, name };
  const deadline = Date.now() + 100_000;
  const query: Query = (text, vars) => {
    if (Date.now() >= deadline) throw new Error("unavailable: Review update timed out.");
    return read(text, vars);
  };
  const cards = new Map<number, ReviewCard>();
  const cursors = new Set<string>();
  const warnings = new Set<string>();
  let repositoryId = "", viewer = "", cursor: string | null = page?.cursor ?? null;
  let nextCursor: string | null = null;
  for (;;) {
    try {
      const result: BoardPage = await query<BoardPage>(listQuery(state, reviewerFields, page?.size ?? 100), cursor ? { ...params, cursor } : params);
      if (!result.repository?.id || !result.viewer?.login) throw new Error("access: GitHub repository or account is unavailable.");
      if (repositoryId && (repositoryId !== result.repository.id || viewer !== result.viewer.login)) {
        throw new Error("access: GitHub account or repository changed. Refresh the board.");
      }
      const prs: Connection<RawCard> = result.repository.pullRequests;
      if (!Array.isArray(prs?.nodes) || typeof prs.pageInfo?.hasNextPage !== "boolean") throw new Error("unavailable: GitHub returned an incomplete PR page.");
      repositoryId = result.repository.id;
      viewer = result.viewer.login;
      const canonical = result.repository.nameWithOwner;
      const pageCards = await mapPool(prs.nodes, OVERFLOW_PARENTS, async (pr): Promise<ReviewCard | null> => {
        if (!pr || !Number.isSafeInteger(pr.number) || !pr.title || !["OPEN", "MERGED", "CLOSED"].includes(pr.state)) {
          warnings.add("Some pull requests could not be read.");
          return null;
        }
        const subject = { ...params, number: pr.number };
        const requestIds = new Map<string, string>();
        const requestLabel = (request: Reviewer) => {
          const label = reviewerLabel(request);
          if (trackRequestIds && label && request.id) requestIds.set(label.toLowerCase(), request.id);
          return label;
        };
        const [assignees, reviewers] = await Promise.all([
          readPeople("assignees", person, pr.assignees, (p) => p.login, query, subject, viewer, repositoryId),
          readPeople("reviewRequests", reviewerFields, pr.reviewRequests, requestLabel, query, subject, viewer, repositoryId),
        ]);
        if (!assignees.complete || !reviewers.complete) warnings.add("Some assignees or requested reviewers could not be read.");
        const stats = changeStats(pr);
        return {
          ...(stats && { changeStats: stats }),
          number: pr.number, title: pr.title, url: `https://github.com/${canonical}/pull/${pr.number}`,
          state: pr.state.toLowerCase() as ReviewCard["state"], draft: pr.isDraft, author: pr.author?.login ?? "",
          assignees: assignees.names, reviewers: reviewers.names, assigneesComplete: assignees.complete, reviewersComplete: reviewers.complete,
          ...(trackRequestIds ? { reviewRequestIds: Object.fromEntries(requestIds) } : {}),
          decision: pr.reviewDecision, ci: checkState(pr), headSha: pr.headRefOid, baseSha: pr.baseRefOid, updatedAt: pr.updatedAt,
        };
      }, { stopOnError: true });
      for (const card of pageCards) if (card) cards.set(card.number, card);
      if (!prs.pageInfo.hasNextPage) break;
      cursor = prs.pageInfo.endCursor;
      if (!cursor || cursors.has(cursor)) throw new Error("unavailable: GitHub pagination stopped before the last page.");
      cursors.add(cursor);
      if (page) { nextCursor = cursor; break; }
    } catch (error) {
      if (!repositoryId || cannotRetainData(error)) throw error;
      warnings.add("Only part of the repository could be loaded. Refresh to retry.");
      break;
    }
  }
  return { version: 1, repo, repositories, repositoryId, viewer, fetchedAt: new Date().toISOString(), ...(page ? { nextCursor } : {}), cards: [...cards.values()], warnings: [...warnings] };
}

/** Read one current PR at the spending boundary, including overflow pages of constrained people.
 * This intentionally does not authorize a run from the last board or watcher snapshot. */
export async function verifyScheduledSubject(
  key: DeskRunKey,
  revision: DeskRevision,
  rule: Pick<DeskSchedule, "author" | "assignee" | "recipient" | "requireGreen">,
  read: Query,
): Promise<void> {
  const [owner, name] = key.repo.split("/") as [string, string];
  const params = {owner, name, number: key.number};
  const deadline = Date.now() + 90_000;
  const query: Query = (q, vars) => {
    if (Date.now() >= deadline) throw new Error("unavailable: Scheduled review preflight timed out.");
    return read(q, vars);
  };
  const data = await query<{viewer: Person; repository: {id: string; pullRequest: RawCard | null} | null}>(`
    query ReviewScheduledSubject($owner:String!, $name:String!, $number:Int!) {
      viewer { login } repository(owner:$owner, name:$name) { id pullRequest(number:$number) {
        state headRefOid baseRefOid author { login }
        ${connection("assignees", person)} ${connection("reviewRequests", reviewer)}
        commits(last:1) { nodes { commit { oid statusCheckRollup { state contexts(first:1) { totalCount } } } } }
      } }
    }`, params);
  const pr = data.repository?.pullRequest;
  if (data.repository?.id !== key.repositoryId || data.viewer?.login?.toLowerCase() !== key.viewer.toLowerCase() || !pr) {
    throw new Error("access: Could not confirm GitHub account, repository and pull request for scheduled review.");
  }
  if (pr.state !== "OPEN" || pr.baseRefOid !== revision.baseSha || pr.headRefOid !== revision.headSha) {
    throw new Error("stale: The pull request closed or its base or head changed.");
  }
  if (rule.author && pr.author?.login?.toLowerCase() !== rule.author.toLowerCase()) {
    throw new Error("stale: The PR author no longer matches the rule.");
  }
  if (rule.requireGreen && checkState(pr) !== "passed") {
    throw new Error("stale: Waiting for passing CI on the selected revision.");
  }
  const checkPeople = async (field: "assignees" | "reviewRequests", wanted: string) => {
    const people = field === "assignees"
      ? await readPeople(field, person, pr.assignees, (p) => p.login, query, params, data.viewer.login, key.repositoryId)
      : await readPeople(field, reviewer, pr.reviewRequests, reviewerLabel, query, params, data.viewer.login, key.repositoryId);
    if (!people.complete) throw new Error("unavailable: Could not confirm all PR assignments and review requests.");
    if (!people.names.some(n => n.toLowerCase() === wanted.toLowerCase())) {
      throw new Error(field === "assignees" ? "stale: The assignee no longer matches the rule." : "stale: The review request is no longer pending.");
    }
  };
  await Promise.all([
    rule.assignee && checkPeople("assignees", rule.assignee),
    rule.recipient && checkPeople("reviewRequests", rule.recipient),
  ]);
}
