// Read-only, on-demand conversation and check data for a single pull request.
// Each connection owns its cursor, including replies inside a long thread.
import type { ReviewCheck, ReviewDetailSnapshot, ReviewMessage, ReviewThread, SubmittedReview } from "./board-detail-types";
import { boardGraphql } from "./board-github";

export type DetailQuery = (query: string, variables: Record<string, string | number>) => Promise<unknown>;

const IDENTITY = `query ReviewDetailIdentity($owner:String!, $repo:String!, $number:Int!) {
  viewer { login } repository(owner:$owner, name:$repo) {
    id pullRequest(number:$number) { id headRefOid commits(last:1) { nodes { commit { id oid } } } }
  }
}`;
const MESSAGE = "id body author { login } viewerDidAuthor createdAt url";
const PAGE = "pageInfo { hasNextPage endCursor }";
const connection = (type: string, field: string, fields: string) =>
  `query ReviewDetailPage($id:ID!, $cursor:String) {
    viewer { login }
    node(id:$id) { ... on ${type} { ${field}(first:50, after:$cursor) { ${PAGE} nodes { ${fields} } } } }
  }`;
const DISCUSSION = connection("PullRequest", "comments", MESSAGE);
const REVIEWS = connection("PullRequest", "reviews", MESSAGE + " state");
const THREADS = connection("PullRequest", "reviewThreads", `id path line isResolved isOutdated comments(first:10) { ${PAGE} nodes { ${MESSAGE} } }`);
const REPLIES = connection("PullRequestReviewThread", "comments", MESSAGE);
const CHECKS = `query ReviewDetailChecks($id:ID!, $cursor:String) {
  viewer { login }
  node(id:$id) { ... on Commit { statusCheckRollup { contexts(first:100, after:$cursor) {
    ${PAGE} nodes { __typename ... on CheckRun { id name status conclusion detailsUrl } ... on StatusContext { id context state targetUrl } }
  } } } }
}`;

type Fields = Record<string, unknown>;

function fields(value: unknown): Fields {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Incomplete GitHub response.");
  return value as Fields;
}

function requiredText(record: Fields, key: string): string {
  const value = record[key];
  if (typeof value !== "string") throw new Error(`Missing ${key} in GitHub response.`);
  return value;
}

function rows(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error("Incomplete list in GitHub response.");
  return value;
}

function str(record: Fields, key: string): string | null {
  return typeof record[key] === "string" ? record[key] : null;
}

function flag(record: Fields, key: string): boolean {
  const value = record[key];
  if (typeof value !== "boolean") throw new Error(`Missing ${key} in GitHub response.`);
  return value;
}

function message(record: Fields): ReviewMessage {
  return {
    id: requiredText(record, "id"), body: requiredText(record, "body"), author: str(fields(record.author ?? {}), "login") ?? "Deleted user",
    own: flag(record, "viewerDidAuthor"), createdAt: requiredText(record, "createdAt"), url: requiredText(record, "url"),
  };
}

function review(record: Fields): SubmittedReview {
  return { ...message(record), state: requiredText(record, "state") };
}

function check(record: Fields): ReviewCheck {
  const id = requiredText(record, "id");
  if (record.__typename === "CheckRun") return {
    id, name: requiredText(record, "name"), status: str(record, "conclusion") ?? requiredText(record, "status"), url: str(record, "detailsUrl"),
  };
  if (record.__typename === "StatusContext") return {
    id, name: requiredText(record, "context"), status: requiredText(record, "state"), url: str(record, "targetUrl"),
  };
  throw new Error("Unknown GitHub check type.");
}

// Both Desktop hosts cap CLI stdout at 32 MiB. Leave room for the response envelope,
// linked Flow excerpts and warnings. Charge complete UTF-8 JSON entries as they arrive.
const DETAIL_ENTRY_BYTES = 30 * 1024 * 1024;

export async function readReviewBoardDetail(
  repo: string, number: number, cwd: string,
  request: DetailQuery = (document, variables) => boardGraphql(cwd, document, variables),
): Promise<ReviewDetailSnapshot> {
  const [owner, name] = repo.split("/");
  if (!owner || !name || !Number.isSafeInteger(number) || number <= 0) throw new Error("configuration: Invalid pull request.");
  // Leave time for the last bounded gh subprocess before the Desktop host timeout.
  const deadline = Date.now() + 100_000;
  const query: DetailQuery = async (document, variables) => {
    if (Date.now() >= deadline) throw new Error("unavailable: Reading PR details timed out.");
    return request(document, variables);
  };
  const meta = fields(await query(IDENTITY, { owner, repo: name, number }));
  if (!meta.repository) throw new Error("access: Repository is unavailable.");
  const repository = fields(meta.repository);
  if (!repository.pullRequest) throw new Error("access: Pull request is unavailable.");
  const pr = fields(repository.pullRequest);
  const prId = requiredText(pr, "id");
  const viewer = requiredText(fields(meta.viewer), "login");
  const headSha = requiredText(pr, "headRefOid");
  const warnings = new Set<string>();
  let remainingBytes = DETAIL_ENTRY_BYTES;

  async function readPages<T extends { id: string }>(
    read: (cursor?: string) => Promise<unknown>, parse: (node: Fields) => T, label: string,
    firstPage?: unknown, hydrate?: (entry: T, node: Fields) => Promise<void>,
  ): Promise<T[]> {
    const entries = new Map<string, T>();
    const cursors = new Set<string>();
    let cursor: string | undefined;
    try {
      while (remainingBytes > 0) {
        const page = fields(cursor === undefined && firstPage !== undefined ? firstPage : await read(cursor));
        for (const raw of rows(page.nodes)) {
          if (remainingBytes === 0) break;
          const node = fields(raw);
          const entry = parse(node);
          const previous = entries.get(entry.id);
          const bytes = Buffer.byteLength(JSON.stringify(entry)) + 1;
          const replacedBytes = previous ? Buffer.byteLength(JSON.stringify(previous)) + 1 : 0;
          if (bytes - replacedBytes >= remainingBytes) {
            remainingBytes = 0;
            warnings.add("Showing a partial snapshot of this large PR. Choose Open pull request to see all comments and checks on GitHub.");
            break;
          }
          remainingBytes -= bytes - replacedBytes;
          entries.set(entry.id, entry);
          if (hydrate) await hydrate(entry, node);
        }
        const info = fields(page.pageInfo);
        if (!flag(info, "hasNextPage")) break;
        cursor = requiredText(info, "endCursor");
        if (!cursor || cursors.has(cursor)) throw new Error("Repeated or missing GitHub cursor.");
        cursors.add(cursor);
      }
    } catch (e) {
      // Do not return private data if the active account has lost access.
      if (e instanceof Error && /^(access|configuration):/.test(e.message)) throw e;
      warnings.add(`Could not read all ${label}.`);
    }
    return [...entries.values()];
  }

  function fromNode(id: string, document: string, fieldName: string) {
    return async (cursor?: string): Promise<unknown> => {
      const data = fields(await query(document, cursor ? { id, cursor } : { id }));
      if (str(fields(data.viewer ?? {}), "login") !== viewer || data.node === null) {
        throw new Error("access: The GitHub account or pull request changed. Refresh the board.");
      }
      return fields(data.node)[fieldName];
    };
  }

  async function readThreads(): Promise<ReviewThread[]> {
    return readPages<ReviewThread>(fromNode(prId, THREADS, "reviewThreads"), (node) => ({
      id: requiredText(node, "id"), path: requiredText(node, "path"), line: typeof node.line === "number" ? node.line : null,
      resolved: flag(node, "isResolved"), outdated: flag(node, "isOutdated"), messages: [],
    }), "review threads", undefined, async (thread, node) => {
      thread.messages = await readPages(fromNode(thread.id, REPLIES, "comments"), message, "inline replies", node.comments);
    });
  }

  async function readChecks(): Promise<ReviewCheck[]> {
    let commitId: string;
    try {
      const commitNode = rows(fields(pr.commits).nodes)[0];
      const commit = fields(fields(commitNode).commit);
      if (requiredText(commit, "oid") !== headSha) throw new Error("Head changed.");
      commitId = requiredText(commit, "id");
    } catch {
      warnings.add("The commit changed or its checks are unavailable.");
      return [];
    }
    const read = fromNode(commitId, CHECKS, "statusCheckRollup");
    return readPages(async (cursor) => {
      const rollup = await read(cursor);
      if (rollup === null) return { nodes: [], pageInfo: { hasNextPage: false } };
      return fields(rollup).contexts;
    }, check, "checks");
  }

  const [comments, reviews, threads, checks] = await Promise.all([
    readPages(fromNode(prId, DISCUSSION, "comments"), message, "discussion comments"),
    readPages(fromNode(prId, REVIEWS, "reviews"), review, "submitted reviews"), readThreads(), readChecks(),
  ]);
  return {
    version: 1, viewer, repositoryId: requiredText(repository, "id"), number, fetchedAt: new Date().toISOString(), headSha,
    comments, reviews: reviews.filter(item => item.state !== "PENDING"), threads, checks, warnings: [...warnings],
  };
}
