import {
  isIssueRef,
  issueKey,
  type IssueComment,
  type IssueDetail,
  type IssuePage,
  type IssueRef,
  type IssueScope,
  type IssueSummary,
} from "./issues-contract";
import {
  API,
  connectIssueAccount,
  cursorScope,
  denied,
  invalidInput,
  readCursor,
  scopedCursor,
  type IssueAccount,
} from "./issues-github";

export interface ListIssueRequest {
  source: IssueScope;
  state?: "open" | "closed" | "all";
  sort?: "asc" | "desc";
  updatedSince?: string;
  labels?: string[];
  cursor?: string | null;
}

interface Repository {
  id: string;
  name: string;
  owner: { login: string };
}
interface Actor {
  login: string;
}
export interface GithubIssue {
  __typename: string;
  id: string;
  repository: Repository;
  number: number;
  url: string;
  title: string;
  state: "OPEN" | "CLOSED";
  createdAt: string;
  updatedAt: string;
  author: Actor | null;
  assignees: { nodes: Actor[] };
  labels: { nodes: { name: string }[] };
}
export const issueFields = `__typename id repository { id name owner { login } } number url title state createdAt updatedAt
  author { login } assignees(first:100) { nodes { login } } labels(first:100) { nodes { name } }`;

export function graphSummary(issue: GithubIssue): IssueSummary {
  const ref = {
    host: "github.com",
    nodeId: issue.id,
    repositoryId: issue.repository.id,
    owner: issue.repository.owner.login,
    repo: issue.repository.name,
    number: issue.number,
    url: issue.url,
  };
  if (!isIssueRef(ref)) throw new Error("unavailable: GitHub returned an invalid issue reference.");
  return {
    ref,
    title: issue.title,
    state: issue.state === "OPEN" ? "open" : "closed",
    author: issue.author?.login ?? "",
    assignees: issue.assignees.nodes.map((row) => row.login),
    labels: issue.labels.nodes.map((row) => row.name),
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
  };
}

interface RestIssue {
  node_id: string;
  html_url: string;
  number: number;
  title: string;
  state: "open" | "closed";
  user: Actor | null;
  created_at: string;
  updated_at: string;
  assignees: Actor[];
  labels: (string | { name: string })[];
  repository?: { node_id: string; owner: Actor; name: string };
  pull_request?: unknown;
}

function listUrl(request: ListIssueRequest) {
  const { source, state = "open", sort = "desc", labels = [], updatedSince } = request;
  if (
    !["assigned", "created", "mentioned", "subscribed"].includes(source) ||
    !["open", "closed", "all"].includes(state) ||
    !["asc", "desc"].includes(sort) ||
    !Array.isArray(labels) ||
    labels.some((l) => typeof l !== "string" || l.length > 100) ||
    (updatedSince !== undefined &&
      (typeof updatedSince !== "string" || !Number.isFinite(Date.parse(updatedSince))))
  )
    throw new Error(invalidInput);
  const url = new URL("/issues", API);
  url.search = new URLSearchParams({
    filter: source,
    state,
    direction: sort,
    sort: "updated",
    per_page: "40",
    pulls: "false",
  }).toString();
  if (updatedSince) url.searchParams.set("since", new Date(updatedSince).toISOString());
  if (labels.length === 1 && !labels[0]!.includes(",")) url.searchParams.set("labels", labels[0]!);
  return url;
}

function pageLink(link: string, base: URL): string | null {
  const next = /<([^>]+)>;\s*rel="next"/.exec(link)?.[1];
  if (!next) return null;
  const url = new URL(next, base);
  if (url.origin !== API || url.pathname !== base.pathname || url.username || url.password)
    throw new Error(invalidInput);
  const params = new URLSearchParams();
  for (const key of ["page", "after", "before", "since_id"])
    if (url.searchParams.has(key)) params.set(key, url.searchParams.get(key)!);
  if (!params.size) throw new Error("unavailable: Invalid GitHub pagination link. Refresh and retry.");
  return params.toString();
}

export async function listIssuePage(
  { viewer, api }: IssueAccount,
  request: ListIssueRequest,
): Promise<IssuePage<IssueSummary>> {
  const base = listUrl(request);
  const scope = cursorScope(viewer, "issues", base.search, [...(request.labels ?? [])].sort());
  const next = readCursor(scope, request.cursor);
  if (next)
    for (const [key, value] of new URLSearchParams(next)) {
      if (!["page", "after", "before", "since_id"].includes(key)) throw new Error(invalidInput);
      base.searchParams.set(key, value);
    }
  const { data, link } = await api.rest<RestIssue[]>(base);
  if (!Array.isArray(data)) throw new Error("unavailable: Invalid GitHub issue page.");
  const issues = data.filter((x) => !x.pull_request);
  // REST may omit the embedded repository. Hydrate missing identities in one bounded batch.
  const missing = issues.filter((x) => !x.repository?.node_id);
  const repositories = new Map<string, Repository>();
  if (missing.length) {
    const result = await api.graphql<{ nodes: ({ id: string; repository?: Repository } | null)[] }>(
      "query($ids:[ID!]!) { nodes(ids:$ids) { id ... on Issue { repository { id name owner { login } } } } }",
      { ids: missing.map((i) => i.node_id) },
    );
    for (const row of result.nodes) if (row?.repository) repositories.set(row.id, row.repository);
  }
  const result = new Map<string, IssueSummary>();
  let incomplete = false;
  for (const i of issues) {
    const r = i.repository?.node_id
      ? { id: i.repository.node_id, name: i.repository.name, owner: i.repository.owner }
      : repositories.get(i.node_id);
    if (!r) {
      incomplete = true;
      continue;
    }
    const labels = i.labels.map((l) => (typeof l === "string" ? l : l.name));
    if (
      request.labels?.length &&
      !request.labels.some((l) => labels.some((v) => v.toLowerCase() === l.toLowerCase()))
    )
      continue;
    const ref = {
      host: viewer.host,
      nodeId: i.node_id,
      repositoryId: r.id,
      owner: r.owner.login,
      repo: r.name,
      number: i.number,
      url: i.html_url,
    };
    if (!isIssueRef(ref)) {
      incomplete = true;
      continue;
    }
    result.set(issueKey(ref), {
      ref,
      title: i.title,
      state: i.state,
      author: i.user?.login ?? "",
      assignees: i.assignees.map((a) => a.login),
      labels,
      createdAt: i.created_at,
      updatedAt: i.updated_at,
    });
  }
  return {
    viewer,
    items: [...result.values()],
    nextCursor: scopedCursor(scope, pageLink(link, base)),
    incomplete,
  };
}

interface ReadIssue extends GithubIssue {
  body: string;
  stateReason: string | null;
}
function assertRef(ref: IssueRef) {
  if (!isIssueRef(ref) || ref.host !== "github.com") throw new Error(invalidInput);
}
function validateNode(
  ref: IssueRef,
  node: { __typename: string; id: string; number: number; repository: { id: string } } | null,
) {
  if (
    node?.__typename !== "Issue" ||
    node.id !== ref.nodeId ||
    node.number !== ref.number ||
    node.repository.id !== ref.repositoryId
  )
    throw new Error(denied);
}

export async function issueDetail(
  { api, viewer }: IssueAccount,
  ref: IssueRef,
): Promise<{ viewer: typeof viewer; issue: IssueDetail }> {
  assertRef(ref);
  const { node } = await api.graphql<{ node: ReadIssue | null }>(
    `query($id:ID!) { node(id:$id) { __typename ... on Issue { ${issueFields} body stateReason } } }`,
    { id: ref.nodeId },
  );
  validateNode(ref, node);
  const issue = node!;
  return {
    viewer,
    issue: {
      ...graphSummary(issue),
      body: issue.body,
      ...(issue.stateReason ? { stateReason: issue.stateReason } : {}),
    },
  };
}
export async function readGithubIssue(cwd: string, login: string, ref: IssueRef) {
  return issueDetail(await connectIssueAccount(cwd, login), ref);
}
interface GraphPage {
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
}
export async function issueComments(
  { api, viewer }: IssueAccount,
  ref: IssueRef,
  cursor?: string | null,
): Promise<IssuePage<IssueComment>> {
  assertRef(ref);
  const scope = cursorScope(viewer, "comments", ref.nodeId);
  type Comment = Omit<IssueComment, "author"> & { author: Actor | null };
  const { node } = await api.graphql<{
    node: (ReadIssue & { comments: GraphPage & { nodes: Comment[] } }) | null;
  }>(
    `query($id:ID!,$after:String) { node(id:$id) { __typename ... on Issue { id number repository { id }
      comments(first:40,after:$after) { nodes {id author {login} body createdAt url} pageInfo {hasNextPage endCursor} } } } }`,
    { id: ref.nodeId, after: readCursor(scope, cursor) },
  );
  validateNode(ref, node);
  const { nodes, pageInfo } = node!.comments;
  return {
    viewer,
    items: nodes.map((c) => ({ ...c, author: c.author?.login ?? "" })),
    nextCursor: scopedCursor(scope, pageInfo.hasNextPage ? pageInfo.endCursor : null),
    incomplete: false,
  };
}
